import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fingerprint = "b".repeat(64);

test("Seeder transfers local authority before the first R2 access", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-authority-"));
  try {
    const itemsDir = path.join(temporary, "state", "items");
    await fs.mkdir(itemsDir, { recursive: true });
    const itemFile = path.join(itemsDir, `${fingerprint}.json`);
    await fs.writeFile(itemFile, JSON.stringify({
      fingerprint,
      status: "SCHEDULED",
      liveIntent: true,
      brand: "aeris",
      accountId: "aeris",
      kind: "reel",
      packageRoot: path.join(temporary, "missing-package"),
      scheduledAt: "2026-09-01T08:00:00.000Z"
    }));
    const configFile = path.join(temporary, "upload-config.json");
    await fs.writeFile(configFile, JSON.stringify({ accounts: { aeris: { displayName: "Aeris" } } }));
    const environment = { ...process.env };
    for (const name of ["SOCIAL_R2_ACCESS_KEY_ID", "SOCIAL_R2_SECRET_ACCESS_KEY", "SOCIAL_R2_ENDPOINT", "SOCIAL_R2_BUCKET_NAME", "META_R2_ACCESS_KEY_ID", "META_R2_SECRET_ACCESS_KEY", "META_R2_ENDPOINT", "META_R2_BUCKET_NAME"]) delete environment[name];
    const result = spawnSync(process.execPath, [path.join(root, "seed-cloud-queue.mjs"), "--state", path.join(temporary, "state"), "--config", configFile, "--fingerprint", fingerprint], { env: environment, encoding: "utf8", windowsHide: true });
    assert.notEqual(result.status, 0);
    const claimed = JSON.parse(await fs.readFile(itemFile, "utf8"));
    assert.equal(claimed.status, "CLOUD_SYNC_PENDING");
    assert.equal(claimed.cloudAuthority, true);
    assert.equal(claimed.preCloudStatus, "SCHEDULED");
    assert.match(result.stdout, /CLOUD_SYNC_PENDING bbbbbbbb aeris/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Seeder rejects a mismatched item filename before claiming local authority", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-filename-"));
  try {
    const itemsDir = path.join(temporary, "state", "items");
    await fs.mkdir(itemsDir, { recursive: true });
    const itemFile = path.join(itemsDir, "wrong-name.json");
    await fs.writeFile(itemFile, JSON.stringify({
      fingerprint,
      status: "SCHEDULED",
      liveIntent: true,
      brand: "aeris",
      accountId: "aeris",
      kind: "reel",
      packageRoot: path.join(temporary, "missing-package"),
      scheduledAt: "2026-09-01T08:00:00.000Z"
    }));
    const configFile = path.join(temporary, "upload-config.json");
    await fs.writeFile(configFile, JSON.stringify({ accounts: { aeris: { displayName: "Aeris" } } }));
    const result = spawnSync(process.execPath, [path.join(root, "seed-cloud-queue.mjs"), "--state", path.join(temporary, "state"), "--config", configFile, "--fingerprint", fingerprint], { encoding: "utf8", windowsHide: true });
    assert.notEqual(result.status, 0);
    const unchanged = JSON.parse(await fs.readFile(itemFile, "utf8"));
    assert.equal(unchanged.status, "SCHEDULED");
    assert.equal(unchanged.cloudAuthority, undefined);
    assert.match(`${result.stdout}\n${result.stderr}`, /stimmt nicht exakt mit dem Fingerprint ueberein/);
    assert.doesNotMatch(result.stdout, /CLOUD_SYNC_PENDING/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
