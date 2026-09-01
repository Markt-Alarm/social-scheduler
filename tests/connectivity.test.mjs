import assert from "node:assert/strict";
import test from "node:test";

import { r2Credentials } from "../cloud-lib.mjs";
import { check, safeDetails } from "../publish-cloud.mjs";

const ENV_NAMES = [
  "SOCIAL_R2_ACCESS_KEY_ID",
  "SOCIAL_R2_SECRET_ACCESS_KEY",
  "SOCIAL_R2_ENDPOINT",
  "SOCIAL_R2_BUCKET_NAME",
  "META_R2_ACCESS_KEY_ID",
  "META_R2_SECRET_ACCESS_KEY",
  "META_R2_ENDPOINT",
  "META_R2_BUCKET_NAME",
  "SOCIAL_PROVIDER_CREDENTIALS_JSON",
  "SOCIAL_YOUTUBE_CHECKS_JSON",
  "YOUTUBE_WERKSTERN_CLIENT_ID",
  "YOUTUBE_WERKSTERN_CLIENT_SECRET",
  "YOUTUBE_WERKSTERN_REFRESH_TOKEN"
];

function restoreEnvironment(snapshot) {
  for (const name of ENV_NAMES) {
    if (snapshot[name] === undefined) delete process.env[name];
    else process.env[name] = snapshot[name];
  }
}

test("blank new R2 variables preserve the existing Meta R2 fallback", (t) => {
  const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => restoreEnvironment(snapshot));
  process.env.SOCIAL_R2_ACCESS_KEY_ID = "";
  process.env.SOCIAL_R2_SECRET_ACCESS_KEY = "";
  process.env.SOCIAL_R2_ENDPOINT = "";
  process.env.SOCIAL_R2_BUCKET_NAME = "";
  process.env.META_R2_ACCESS_KEY_ID = "legacy-access";
  process.env.META_R2_SECRET_ACCESS_KEY = "legacy-secret";
  process.env.META_R2_ENDPOINT = "https://legacy.r2.cloudflarestorage.com/";
  process.env.META_R2_BUCKET_NAME = "legacy-bucket";

  const credentials = r2Credentials();
  assert.equal(credentials.accessKeyId, "legacy-access");
  assert.equal(credentials.secretAccessKey, "legacy-secret");
  assert.equal(credentials.endpoint.host, "legacy.r2.cloudflarestorage.com");
  assert.equal(credentials.bucket, "legacy-bucket");
});

test("provider details use a strict scalar allowlist and drop echoed messages or URLs", () => {
  const safe = safeDetails({
    details: {
      code: "WAITING_CONFIGURATION",
      httpStatus: 403,
      apiMessage: "echoed refresh-sentinel https://example.test/?token=secret",
      cause: "network request to https://capability.example.test",
      uploadUrl: "https://capability.example.test"
    }
  });
  assert.deepEqual(safe, { code: "WAITING_CONFIGURATION", httpStatus: 403 });
  assert.equal(JSON.stringify(safe).includes("sentinel"), false);
});

test("cloud check verifies OAuth and channel binding without writes or secret output", async (t) => {
  const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnvironment(snapshot);
    globalThis.fetch = originalFetch;
  });

  process.env.SOCIAL_R2_ACCESS_KEY_ID = "r2-access-sentinel";
  process.env.SOCIAL_R2_SECRET_ACCESS_KEY = "r2-secret-sentinel";
  process.env.SOCIAL_R2_ENDPOINT = "https://account-test.r2.cloudflarestorage.com/";
  process.env.SOCIAL_R2_BUCKET_NAME = "secret-test-bucket";
  delete process.env.SOCIAL_PROVIDER_CREDENTIALS_JSON;
  process.env.YOUTUBE_WERKSTERN_CLIENT_ID = "client-sentinel";
  process.env.YOUTUBE_WERKSTERN_CLIENT_SECRET = "client-secret-sentinel";
  process.env.YOUTUBE_WERKSTERN_REFRESH_TOKEN = "refresh-sentinel";
  process.env.SOCIAL_YOUTUBE_CHECKS_JSON = JSON.stringify([{
    accountId: "werkstern",
    channelId: "UC_EXPECTED",
    clientIdEnv: "YOUTUBE_WERKSTERN_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_WERKSTERN_CLIENT_SECRET",
    refreshTokenEnv: "YOUTUBE_WERKSTERN_REFRESH_TOKEN"
  }]);

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = String(options.method ?? "GET").toUpperCase();
    calls.push({ value, method });
    if (value.includes(".r2.cloudflarestorage.com/")) {
      assert.equal(method, "GET");
      return new Response(JSON.stringify({ schemaVersion: 2, items: [] }), { status: 200, headers: { etag: "queue-etag" } });
    }
    if (value === "https://oauth2.googleapis.com/token") {
      assert.equal(method, "POST");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "refresh-sentinel");
      assert.deepEqual(new Set(body.get("scope")?.split(" ")), new Set([
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.force-ssl"
      ]));
      return Response.json({ access_token: "access-sentinel" });
    }
    if (value.startsWith("https://www.googleapis.com/youtube/v3/channels?")) {
      const parsed = new URL(value);
      assert.equal(method, "GET");
      assert.equal(parsed.searchParams.get("mine"), "true");
      assert.equal(options.headers?.authorization, "Bearer access-sentinel");
      return Response.json({ items: [{ id: "UC_EXPECTED" }] });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const result = await check({ writeOutput: false });
  const serialized = JSON.stringify(result.report);
  assert.equal(result.failed, false);
  assert.equal(result.report.accounts.werkstern.youtube, "OK");
  assert.deepEqual(result.report.r2, { status: "OK" });
  for (const { value, method } of calls) {
    if (method !== "GET") assert.equal(value === "https://oauth2.googleapis.com/token" && method === "POST", true, `unexpected mutation-capable request: ${method} ${value}`);
  }
  assert.equal(calls.some(({ value }) => value.includes("/upload/youtube/")), false);
  for (const sentinel of [
    "r2-access-sentinel",
    "r2-secret-sentinel",
    "account-test.r2.cloudflarestorage.com",
    "secret-test-bucket",
    "client-sentinel",
    "client-secret-sentinel",
    "refresh-sentinel",
    "access-sentinel"
  ]) assert.equal(serialized.includes(sentinel), false, `${sentinel} leaked into the report`);
});
