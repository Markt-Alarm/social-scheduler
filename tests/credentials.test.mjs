import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resetCredentialCacheForTests, youtubeCheckProfiles, youtubeCredentials } from "../provider-credentials.mjs";

const ENV_NAMES = [
  "YOUTUBE_TEST_CLIENT_ID",
  "YOUTUBE_TEST_CLIENT_SECRET",
  "YOUTUBE_TEST_REFRESH_TOKEN",
  "SOCIAL_PROVIDER_CREDENTIALS_JSON",
  "SOCIAL_YOUTUBE_CHECKS_JSON"
];

function restoreEnvironment(snapshot) {
  for (const name of ENV_NAMES) {
    if (snapshot[name] === undefined) delete process.env[name];
    else process.env[name] = snapshot[name];
  }
  resetCredentialCacheForTests();
}

test("YouTube credentials resolve from account-specific environment variables", (t) => {
  const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => restoreEnvironment(snapshot));
  delete process.env.SOCIAL_PROVIDER_CREDENTIALS_JSON;
  process.env.YOUTUBE_TEST_CLIENT_ID = "client-from-env";
  process.env.YOUTUBE_TEST_CLIENT_SECRET = "secret-from-env";
  process.env.YOUTUBE_TEST_REFRESH_TOKEN = "refresh-from-env";
  resetCredentialCacheForTests();

  assert.deepEqual(youtubeCredentials({
    accountId: "future-channel",
    account: {
      youtube: {
        clientIdEnv: "YOUTUBE_TEST_CLIENT_ID",
        clientSecretEnv: "YOUTUBE_TEST_CLIENT_SECRET",
        refreshTokenEnv: "YOUTUBE_TEST_REFRESH_TOKEN"
      }
    }
  }), {
    clientId: "client-from-env",
    clientSecret: "secret-from-env",
    refreshToken: "refresh-from-env"
  });
});

test("account-specific YouTube environment variables override combined credentials", (t) => {
  const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => restoreEnvironment(snapshot));
  process.env.YOUTUBE_TEST_CLIENT_ID = "client-from-env";
  process.env.YOUTUBE_TEST_CLIENT_SECRET = "secret-from-env";
  process.env.YOUTUBE_TEST_REFRESH_TOKEN = "refresh-from-env";
  process.env.SOCIAL_PROVIDER_CREDENTIALS_JSON = JSON.stringify({
    accounts: {
      "future-channel": {
        youtube: {
          clientId: "client-from-json",
          clientSecret: "secret-from-json",
          refreshToken: "refresh-from-json"
        }
      }
    }
  });
  resetCredentialCacheForTests();

  assert.deepEqual(youtubeCredentials({
    accountId: "future-channel",
    account: {
      youtube: {
        clientIdEnv: "YOUTUBE_TEST_CLIENT_ID",
        clientSecretEnv: "YOUTUBE_TEST_CLIENT_SECRET",
        refreshTokenEnv: "YOUTUBE_TEST_REFRESH_TOKEN"
      }
    }
  }), {
    clientId: "client-from-env",
    clientSecret: "secret-from-env",
    refreshToken: "refresh-from-env"
  });
});

test("complete account-specific YouTube credentials do not depend on legacy aggregate JSON", (t) => {
  const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => restoreEnvironment(snapshot));
  process.env.YOUTUBE_TEST_CLIENT_ID = "client-from-env";
  process.env.YOUTUBE_TEST_CLIENT_SECRET = "secret-from-env";
  process.env.YOUTUBE_TEST_REFRESH_TOKEN = "refresh-from-env";
  process.env.SOCIAL_PROVIDER_CREDENTIALS_JSON = "{";
  resetCredentialCacheForTests();

  assert.equal(youtubeCredentials({
    accountId: "future-channel",
    account: {
      youtube: {
        clientIdEnv: "YOUTUBE_TEST_CLIENT_ID",
        clientSecretEnv: "YOUTUBE_TEST_CLIENT_SECRET",
        refreshTokenEnv: "YOUTUBE_TEST_REFRESH_TOKEN"
      }
    }
  }).refreshToken, "refresh-from-env");
});

test("YouTube check profiles are declarative and contain no credential values", (t) => {
  const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => restoreEnvironment(snapshot));
  process.env.SOCIAL_YOUTUBE_CHECKS_JSON = JSON.stringify([{
    accountId: "future-channel",
    channelId: "UC_EXPECTED",
    clientIdEnv: "YOUTUBE_TEST_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_TEST_CLIENT_SECRET",
    refreshTokenEnv: "YOUTUBE_TEST_REFRESH_TOKEN"
  }]);

  assert.deepEqual(youtubeCheckProfiles(), [{
    accountId: "future-channel",
    channelId: "UC_EXPECTED",
    clientIdEnv: "YOUTUBE_TEST_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_TEST_CLIENT_SECRET",
    refreshTokenEnv: "YOUTUBE_TEST_REFRESH_TOKEN"
  }]);
});

test("duplicate YouTube check profiles are rejected fail-closed", (t) => {
  const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => restoreEnvironment(snapshot));
  const profile = {
    accountId: "future-channel",
    channelId: "UC_EXPECTED",
    clientIdEnv: "YOUTUBE_TEST_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_TEST_CLIENT_SECRET",
    refreshTokenEnv: "YOUTUBE_TEST_REFRESH_TOKEN"
  };
  process.env.SOCIAL_YOUTUBE_CHECKS_JSON = JSON.stringify([profile, profile]);

  assert.throws(() => youtubeCheckProfiles(), (error) => error.details?.code === "YOUTUBE_CHECKS_INVALID");
});

test("scheduler exposes all dedicated Werkstern YouTube secrets in every job", async () => {
  const workflowPath = fileURLToPath(new URL("../.github/workflows/scheduler.yml", import.meta.url));
  const workflow = await fs.readFile(workflowPath, "utf8");
  const jobNames = ["publish", "loop", "check"];
  const jobStarts = jobNames.map((jobName) => {
    const start = workflow.indexOf(`\n  ${jobName}:\n`);
    assert.notEqual(start, -1, `${jobName} job must exist`);
    return start;
  });
  const secretNames = [
    "YOUTUBE_WERKSTERN_CLIENT_ID",
    "YOUTUBE_WERKSTERN_CLIENT_SECRET",
    "YOUTUBE_WERKSTERN_REFRESH_TOKEN"
  ];

  for (const [index, jobName] of jobNames.entries()) {
    const block = workflow.slice(jobStarts[index], jobStarts[index + 1] ?? workflow.length);
    for (const name of secretNames) {
      const mapping = `${name}: \${{ secrets.${name} }}`;
      assert.equal(block.split(mapping).length - 1, 1, `${name} must map exactly once in the ${jobName} job`);
    }
  }
  assert.match(workflow, /SOCIAL_YOUTUBE_CHECKS_JSON:[\s\S]*?"accountId":"werkstern"/);
  assert.match(workflow, /SOCIAL_YOUTUBE_CHECKS_JSON:[\s\S]*?"channelId":"UCj8GnTQGM6dDBdR29QRL4gQ"/);
  assert.doesNotMatch(workflow, /node publish-cloud\.mjs\s*\|\|\s*true/);
  assert.match(workflow, /failures=\$\(\(failures \+ 1\)\)/);
});
