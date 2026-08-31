import assert from "node:assert/strict";
import test from "node:test";

import {
  accountRegistryFromConfig,
  mergeSeedItem,
  mutateQueueWithCas,
  normalizeItem,
  redactQueue
} from "../queue-store.mjs";
import { shiftItemSchedule } from "../redistribute-plan.mjs";

const fp = "a".repeat(64);

test("schema-v1 Meta item remains compatible and receives v2 targets", () => {
  const item = normalizeItem({
    schemaVersion: 1,
    fingerprint: fp,
    brand: "werkstern",
    kind: "reel",
    platforms: ["instagram", "facebook"],
    scheduledAt: "2026-09-01T08:00:00.000Z",
    platformStates: { instagram: { status: "PUBLISHED", remoteMediaId: "ig-1" }, facebook: { status: "PENDING" } }
  });
  assert.equal(item.schemaVersion, 1);
  assert.deepEqual(item.targets.map((target) => target.id), ["instagram:werkstern", "facebook:werkstern"]);
  assert.equal(item.targetStates["instagram:werkstern"].remoteMediaId, "ig-1");
  assert.equal(item.status, "PARTIAL");
});

test("legacy published item without platform checkpoints is never made publishable again", () => {
  const item = normalizeItem({
    schemaVersion: 1,
    fingerprint: fp,
    brand: "massage-zuhause",
    kind: "post",
    platforms: ["instagram", "facebook"],
    scheduledAt: "2026-08-01T08:00:00.000Z",
    status: "PUBLISHED"
  });
  assert.equal(item.status, "PUBLISHED");
  assert.ok(Object.values(item.targetStates).every((state) => state.status === "PUBLISHED"));
});

test("seeding an added YouTube target preserves successful Meta states", () => {
  const existing = {
    fingerprint: fp,
    brand: "werkstern",
    kind: "reel",
    scheduledAt: "2026-09-01T08:00:00.000Z",
    platforms: ["instagram", "facebook"],
    platformStates: { instagram: { status: "PUBLISHED", remoteMediaId: "ig-1" }, facebook: { status: "PUBLISHED", remoteMediaId: "fb-1" } }
  };
  const incoming = {
    fingerprint: fp,
    accountId: "werkstern",
    kind: "reel",
    scheduledAt: "2026-09-01T08:00:00.000Z",
    targets: [{ platform: "youtube", accountId: "werkstern" }],
    targetStates: {}
  };
  const merged = mergeSeedItem(existing, incoming);
  assert.deepEqual(merged.platforms, ["instagram", "facebook", "youtube"]);
  assert.equal(merged.targetStates["instagram:werkstern"].remoteMediaId, "ig-1");
  assert.equal(merged.targetStates["facebook:werkstern"].remoteMediaId, "fb-1");
  assert.equal(merged.targetStates["youtube:werkstern"].status, "PENDING");
  assert.equal(merged.status, "PARTIAL");
});

test("dynamic registry supports five accounts without hardcoded branches", () => {
  const accounts = Object.fromEntries(["werkstern", "massage-zuhause", "aeris", "kanal-4", "werbung"].map((id, index) => [id, { displayName: id, color: `#${String(index + 1).repeat(6)}`, purpose: id === "werbung" ? "paid" : "organic" }]));
  const registry = accountRegistryFromConfig({ accounts });
  assert.equal(Object.keys(registry).length, 5);
  assert.equal(registry.werbung.purpose, "paid");
});

test("redistribution preserves lead offsets and never moves a terminal target", () => {
  const item = {
    fingerprint: fp,
    brand: "aeris",
    accountId: "aeris",
    scheduledAt: "2026-09-01T10:00:00.000Z",
    targets: [
      { id: "youtube:aeris", platform: "youtube", actionAt: "2026-09-01T07:00:00.000Z" },
      { id: "instagram:aeris", platform: "instagram", actionAt: "2026-09-01T10:00:00.000Z" }
    ],
    targetStates: {
      "youtube:aeris": { status: "SCHEDULED", actionAt: "2026-09-01T07:00:00.000Z" },
      "instagram:aeris": { status: "PUBLISHED", actionAt: "2026-09-01T10:00:00.000Z" }
    }
  };
  shiftItemSchedule(item, "2026-09-01T12:00:00.000Z", "2026-09-01T14:00");
  assert.equal(item.targets[0].actionAt, "2026-09-01T09:00:00.000Z");
  assert.equal(item.targetStates["youtube:aeris"].actionAt, "2026-09-01T09:00:00.000Z");
  assert.equal(item.targets[1].actionAt, "2026-09-01T10:00:00.000Z");
  assert.equal(item.targetStates["instagram:aeris"].actionAt, "2026-09-01T10:00:00.000Z");
  assert.equal(item.nextActionAt, "2026-09-01T09:00:00.000Z");
});

test("dashboard redaction removes provider capabilities recursively", () => {
  const queue = redactQueue({
    items: [{ fingerprint: fp, brand: "aeris", kind: "video", scheduledAt: "2026-09-01T08:00:00.000Z", platforms: ["youtube"], targetStates: { "youtube:aeris": { status: "UPLOAD_SESSION", resumableSessionUri: "https://secret", nested: { refreshToken: "secret" } } } }]
  });
  const serialized = JSON.stringify(queue);
  assert.equal(serialized.includes("https://secret"), false);
  assert.equal(serialized.includes("refreshToken"), false);
  assert.equal(queue.items[0].targetStates["youtube:aeris"].status, "UPLOAD_SESSION");
});

test("ETag/CAS retries against the latest queue and preserves concurrent data", async () => {
  let revision = 1;
  let stored = { schemaVersion: 2, accounts: { original: { id: "original" } }, items: [] };
  let writes = 0;
  const readObject = async () => ({ text: JSON.stringify(stored), etag: `\"${revision}\"` });
  const writeObject = async (_credentials, _key, text, options) => {
    writes += 1;
    if (writes === 1) {
      stored.accounts.concurrent = { id: "concurrent" };
      revision += 1;
      return { written: false, conflict: true, status: 412 };
    }
    assert.equal(options.ifMatch, `\"${revision}\"`);
    stored = JSON.parse(text);
    revision += 1;
    return { written: true, status: 200 };
  };
  const outcome = await mutateQueueWithCas({}, (queue) => {
    queue.accounts.seeded = { id: "seeded" };
    return { value: "ok" };
  }, { readObject, writeObject, wait: async () => {} });
  assert.equal(outcome.attempts, 2);
  assert.equal(stored.accounts.original.id, "original");
  assert.equal(stored.accounts.concurrent.id, "concurrent");
  assert.equal(stored.accounts.seeded.id, "seeded");
});
