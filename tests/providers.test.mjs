import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { confirmTikTokInboxItem, publicConfirmationResult } from "../confirm-tiktok-cloud.mjs";
import {
  AmbiguousMutationError,
  QaBlockedError as MetaQaBlockedError,
  publishPlatform as publishMetaPlatform
} from "../cloud-lib.mjs";
import { verifyMediaAssets } from "../provider-dispatch.mjs";
import { publishTikTok } from "../provider-tiktok.mjs";
import { checkYouTubeConnection, publishYouTube } from "../provider-youtube.mjs";

const fingerprint = "c".repeat(64);
const thumbnailBody = Buffer.from("bound-youtube-thumbnail");
const thumbnailSha256 = createHash("sha256").update(thumbnailBody).digest("hex");

function youtubeItem(overrides = {}) {
  return {
    identityVersion: 2,
    fingerprint,
    contentId: "youtube-content",
    brand: "aeris",
    accountId: "aeris",
    kind: "video",
    caption: "Testvideo",
    scheduledAt: "2026-09-01T08:00:00.000Z",
    targetSnapshot: { youtube: { channelId: "UC_EXPECTED" } },
    account: { youtube: { enabled: true, channelId: "UC_EXPECTED" } },
    media: { objectKey: "assets/aa/video.mp4", bytes: 3, contentType: "video/mp4" },
    youtubeThumbnail: {
      objectKey: `assets/${thumbnailSha256.slice(0, 2)}/${thumbnailSha256}.jpg`,
      bytes: thumbnailBody.byteLength,
      sha256: thumbnailSha256,
      extension: ".jpg",
      contentType: "image/jpeg",
      role: "youtube-thumbnail"
    },
    ...overrides
  };
}

function youtubeTarget(optionOverrides = {}) {
  return {
    platform: "youtube",
    accountId: "aeris",
    actionAt: "2026-09-01T08:00:00.000Z",
    options: {
      privacyStatus: "private",
      title: "Testvideo",
      thumbnail: {
        bytes: thumbnailBody.byteLength,
        sha256: thumbnailSha256,
        extension: ".jpg",
        contentType: "image/jpeg"
      },
      ...optionOverrides
    }
  };
}

const metaConfig = {
  graphApi: {
    baseUrl: "https://graph.facebook.com",
    version: "v24.0",
    requestTimeoutSeconds: 1,
    pollIntervalSeconds: 0,
    pollTimeoutSeconds: 0,
    maxSafeRetries: 0,
    baseBackoffMs: 0
  }
};

