import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCloudItem, readYouTubeThumbnail } from "../seed-cloud-queue.mjs";

const fingerprint = "d".repeat(64);
const contentId = "e".repeat(64);

test("Seeder stages the QA-bound YouTube thumbnail as a separate private R2 asset", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-thumbnail-"));
  const originalFetch = globalThis.fetch;
  try {
    const thumbnailFile = path.join(temporary, "thumbnail.jpg");
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33]);
    await fs.writeFile(thumbnailFile, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method, headers: options.headers });
      if (options.method === "HEAD") return new Response(null, { status: 404 });
      if (options.method === "PUT") {
        const uploaded = [];
        for await (const chunk of options.body) uploaded.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(uploaded), bytes);
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const validatedPackage = {
      platforms: ["youtube"],
      youtubeThumbnail: {
        path: thumbnailFile,
        bytes: bytes.byteLength,
        sha256,
        extension: ".jpg",
        contentType: "image/jpeg"
      }
    };
    const staged = await readYouTubeThumbnail(temporary, validatedPackage, {
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      endpoint: new URL("https://r2.example.com"),
      bucket: "bucket"
    });
    assert.equal(staged.objectKey, `assets/${sha256.slice(0, 2)}/${sha256}.jpg`);
    assert.equal(staged.path, "thumbnail.jpg");
    assert.equal(staged.role, "youtube-thumbnail");
    assert.equal(staged.sha256, sha256);
    assert.equal("url" in staged, false);
    assert.equal(requests.filter((request) => request.method === "HEAD").length, 1);
    assert.equal(requests.filter((request) => request.method === "PUT").length, 1);
    assert.ok(requests.every((request) => request.url.includes(staged.objectKey.replaceAll("/", "%2F")) || request.url.includes(`/bucket/assets/`)));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Cloud item binds thumbnail, options, channel snapshot and identity-v2 together", () => {
  const sha256 = "f".repeat(64);
  const thumbnail = {
    objectKey: `assets/ff/${sha256}.png`,
    path: "thumbnail.png",
    bytes: 1234,
    sha256,
    extension: ".png",
    contentType: "image/png",
    role: "youtube-thumbnail"
  };
  const local = {
    identityVersion: 2,
    fingerprint,
    contentId,
    brand: "aeris",
    accountId: "aeris",
    kind: "video",
    platforms: ["youtube"],
    targets: [{ platform: "youtube", accountId: "aeris", actionAt: "2026-09-01T08:00:00.000Z" }],
    targetStates: {},
    scheduledAt: "2026-09-01T08:00:00.000Z"
  };
  const validatedPackage = {
    identityVersion: 2,
    fingerprint,
    contentId,
    brand: "aeris",
    kind: "video",
    platforms: ["youtube"],
    caption: "Video",
    targetSnapshot: { youtube: { channelId: "UC_BOUND" } },
    options: {
      youtube: {
        title: "Video",
        privacyStatus: "private",
        thumbnail: { sha256, bytes: 1234, extension: ".png", contentType: "image/png" }
      }
    }
  };
  const uploadConfig = { accounts: { aeris: { youtube: { channelId: "UC_BOUND" } } } };
  const item = buildCloudItem({
    local,
    validatedPackage,
    media: [{ objectKey: "assets/aa/video.mp4", path: "video.mp4", bytes: 999, sha256: "a".repeat(64), extension: ".mp4", contentType: "video/mp4", role: "primary" }],
    youtubeThumbnail: thumbnail,
    uploadConfig,
    packageRoot: "D:\\packages\\video",
    tiktokApproval: null
  });
  assert.equal(item.identityVersion, 2);
  assert.equal(item.fingerprint, fingerprint);
  assert.equal(item.contentId, contentId);
  assert.equal(item.targetSnapshot.youtube.channelId, "UC_BOUND");
  assert.deepEqual(item.youtubeThumbnail, thumbnail);
  assert.deepEqual(item.targets[0].options.thumbnail, validatedPackage.options.youtube.thumbnail);
  assert.equal(JSON.stringify(item).includes("thumbnailUrl"), false);

  assert.throws(() => buildCloudItem({
    local: { ...local, contentId: "0".repeat(64) },
    validatedPackage,
    media: [item.media],
    youtubeThumbnail: thumbnail,
    uploadConfig,
    packageRoot: "D:\\packages\\video",
    tiktokApproval: null
  }), /unterschiedliche contentIds/);

  assert.throws(() => buildCloudItem({
    local: { ...local, identityVersion: 1 },
    validatedPackage: { ...validatedPackage, identityVersion: 1 },
    media: [item.media],
    youtubeThumbnail: thumbnail,
    uploadConfig,
    packageRoot: "D:\\packages\\video",
    tiktokApproval: null
  }), /Identity-v2/);
});

test("Cloud item keeps legacy identity-v1 Meta contentId compatibility", () => {
  const local = {
    identityVersion: 1,
    fingerprint,
    brand: "aeris",
    accountId: "aeris",
    kind: "post",
    platforms: ["instagram"],
    targets: [{ platform: "instagram", accountId: "aeris", actionAt: "2026-09-01T08:00:00.000Z" }],
    targetStates: {},
    scheduledAt: "2026-09-01T08:00:00.000Z"
  };
  const validatedPackage = {
    identityVersion: 1,
    fingerprint,
    contentId: "fresh-validator-value-is-not-authoritative-for-v1",
    brand: "aeris",
    kind: "post",
    platforms: ["instagram"],
    caption: "Legacy Meta",
    options: { instagram: { shareToFeed: true } }
  };
  const common = {
    validatedPackage,
    media: [{ objectKey: "assets/aa/post.jpg", path: "post.jpg", bytes: 99, sha256: "a".repeat(64), extension: ".jpg", contentType: "image/jpeg", role: "primary" }],
    youtubeThumbnail: null,
    uploadConfig: { accounts: { aeris: {} } },
    packageRoot: "D:\\packages\\legacy-meta",
    tiktokApproval: null
  };

  const withoutContentId = buildCloudItem({ local, ...common });
  assert.equal(withoutContentId.identityVersion, 1);
  assert.equal(withoutContentId.contentId, null);

  const preserved = buildCloudItem({ local: { ...local, contentId: "legacy-content-id" }, ...common });
  assert.equal(preserved.contentId, "legacy-content-id");
});
