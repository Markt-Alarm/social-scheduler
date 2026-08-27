#!/usr/bin/env node
// Cloud-Runner: veroeffentlicht faellige Items aus der R2-Queue ueber die Meta Graph API.
// Aufruf: node publish-cloud.mjs [--check]
//   run   (Default): faellige Items veröffentlichen (Status SCHEDULED bzw. abgelaufene Claims).
//   --check: nur Konnektivitaet und Tokens pruefen, keine Mutationen.
// Fail-closed: Token-Werte erscheinen nie in Logs; AMBIGUOUS wird nie automatisch wiederholt.
"use strict";

import {AmbiguousMutationError, QaBlockedError, fail, getObjectText, graphConfig, headObject, presignGet, publishPlatform, putObjectText, r2Credentials, sleep} from "./cloud-lib.mjs";

const QUEUE_KEY = "scheduler/queue.json";
const LOG_PREFIX = "scheduler/logs/";
const STALE_CLAIM_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 4;

const TOKEN_ENV = {
  werkstern: "META_WERKSTERN_PAGE_ACCESS_TOKEN",
  "massage-zuhause": "META_MASSAGE_ZUHAUSE_PAGE_ACCESS_TOKEN"
};

function tokenFor(brand) {
  const name = TOKEN_ENV[brand];
  const value = name ? process.env[name] : undefined;
  if (!value || !value.trim()) fail(`access token for brand ${brand} is missing (${name ?? "unknown brand"})`);
  return value.trim();
}

async function loadQueue(credentials) {
  const text = await getObjectText(credentials, QUEUE_KEY);
  if (text === null) return { schemaVersion: 1, items: [] };
  const queue = JSON.parse(text);
  if (!Array.isArray(queue.items)) fail("queue.json has no items array");
  return queue;
}

async function saveQueue(credentials, queue) {
  await putObjectText(credentials, QUEUE_KEY, JSON.stringify(queue, null, 1));
}

async function writeRunLog(credentials, summary) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `${LOG_PREFIX}${stamp}-${Math.random().toString(36).slice(2, 8)}.json`;
  await putObjectText(credentials, key, JSON.stringify(summary, null, 1));
}

async function publishItem(credentials, queue, item) {
  const token = tokenFor(item.brand);
  item.platformStates = item.platformStates ?? {};
  for (const platform of item.platforms) {
    const initialState = item.platformStates[platform] ?? { status: "PENDING" };
    const mediaUrl = presignGet(credentials, item.media.objectKey, 3600);
    await publishPlatform({
      config: graphConfig(),
      socialPackage: { kind: item.kind, caption: item.caption, media: item.media, options: item.options ?? { instagram: { shareToFeed: true }, facebook: { title: "" } } },
      account: item.account,
      token,
      mediaUrl,
      platform,
      platformState: initialState,
      checkpoint: async (state) => {
        item.platformStates[platform] = state;
        await saveQueue(credentials, queue);
      }
    });
  }
  item.status = "PUBLISHED";
  item.publishedAt = new Date().toISOString();
}

async function run() {
  const credentials = r2Credentials();
  const queue = await loadQueue(credentials);
  const now = Date.now();
  const due = queue.items
    .filter((item) => item.status === "SCHEDULED" || (item.status === "PUBLISHING" && now - Date.parse(item.claimedAt ?? 0) > STALE_CLAIM_MS))
    .filter((item) => Date.parse(item.scheduledAt) <= now)
    .sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)));

  const summary = { startedAt: new Date().toISOString(), dueCount: due.length, results: [] };
  for (const item of due) {
    item.attempts = Number(item.attempts ?? 0) + 1;
    item.status = "PUBLISHING";
    item.claimedAt = new Date().toISOString();
    await saveQueue(credentials, queue);
    const result = { fingerprint: item.fingerprint.slice(0, 8), brand: item.brand, kind: item.kind, scheduledAt: item.scheduledAt, attempt: item.attempts };
    try {
      await publishItem(credentials, queue, item);
      result.outcome = "PUBLISHED";
    } catch (error) {
      if (error instanceof AmbiguousMutationError || error?.ambiguous) {
        item.status = "AMBIGUOUS";
        item.blockedReason = error.message;
        result.outcome = "AMBIGUOUS";
      } else if (error instanceof QaBlockedError && error.retryable && item.attempts < MAX_ATTEMPTS) {
        item.status = "SCHEDULED";
        delete item.claimedAt;
        result.outcome = "RETRY_SCHEDULED";
      } else if (error instanceof QaBlockedError && error.retryable) {
        item.status = "FAILED";
        item.blockedReason = `${error.message} (nach ${item.attempts} Versuchen)`;
        result.outcome = "FAILED";
      } else {
        item.status = "FAILED";
        item.blockedReason = error.message;
        result.outcome = "FAILED";
      }
      result.error = error.message;
      result.details = error.details ?? null;
    }
    item.updatedAt = new Date().toISOString();
    await saveQueue(credentials, queue);
    summary.results.push(result);
  }
  summary.finishedAt = new Date().toISOString();
  await writeRunLog(credentials, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
}

async function check() {
  const credentials = r2Credentials();
  const report = { r2: { endpoint: credentials.endpoint.host, bucket: credentials.bucket } };
  const queueText = await getObjectText(credentials, QUEUE_KEY);
  if (queueText === null) {
    report.queue = "leer (noch keine queue.json im Bucket)";
  } else {
    const queue = JSON.parse(queueText);
    const counts = {};
    for (const item of queue.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    report.queue = `${queue.items.length} Items (${JSON.stringify(counts)})`;
    report.naechsteTermine = queue.items
      .filter((item) => item.status === "SCHEDULED")
      .sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)))
      .slice(0, 6)
      .map((item) => `${item.scheduledAt} ${item.brand} ${item.kind}`);
  }
  const mediaProbe = queueText === null ? [] : JSON.parse(queueText).items.filter((item) => item.status === "SCHEDULED").slice(0, 2);
  report.mediaProbe = [];
  for (const item of mediaProbe) {
    const head = await headObject(credentials, item.media.objectKey);
    report.mediaProbe.push({ fingerprint: item.fingerprint.slice(0, 8), vorhanden: head.exists, bytes: head.bytes ?? 0 });
  }
  report.tokens = {};
  for (const [brand, envName] of Object.entries(TOKEN_ENV)) {
    const token = process.env[envName];
    if (!token) {
      report.tokens[brand] = "FEHLT";
      continue;
    }
    const response = await fetch(`https://graph.facebook.com/v23.0/me?fields=id&access_token=${encodeURIComponent(token.trim())}`, { signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => ({}));
    report.tokens[brand] = response.ok ? `OK (Token-Identitaet: id ${data.id})` : `ABGELEHNT (HTTP ${response.status})`;
  }
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  if (Object.values(report.tokens).some((value) => String(value).startsWith("FEHLT") || String(value).startsWith("ABGELEHNT"))) {
    process.exitCode = 1;
  }
}

const mode = process.argv.includes("--check") ? "check" : "run";
(mode === "check" ? check() : run()).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
