import assert from "node:assert/strict";
import test from "node:test";

import { confirmTikTokInboxItem, publicConfirmationResult } from "../confirm-tiktok-cloud.mjs";
import {
  AmbiguousMutationError,
  QaBlockedError as MetaQaBlockedError,
  publishPlatform as publishMetaPlatform
} from "../cloud-lib.mjs";
import { publishTikTok } from "../provider-tiktok.mjs";
import { checkYouTubeConnection, publishYouTube } from "../provider-youtube.mjs";

const fingerprint = "c".repeat(64);

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
        "https://www.googleapis.com/auth/youtube.readonly"
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

test("YouTube connectivity check rejects a token response without upload scope", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    return Response.json({
      access_token: "access-sentinel",
      scope: "https://www.googleapis.com/auth/youtube.readonly"
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
      events.push("init");
      return new Response(null, { status: 200, headers: { location: "https://upload.googleapis.com/session/123" } });
    }
    if (value.includes("/youtube/v3/videos?")) {
      return Response.json({ items: [{ id: "video-123", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
    }
    if (value === "https://upload.googleapis.com/session/123" && options.headers?.["content-range"] === "bytes */3") return new Response(null, { status: 308 });
    if (value.startsWith("https://r2.example.com/") && options.headers?.range === "bytes=0-2") return new Response(Buffer.from("abc"), { status: 206 });
    if (value === "https://upload.googleapis.com/session/123" && options.headers?.["content-range"] === "bytes 0-2/3") return Response.json({ id: "video-123" });
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    const checkpoints = [];
    const result = await publishYouTube({
      r2Credentials: { accessKeyId: "AKID", secretAccessKey: "secret", endpoint: new URL("https://r2.example.com"), bucket: "bucket" },
      credentials: { clientId: "client", clientSecret: "client-secret", refreshToken: "refresh" },
      item: {
        fingerprint,
        brand: "aeris",
        accountId: "aeris",
        kind: "video",
        caption: "Testvideo",
        scheduledAt: "2026-09-01T08:00:00.000Z",
        account: { youtube: { enabled: true, channelId: "UC_EXPECTED" } },
        media: { objectKey: "assets/aa/video.mp4", bytes: 3, contentType: "video/mp4" }
      },
      target: { platform: "youtube", accountId: "aeris", actionAt: "2026-09-01T08:00:00.000Z", options: { privacyStatus: "private", title: exactTitle, tags: exactTags } },
      state: { status: "PENDING" },
      checkpoint: async (state) => {
        checkpoints.push(structuredClone(state));
        events.push(`checkpoint:${state.status}`);
      }
    });
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.remoteMediaId, "video-123");
    assert.ok(events.indexOf("checkpoint:SUBMITTING") < events.indexOf("init"));
    assert.ok(checkpoints.some((state) => state.status === "UPLOAD_SESSION" && state.resumableSessionUri));
    assert.equal(JSON.stringify(checkpoints).includes("refresh"), false);
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
      item: {
        fingerprint,
        brand: "aeris",
        accountId: "aeris",
        kind: "video",
        caption: "Testvideo",
        scheduledAt: "2026-09-01T08:00:00.000Z",
        account: { youtube: { enabled: true, channelId: "UC_EXPECTED" } },
        media: { objectKey: "assets/aa/video.mp4", bytes: 3, contentType: "video/mp4" }
      },
      target: { platform: "youtube", accountId: "aeris", actionAt: "2026-09-01T08:00:00.000Z", options: { privacyStatus: "private", title: "Testvideo" } },
      state: { status: "UPLOAD_SESSION", resumableSessionUri: "https://upload.googleapis.com/session/ambiguous", nextByte: 0 },
      checkpoint: async () => {}
    }), (error) => error instanceof AmbiguousMutationError && error.ambiguous === true);
    assert.equal(sessionQueries, 2);
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
