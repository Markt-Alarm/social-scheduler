import assert from "node:assert/strict";
import test from "node:test";

import { applyClaimHeartbeat, claimItem, ownedClaimTargets, staleClaim } from "../publish-cloud.mjs";

test("claim heartbeat renews the lease and rejects checkpoints from an old runner", () => {
  const claimToken = "claim-owner-a";
  const target = { id: "youtube:aeris", platform: "youtube", accountId: "aeris", actionAt: "2026-08-31T08:00:00.000Z" };
  const failedTarget = { id: "instagram:aeris", platform: "instagram", accountId: "aeris", actionAt: "2026-08-31T08:00:00.000Z" };
  const item = {
    schemaVersion: 2,
    fingerprint: "d".repeat(64),
    brand: "aeris",
    accountId: "aeris",
    kind: "video",
    scheduledAt: "2026-08-31T08:00:00.000Z",
    targets: [target, failedTarget],
    targetStates: {
      [target.id]: { status: "CLAIMED", claimToken, claimedAt: "2026-08-31T08:00:00.000Z" },
      [failedTarget.id]: { status: "AMBIGUOUS", claimedAt: "2026-08-31T07:00:00.000Z" }
    },
    status: "AMBIGUOUS",
    claimToken,
    claimedAt: "2026-08-31T08:00:00.000Z"
  };
  const heartbeatAt = "2026-08-31T08:19:00.000Z";
  const renewed = applyClaimHeartbeat(item, target, { status: "UPLOADING", nextByte: 8388608 }, claimToken, heartbeatAt);
  assert.equal(renewed.claimedAt, heartbeatAt);
  assert.equal(renewed.targetStates[target.id].claimedAt, heartbeatAt);
  assert.equal(renewed.targetStates[target.id].nextByte, 8388608);
  assert.equal(renewed.status, "AMBIGUOUS");
  assert.equal(staleClaim(renewed, Date.parse(heartbeatAt) + 19 * 60_000), false);
  assert.equal(staleClaim(renewed, Date.parse(heartbeatAt) + 21 * 60_000), true);
  assert.equal(applyClaimHeartbeat(renewed, target, { status: "PUBLISHED" }, "old-runner", "2026-08-31T08:20:00.000Z"), null);
  assert.equal(renewed.targetStates[target.id].status, "UPLOADING");
});

test("runner processes only targets owned by its claim and cannot undo an external confirmation", () => {
  const claimToken = "claim-owner-b";
  const inbox = { id: "tiktok:aeris", platform: "tiktok", accountId: "aeris", actionAt: "2026-08-31T08:00:00.000Z" };
  const becameDueAfterClaim = { id: "instagram:aeris", platform: "instagram", accountId: "aeris", actionAt: "2026-08-31T08:00:00.001Z" };
  const externallyConfirmed = {
    schemaVersion: 2,
    fingerprint: "e".repeat(64),
    brand: "aeris",
    accountId: "aeris",
    kind: "reel",
    scheduledAt: "2026-08-31T08:00:00.000Z",
    targets: [inbox, becameDueAfterClaim],
    targetStates: {
      [inbox.id]: { status: "PUBLISHED", claimToken, remoteMediaId: "tt-post-1" },
      [becameDueAfterClaim.id]: { status: "PENDING" }
    },
    status: "PARTIAL",
    claimToken,
    claimedAt: "2026-08-31T08:00:00.000Z"
  };
  assert.deepEqual(ownedClaimTargets(externallyConfirmed, claimToken).map((target) => target.id), [inbox.id]);
  const afterLateRunnerCheckpoint = applyClaimHeartbeat(
    externallyConfirmed,
    inbox,
    { status: "ACTION_REQUIRED", action: "TIKTOK_COMPLETE_IN_APP" },
    claimToken,
    "2026-08-31T08:01:00.000Z"
  );
  assert.equal(afterLateRunnerCheckpoint.targetStates[inbox.id].status, "PUBLISHED");
  assert.equal(afterLateRunnerCheckpoint.targetStates[inbox.id].remoteMediaId, "tt-post-1");
  assert.equal(afterLateRunnerCheckpoint.targetStates[inbox.id].action, undefined);
});

test("claim acquisition recovers its own durable claim after a lost write acknowledgement", async () => {
  const fingerprint = "f".repeat(64);
  let etag = '"queue-1"';
  let queue = {
    schemaVersion: 2,
    items: [{
      schemaVersion: 2,
      fingerprint,
      brand: "aeris",
      accountId: "aeris",
      kind: "video",
      scheduledAt: "2026-08-31T08:00:00.000Z",
      targets: [{ id: "youtube:aeris", platform: "youtube", accountId: "aeris", actionAt: "2026-08-31T08:00:00.000Z" }],
      targetStates: { "youtube:aeris": { status: "PENDING", actionAt: "2026-08-31T08:00:00.000Z" } },
      status: "SCHEDULED"
    }]
  };
  let writes = 0;
  const claimed = await claimItem({}, fingerprint, Date.parse("2026-08-31T08:01:00.000Z"), {
    readObject: async () => ({ text: JSON.stringify(queue), etag }),
    writeObject: async (_credentials, _key, text) => {
      writes += 1;
      queue = JSON.parse(text);
      etag = '"queue-2"';
      return { written: false, conflict: true, status: 412 };
    },
    wait: async () => {}
  });
  assert.equal(writes, 1);
  assert.match(claimed.claimToken, /^[0-9a-f-]{36}$/i);
  assert.equal(queue.items[0].claimToken, claimed.claimToken);
  assert.equal(claimed.targetStates["youtube:aeris"].claimToken, claimed.claimToken);
  assert.equal(claimed.targetStates["youtube:aeris"].status, "CLAIMED");
});