test("Meta publication success without parseable JSON or an object id is ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const responseFactory of [
      () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      () => Response.json({ success: true })
    ]) {
      const checkpoints = [];
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return responseFactory();
      };
      await assert.rejects(() => publishMetaPlatform({
        config: metaConfig,
        socialPackage: { kind: "post", caption: "Meta test" },
        account: { pageId: "page-test" },
        token: "meta-test-token",
        mediaUrl: "https://media.example.test/test.jpg",
        platform: "facebook",
        checkpoint: async (state) => checkpoints.push(structuredClone(state))
      }), (error) => error instanceof AmbiguousMutationError && error.ambiguous === true);
      assert.equal(calls, 1);
      assert.equal(checkpoints.at(-1)?.status, "AMBIGUOUS");
      assert.equal(checkpoints.at(-1)?.publishPhase, "AMBIGUOUS");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta pre-publication JSON parse failures remain QA-blocked, not ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => publishMetaPlatform({
      config: metaConfig,
      socialPackage: { kind: "post", caption: "Meta test", media: { path: "test.jpg" } },
      account: { instagramAccountId: "instagram-test" },
      token: "meta-test-token",
      mediaUrl: "https://media.example.test/test.jpg",
      platform: "instagram",
      checkpoint: async () => {}
    }), (error) => error instanceof MetaQaBlockedError && !(error instanceof AmbiguousMutationError) && error.ambiguous !== true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube connectivity check refreshes OAuth and verifies the channel without upload mutation", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = String(options.method ?? "GET").toUpperCase();
    calls.push({ value, method });
    if (value === "https://oauth2.googleapis.com/token") {
      assert.equal(method, "POST");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.deepEqual(new Set(body.get("scope")?.split(" ")), new Set([
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.force-ssl"
      ]));
      return Response.json({ access_token: "short-lived" });
    }
    if (value.includes("/youtube/v3/channels")) {
      const parsed = new URL(value);
      assert.equal(method, "GET");
      assert.equal(parsed.searchParams.get("mine"), "true");
      assert.equal(options.headers?.authorization, "Bearer short-lived");
      return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    await checkYouTubeConnection({
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      expectedChannelId: "UC_EXPECTED"
    });
    assert.equal(calls.length, 2);
    assert.equal(calls.some(({ value }) => value.includes("/upload/")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube connectivity check rejects a swapped channel before any upload request", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-sentinel" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_OTHER" }] });
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    await assert.rejects(() => checkYouTubeConnection({
      credentials: { clientId: "client", clientSecret: "secret-sentinel", refreshToken: "refresh-sentinel" },
      expectedChannelId: "UC_EXPECTED"
    }), (error) => {
      const visible = `${error?.message ?? ""}\n${error?.stack ?? ""}\n${JSON.stringify(error?.details ?? {})}`;
      return error instanceof MetaQaBlockedError
        && error.configuration === true
        && error.details?.code === "WAITING_CONFIGURATION"
        && !visible.includes("sentinel");
    });
    assert.equal(calls.length, 2);
    assert.equal(calls.some((value) => value.includes("/upload/")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube connectivity check rejects a token response without the visibility-update scope", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    return Response.json({
      access_token: "access-sentinel",
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"
    });
  };
  try {
    await assert.rejects(() => checkYouTubeConnection({
      credentials: { clientId: "client", clientSecret: "secret-sentinel", refreshToken: "refresh-sentinel" },
      expectedChannelId: "UC_EXPECTED"
    }), (error) => error instanceof MetaQaBlockedError
      && error.configuration === true
      && error.details?.code === "WAITING_CONFIGURATION");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube resumable upload checkpoints the session and confirms the video id", async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  const exactTitle = "😀".repeat(100);
  const exactTags = Array.from({ length: 101 }, (_, index) => `t${index}`);
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    if (value.includes("/upload/youtube/v3/videos")) {
      const metadata = JSON.parse(options.body);
      assert.equal(metadata.snippet.title, exactTitle);
      assert.deepEqual(metadata.snippet.tags, exactTags);
      assert.equal(metadata.status.license, "creativeCommon");
      assert.equal(metadata.status.embeddable, false);
      assert.equal(metadata.status.publicStatsViewable, false);
      assert.equal(metadata.status.privacyStatus, "private");
      assert.equal(Object.prototype.hasOwnProperty.call(metadata.status, "publishAt"), false);
      events.push("init");
      return new Response(null, { status: 200, headers: { location: "https://upload.googleapis.com/session/123" } });
    }
    if (value.includes("/youtube/v3/videos?part=status") && options.method === "PUT") {
      const update = JSON.parse(options.body);
      assert.equal(update.id, "video-123");
      assert.equal(update.status.privacyStatus, "unlisted");
      assert.equal(Object.prototype.hasOwnProperty.call(update.status, "publishAt"), false);
      events.push("visibility-update");
      return Response.json({ id: "video-123", status: update.status });
    }
    if (value.includes("/youtube/v3/videos?")) {
      return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
    }
    if (value.includes("/upload/youtube/v3/thumbnails/set?")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers?.["content-type"], "image/jpeg");
      assert.deepEqual(Buffer.from(options.body), thumbnailBody);
      events.push("thumbnail-set");
      return Response.json({ items: [] });
    }
    if (value === "https://upload.googleapis.com/session/123" && options.headers?.["content-range"] === "bytes */3") return new Response(null, { status: 308 });
    if (value.startsWith("https://r2.example.com/") && options.headers?.range === "bytes=0-2") return new Response(Buffer.from("abc"), { status: 206 });
    if (value.startsWith("https://r2.example.com/") && value.includes(thumbnailSha256) && !options.headers?.range) return new Response(thumbnailBody);
    if (value === "https://upload.googleapis.com/session/123" && options.headers?.["content-range"] === "bytes 0-2/3") return Response.json({ id: "video-123" });
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    const checkpoints = [];
    const result = await publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget({ title: exactTitle, tags: exactTags, license: "creativeCommon", embeddable: false, publicStatsViewable: false, privacyStatus: "unlisted", auditApproved: true }),
      state: { status: "PENDING" },
      checkpoint: async (state) => {
        checkpoints.push(structuredClone(state));
        events.push(`checkpoint:${state.status}`);
      }
    });
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.remoteMediaId, "video-123");
    assert.ok(events.indexOf("checkpoint:SUBMITTING") < events.indexOf("init"));
    assert.ok(events.indexOf("checkpoint:UPLOADED") < events.indexOf("thumbnail-set"));
    assert.ok(events.indexOf("checkpoint:SETTING_THUMBNAIL") < events.indexOf("thumbnail-set"));
    assert.ok(events.indexOf("thumbnail-set") < events.indexOf("checkpoint:UPDATING_VISIBILITY"));
    assert.ok(events.indexOf("checkpoint:UPDATING_VISIBILITY") < events.indexOf("visibility-update"));
    assert.ok(checkpoints.some((state) => state.status === "UPLOAD_SESSION" && state.resumableSessionUri));
    assert.ok(checkpoints.some((state) => state.thumbnailPhase === "CONFIRMED" && state.thumbnailSha256 === thumbnailSha256));
    assert.ok(checkpoints.some((state) => state.visibilityPhase === "CONFIRMED" && state.visibilityAppliedPrivacyStatus === "unlisted"));
    assert.equal(JSON.stringify(checkpoints).includes("refresh"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube schedules future public visibility only after the exact thumbnail is confirmed", async () => {
  const originalFetch = globalThis.fetch;
  const publishAt = new Date(Date.now() + 30_000).toISOString();
  const uploadActionAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const events = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    if (value.includes("/youtube/v3/videos?part=status") && options.method === "PUT") {
      const update = JSON.parse(options.body);
      assert.equal(update.id, "video-scheduled");
      assert.equal(update.status.privacyStatus, "private");
      assert.equal(update.status.publishAt, publishAt);
      assert.deepEqual(update.status, {
        privacyStatus: "private",
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: false,
        license: "youtube",
        embeddable: true,
        publicStatsViewable: true,
        publishAt
      });
      events.push("visibility-update");
      return Response.json({ id: "video-scheduled", status: update.status });
    }
    if (value.includes("/youtube/v3/videos?")) {
      return Response.json({ items: [{ id: "video-scheduled", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
    }
    if (value.startsWith("https://r2.example.com/") && value.includes(thumbnailSha256)) return new Response(thumbnailBody);
    if (value.includes("/thumbnails/set")) {
      events.push("thumbnail-set");
      return Response.json({ items: [] });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    const checkpoints = [];
    const result = await publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem({ scheduledAt: publishAt }),
      target: {
        ...youtubeTarget({ privacyStatus: "public", auditApproved: true }),
        actionAt: uploadActionAt
      },
      state: { status: "UPLOADED", videoId: "video-scheduled", uploadComplete: true },
      checkpoint: async (state) => {
        checkpoints.push(structuredClone(state));
        if (state.thumbnailPhase === "CONFIRMED") events.push("thumbnail-confirmed");
        if (state.visibilityPhase === "REQUESTING") events.push("visibility-requesting");
      }
    });
    assert.equal(result.status, "SCHEDULED_REMOTE");
    assert.ok(events.indexOf("thumbnail-set") < events.indexOf("thumbnail-confirmed"));
    assert.ok(events.indexOf("thumbnail-confirmed") < events.indexOf("visibility-requesting"));
    assert.ok(events.indexOf("visibility-requesting") < events.indexOf("visibility-update"));
    const requesting = checkpoints.find((state) => state.visibilityPhase === "REQUESTING");
    const confirmed = checkpoints.find((state) => state.visibilityPhase === "CONFIRMED");
    assert.match(requesting.visibilitySha256, /^[a-f0-9]{64}$/);
    assert.match(requesting.visibilityRequestSha256, /^[a-f0-9]{64}$/);
    assert.equal(confirmed.visibilityRequestSha256, requesting.visibilityRequestSha256);
    assert.equal(confirmed.visibilityAppliedPublishAt, publishAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube keeps a thumbnail-confirmed but still-processing video private", async () => {
  const originalFetch = globalThis.fetch;
  let visibilityUpdates = 0;
  const checkpoints = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    if (value.includes("/youtube/v3/videos?part=status") && options.method === "PUT") {
      visibilityUpdates += 1;
      throw new Error("must stay private while processing");
    }
    if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-processing", status: { uploadStatus: "uploaded", privacyStatus: "private" }, processingDetails: { processingStatus: "processing" } }] });
    if (value.startsWith("https://r2.example.com/") && value.includes(thumbnailSha256)) return new Response(thumbnailBody);
    if (value.includes("/thumbnails/set")) return Response.json({ items: [] });
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    await assert.rejects(() => publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget({ privacyStatus: "unlisted", auditApproved: true }),
      state: { status: "UPLOADED", videoId: "video-processing", uploadComplete: true },
      checkpoint: async (state) => checkpoints.push(structuredClone(state))
    }), (error) => error instanceof MetaQaBlockedError && error.retryable === true && error.details?.code === "YOUTUBE_PROCESSING");
    assert.ok(checkpoints.some((state) => state.thumbnailPhase === "CONFIRMED"));
    assert.equal(checkpoints.at(-1).status, "PROCESSING");
    assert.equal(visibilityUpdates, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider asset verification checks a pending thumbnail and skips it after exact confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const primarySha256 = "a".repeat(64);
  let heads = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.method, "HEAD");
    const value = String(url);
    const thumbnail = value.includes(thumbnailSha256);
    heads.push(thumbnail ? "thumbnail" : "primary");
    return new Response(null, {
      headers: {
        "content-length": String(thumbnail ? thumbnailBody.byteLength : 3),
        "x-amz-meta-sha256": thumbnail ? thumbnailSha256 : primarySha256
      }
    });
  };
  const credentials = { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" };
  const item = youtubeItem({ media: { objectKey: "assets/aa/video.mp4", bytes: 3, sha256: primarySha256, contentType: "video/mp4" } });
  try {
    await verifyMediaAssets(credentials, item, youtubeTarget(), {});
    assert.deepEqual(heads, ["primary", "thumbnail"]);
    heads = [];
    await verifyMediaAssets(credentials, item, youtubeTarget(), { thumbnailPhase: "CONFIRMED", thumbnailSet: true, thumbnailSha256 });
    assert.deepEqual(heads, ["primary"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube treats a 2xx final chunk without a recoverable video id as ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  let sessionQueries = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const range = options.headers?.["content-range"];
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    if (value === "https://upload.googleapis.com/session/ambiguous" && range === "bytes */3") {
      sessionQueries += 1;
      return sessionQueries === 1 ? new Response(null, { status: 308 }) : Response.json({});
    }
    if (value.startsWith("https://r2.example.com/") && options.headers?.range === "bytes=0-2") return new Response(Buffer.from("abc"), { status: 206 });
    if (value === "https://upload.googleapis.com/session/ambiguous" && range === "bytes 0-2/3") return Response.json({});
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    await assert.rejects(() => publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget(),
      state: { status: "UPLOAD_SESSION", resumableSessionUri: "https://upload.googleapis.com/session/ambiguous", nextByte: 0 },
      checkpoint: async () => {}
    }), (error) => error instanceof AmbiguousMutationError && error.ambiguous === true);
    assert.equal(sessionQueries, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube never sends thumbnails.set again for the exact confirmed hash", async () => {
  const originalFetch = globalThis.fetch;
  let thumbnailRequests = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
    if (value.includes("/thumbnails/set") || value.includes(thumbnailSha256)) thumbnailRequests += 1;
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    const result = await publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget(),
      state: { status: "UPLOADED", videoId: "video-123", uploadComplete: true, thumbnailPhase: "CONFIRMED", thumbnailSet: true, thumbnailSha256 },
      checkpoint: async () => {}
    });
    assert.equal(result.status, "PUBLISHED");
    assert.equal(thumbnailRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube blocks an unresolved thumbnail REQUESTING checkpoint before network access", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(() => publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget(),
      state: { status: "SETTING_THUMBNAIL", videoId: "video-123", uploadComplete: true, thumbnailPhase: "REQUESTING", thumbnailSha256 },
      checkpoint: async () => {}
    }), (error) => error instanceof AmbiguousMutationError && error.ambiguous === true);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube blocks an unresolved visibility REQUESTING checkpoint before network access", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(() => publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget({ privacyStatus: "unlisted", auditApproved: true }),
      state: {
        status: "UPDATING_VISIBILITY",
        videoId: "video-123",
        uploadComplete: true,
        thumbnailPhase: "CONFIRMED",
        thumbnailSet: true,
        thumbnailSha256,
        visibilityPhase: "REQUESTING",
        visibilitySha256: "f".repeat(64)
      },
      checkpoint: async () => {}
    }), (error) => error instanceof AmbiguousMutationError && error.ambiguous === true);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube thumbnails.set maps HTTP 403 to waiting configuration", async () => {
  const originalFetch = globalThis.fetch;
  const checkpoints = [];
  let visibilityUpdates = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    if (value.includes("/youtube/v3/videos?part=status") && options.method === "PUT") {
      visibilityUpdates += 1;
      throw new Error("visibility must remain private after thumbnail failure");
    }
    if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
    if (value.startsWith("https://r2.example.com/") && value.includes(thumbnailSha256)) return new Response(thumbnailBody);
    if (value.includes("/thumbnails/set")) return Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status: 403 });
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    await assert.rejects(() => publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget({ privacyStatus: "unlisted", auditApproved: true }),
      state: { status: "UPLOADED", videoId: "video-123", uploadComplete: true },
      checkpoint: async (state) => checkpoints.push(structuredClone(state))
    }), (error) => error instanceof MetaQaBlockedError && error.configuration === true && error.details?.code === "WAITING_CONFIGURATION");
    assert.ok(checkpoints.some((state) => state.thumbnailPhase === "REQUESTING"));
    assert.equal(checkpoints.at(-1).thumbnailPhase, "REJECTED");
    assert.equal(checkpoints.at(-1).status, "WAITING_CONFIGURATION");
    assert.equal(visibilityUpdates, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube thumbnails.set schedules definite HTTP 404 and 429 retries with actionAt", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [404, 429]) {
      const checkpoints = [];
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
        if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
        if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
        if (value.startsWith("https://r2.example.com/") && value.includes(thumbnailSha256)) return new Response(thumbnailBody);
        if (value.includes("/thumbnails/set")) return Response.json({ error: { errors: [{ reason: "retry" }] } }, { status, headers: status === 429 ? { "retry-after": "120" } : {} });
        throw new Error(`unexpected fetch: ${value}`);
      };
      await assert.rejects(() => publishYouTube({
        r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
        credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
        item: youtubeItem(),
        target: youtubeTarget(),
        state: { status: "UPLOADED", videoId: "video-123", uploadComplete: true },
        checkpoint: async (state) => checkpoints.push(structuredClone(state))
      }), (error) => error instanceof MetaQaBlockedError && error.retryable === true && error.details?.code === "YOUTUBE_THUMBNAIL_RETRY");
      const retry = checkpoints.at(-1);
      assert.equal(retry.thumbnailPhase, "REJECTED_RETRYABLE");
      assert.equal(retry.thumbnailLastHttpStatus, status);
      assert.ok(Date.parse(retry.actionAt) > Date.now());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube thumbnails.set network and 5xx outcomes are ambiguous after REQUESTING", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const outcome of ["network", "server"]) {
      const checkpoints = [];
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
        if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
        if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
        if (value.startsWith("https://r2.example.com/") && value.includes(thumbnailSha256)) return new Response(thumbnailBody);
        if (value.includes("/thumbnails/set")) {
          if (outcome === "network") throw new Error("connection dropped");
          return Response.json({ error: { errors: [{ reason: "backendError" }] } }, { status: 503 });
        }
        throw new Error(`unexpected fetch: ${value}`);
      };
      await assert.rejects(() => publishYouTube({
        r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
        credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
        item: youtubeItem(),
        target: youtubeTarget(),
        state: { status: "UPLOADED", videoId: "video-123", uploadComplete: true },
        checkpoint: async (state) => checkpoints.push(structuredClone(state))
      }), (error) => error instanceof AmbiguousMutationError && error.ambiguous === true);
      assert.equal(checkpoints.at(-1).thumbnailPhase, "REQUESTING");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube keeps visibility REQUESTING ambiguous for network, 5xx and mismatched 2xx results", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const outcome of ["network", "server", "mismatch"]) {
      const checkpoints = [];
      globalThis.fetch = async (url, options = {}) => {
        const value = String(url);
        if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
        if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
        if (value.includes("/youtube/v3/videos?part=status") && options.method === "PUT") {
          if (outcome === "network") throw new Error("connection dropped");
          if (outcome === "server") return Response.json({ error: { errors: [{ reason: "backendError" }] } }, { status: 503 });
          const update = JSON.parse(options.body);
          return Response.json({ id: "wrong-video", status: update.status });
        }
        if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
        throw new Error(`unexpected fetch: ${value}`);
      };
      await assert.rejects(() => publishYouTube({
        r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
        credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
        item: youtubeItem(),
        target: youtubeTarget({ privacyStatus: "unlisted", auditApproved: true }),
        state: { status: "UPLOADED", videoId: "video-123", uploadComplete: true, thumbnailPhase: "CONFIRMED", thumbnailSet: true, thumbnailSha256 },
        checkpoint: async (state) => checkpoints.push(structuredClone(state))
      }), (error) => error instanceof AmbiguousMutationError && error.ambiguous === true);
      assert.equal(checkpoints.at(-1).visibilityPhase, "REQUESTING");
      assert.match(checkpoints.at(-1).visibilityRequestSha256, /^[a-f0-9]{64}$/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube visibility maps 404 and 429 to retry and 403 to configuration", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [404, 429, 403]) {
      const checkpoints = [];
      globalThis.fetch = async (url, options = {}) => {
        const value = String(url);
        if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
        if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
        if (value.includes("/youtube/v3/videos?part=status") && options.method === "PUT") {
          return Response.json({ error: { errors: [{ reason: "rejected" }] } }, { status, headers: status === 429 ? { "retry-after": "120" } : {} });
        }
        if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
        throw new Error(`unexpected fetch: ${value}`);
      };
      await assert.rejects(() => publishYouTube({
        r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
        credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
        item: youtubeItem(),
        target: youtubeTarget({ privacyStatus: "unlisted", auditApproved: true }),
        state: { status: "UPLOADED", videoId: "video-123", uploadComplete: true, thumbnailPhase: "CONFIRMED", thumbnailSet: true, thumbnailSha256 },
        checkpoint: async (state) => checkpoints.push(structuredClone(state))
      }), (error) => status === 403
        ? error instanceof MetaQaBlockedError && error.configuration === true && error.details?.code === "WAITING_CONFIGURATION"
        : error instanceof MetaQaBlockedError && error.retryable === true && error.details?.code === "YOUTUBE_VISIBILITY_RETRY");
      if (status === 403) {
        assert.equal(checkpoints.at(-1).status, "WAITING_CONFIGURATION");
        assert.equal(checkpoints.at(-1).visibilityPhase, "REJECTED");
      } else {
        assert.equal(checkpoints.at(-1).visibilityPhase, "REJECTED_RETRYABLE");
        assert.equal(checkpoints.at(-1).visibilityLastHttpStatus, status);
        assert.ok(Date.parse(checkpoints.at(-1).actionAt) > Date.now());
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube never repeats an exactly confirmed visibility update", async () => {
  const originalFetch = globalThis.fetch;
  let visibilityUpdates = 0;
  let remotePrivacyStatus = "private";
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived" });
    if (value.includes("/youtube/v3/channels")) return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    if (value.includes("/youtube/v3/videos?part=status") && options.method === "PUT") {
      visibilityUpdates += 1;
      const update = JSON.parse(options.body);
      remotePrivacyStatus = update.status.privacyStatus;
      return Response.json({ id: "video-123", status: update.status });
    }
    if (value.includes("/youtube/v3/videos?")) return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: remotePrivacyStatus }, processingDetails: { processingStatus: "succeeded" } }] });
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    let durableState = { status: "UPLOADED", videoId: "video-123", uploadComplete: true, thumbnailPhase: "CONFIRMED", thumbnailSet: true, thumbnailSha256 };
    const run = async () => publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: youtubeItem(),
      target: youtubeTarget({ privacyStatus: "unlisted", auditApproved: true }),
      state: durableState,
      checkpoint: async (state) => { durableState = structuredClone(state); }
    });
    assert.equal((await run()).status, "PUBLISHED");
    assert.equal(durableState.visibilityPhase, "CONFIRMED");
    assert.equal((await run()).status, "PUBLISHED");
    assert.equal(visibilityUpdates, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TikTok inbox stores no signed media capability and returns action required", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  const events = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("/v2/user/info/")) return Response.json({ data: { user: { open_id: "open-aeris", display_name: "Aeris" } }, error: { code: "ok", message: "" } });
    if (value.startsWith("https://media.example/")) return new Response(null, { status: 200, headers: { "content-length": "3", "content-type": "video/mp4" } });
    if (value === "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/") {
      requestBody = JSON.parse(options.body);
      events.push("mutation");
      return Response.json({ data: { publish_id: "pub-1" }, error: { code: "ok", message: "" } });
    }
    if (value === "https://open.tiktokapis.com/v2/post/publish/status/fetch/") {
      return Response.json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok", message: "" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    const checkpoints = [];
    const result = await publishTikTok({
      credentials: { accessToken: "tiktok-secret", mediaUrlTemplate: "https://media.example/{objectKey}?token=url-secret" },
      item: {
        fingerprint,
        brand: "aeris",
        accountId: "aeris",
        kind: "reel",
        caption: "Test",
        account: { purpose: "organic", tiktok: { enabled: true, mode: "inbox", openId: "open-aeris", verifiedUrlPrefix: "https://media.example/" } },
        media: { objectKey: "assets/aa/video.mp4", bytes: 3, contentType: "video/mp4" }
      },
      target: { platform: "tiktok", accountId: "aeris", options: { mode: "inbox" } },
      state: { status: "PENDING" },
      checkpoint: async (state) => {
        checkpoints.push(structuredClone(state));
        events.push(`checkpoint:${state.status}`);
      }
    });
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.match(requestBody.source_info.video_url, /url-secret/);
    assert.ok(events.indexOf("checkpoint:SUBMITTING") < events.indexOf("mutation"));
    assert.equal(JSON.stringify(checkpoints).includes("url-secret"), false);
    assert.equal(JSON.stringify(checkpoints).includes("tiktok-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TikTok blocks a swapped account token before inbox mutation", async () => {
  const originalFetch = globalThis.fetch;
  let mutated = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v2/user/info/")) {
      return Response.json({ data: { user: { open_id: "open-other" } }, error: { code: "ok", message: "" } });
    }
    mutated = true;
    throw new Error("must not mutate");
  };
  try {
    await assert.rejects(() => publishTikTok({
      credentials: { accessToken: "token", mediaUrlTemplate: "https://media.example/{objectKey}" },
      item: {
        fingerprint,
        brand: "aeris",
        accountId: "aeris",
        kind: "reel",
        account: { purpose: "organic", tiktok: { enabled: true, mode: "inbox", openId: "open-aeris", verifiedUrlPrefix: "https://media.example/" } },
        media: { objectKey: "assets/x.mp4" }
      },
      target: { platform: "tiktok", accountId: "aeris", options: { mode: "inbox" } },
      state: { status: "PENDING" },
      checkpoint: async () => {}
    }), (error) => error.configuration === true);
    assert.equal(mutated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TikTok retries a transient identity outage instead of freezing configuration", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v2/user/info/")) return Response.json({ error: { code: "server_error", message: "later" } }, { status: 503 });
    throw new Error("must not continue after identity failure");
  };
  try {
    await assert.rejects(() => publishTikTok({
      credentials: { accessToken: "token", mediaUrlTemplate: "https://media.example/{objectKey}" },
      item: {
        fingerprint,
        brand: "aeris",
        accountId: "aeris",
        kind: "reel",
        account: { purpose: "organic", tiktok: { enabled: true, mode: "inbox", openId: "open-aeris", verifiedUrlPrefix: "https://media.example/" } },
        media: { objectKey: "assets/x.mp4" }
      },
      target: { platform: "tiktok", accountId: "aeris", options: { mode: "inbox" } },
      state: { status: "PENDING" },
      checkpoint: async () => {}
    }), (error) => error.retryable === true && error.configuration !== true && error.details?.code === "TIKTOK_IDENTITY_RETRY");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TikTok Direct Post rejects stale consent structure before any network request", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(() => publishTikTok({
      credentials: { accessToken: "token", mediaUrlTemplate: "https://media.example/{objectKey}" },
      item: {
        fingerprint,
        contentId: "content-aeris",
        brand: "aeris",
        accountId: "aeris",
        kind: "reel",
        account: { purpose: "organic", tiktok: { enabled: true, mode: "direct-post", auditApproved: true, openId: "open-aeris", verifiedUrlPrefix: "https://media.example/" } },
        media: { objectKey: "assets/x.mp4", bytes: 3, contentType: "video/mp4" }
      },
      target: {
        platform: "tiktok",
        accountId: "aeris",
        options: { mode: "direct-post", auditApproved: true },
        approval: {
          schemaVersion: 1,
          fingerprint,
          contentId: "content-aeris",
          brand: "aeris",
          creatorOpenId: "open-aeris",
          consentVersion: "obsolete-consent",
          approvedAt: "2026-08-31T08:00:00.000Z",
          expiresAt: "2099-08-31T09:00:00.000Z",
          previewConfirmed: true,
          musicUsageConfirmed: true,
          expressConsent: true
        }
      },
      state: { status: "PENDING" },
      checkpoint: async () => {}
    }), (error) => error.approval === true || error.details?.code === "WAITING_APPROVAL");
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paid TikTok account is blocked before any organic API mutation", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(() => publishTikTok({
      credentials: { accessToken: "token", mediaUrlTemplate: "https://media.example/{objectKey}" },
      item: { fingerprint, kind: "video", account: { purpose: "paid", tiktok: { enabled: true, verifiedUrlPrefix: "https://media.example/" } }, media: { objectKey: "assets/x.mp4" } },
      target: { platform: "tiktok", options: {} },
      state: {},
      checkpoint: async () => {}
    }), (error) => error.configuration === true);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TikTok inbox cloud confirmation is scoped and idempotent", () => {
  const targetId = "tiktok:aeris";
  const original = {
    schemaVersion: 2,
    identityVersion: 2,
    fingerprint,
    brand: "aeris",
    accountId: "aeris",
    kind: "reel",
    platforms: ["instagram", "tiktok"],
    scheduledAt: "2026-09-01T08:00:00.000Z",
    targets: [
      { id: "instagram:aeris", platform: "instagram", accountId: "aeris", actionAt: "2026-09-01T08:00:00.000Z" },
      { id: targetId, platform: "tiktok", accountId: "aeris", actionAt: "2026-09-01T08:00:00.000Z" }
    ],
    targetStates: {
      "instagram:aeris": { status: "PUBLISHED" },
      [targetId]: { status: "ACTION_REQUIRED", action: "TIKTOK_COMPLETE_IN_APP", publishId: "pub-1", claimToken: "claim-secret" }
    }
  };
  const first = confirmTikTokInboxItem(original, {
    confirmedAt: "2026-09-01T09:00:00.000Z",
    remoteMediaId: "post-1",
    publishedUrl: "https://www.tiktok.com/@aeris/video/1"
  });
  assert.equal(first.changed, true);
  assert.equal(first.item.status, "PUBLISHED");
  assert.equal(first.targetState.status, "PUBLISHED");
  assert.equal(first.targetState.action, undefined);
  assert.equal(first.targetState.claimToken, undefined);
  assert.equal(original.targetStates[targetId].status, "ACTION_REQUIRED");

  const second = confirmTikTokInboxItem(first.item, { confirmedAt: "2026-09-01T09:01:00.000Z" });
  assert.equal(second.changed, false);
  assert.equal(second.alreadyConfirmed, true);
  assert.equal(second.targetState.remoteMediaId, "post-1");
  assert.deepEqual(publicConfirmationResult({
    alreadyConfirmed: false,
    itemStatus: first.item.status,
    targetState: { ...first.targetState, claimToken: "claim-secret", publishId: "provider-secret" }
  }), {
    alreadyConfirmed: false,
    itemStatus: "PUBLISHED",
    targetState: {
      status: "PUBLISHED",
      publishedAt: "2026-09-01T09:00:00.000Z",
      remoteMediaId: "post-1"
    }
  });
});
