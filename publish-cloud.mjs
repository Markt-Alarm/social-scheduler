#!/usr/bin/env node
// Cloud-Runner fuer schema-v1/v2 Queue-Items. Jeder Zielkanal besitzt einen
// eigenen Zustand; Queue-Claims und Checkpoints werden per ETag/CAS gespeichert.
"use strict";

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AmbiguousMutationError, QaBlockedError, getObjectText, graphConfig, headObject, putObjectText, r2Credentials } from "./cloud-lib.mjs";
import { dispatchTarget } from "./provider-dispatch.mjs";
import { metaCredentials, tiktokCredentials, youtubeCheckProfiles, youtubeCredentials } from "./provider-credentials.mjs";
import { checkYouTubeConnection } from "./provider-youtube.mjs";
import { aggregateItemStatus, isTargetActionable, mirrorPlatformStates, mutateQueueItemWithCas, mutateQueueWithCas, normalizeItem, normalizeQueue, QUEUE_KEY, redactQueue } from "./queue-store.mjs";

const LOG_PREFIX = "scheduler/logs/";
const STALE_CLAIM_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const TERMINAL_CHECKPOINT_STATUSES = new Set(["PUBLISHED", "FAILED", "AMBIGUOUS", "ACTION_REQUIRED", "CANCELLED"]);

class ClaimLostError extends Error {
  constructor(message = "Der Queue-Claim wurde von einem neueren Runner uebernommen.") {
    super(message);
    this.name = "ClaimLostError";
  }
}

export function safeDetails(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : null;
  if (!details) return null;
  const allowed = new Set([
    "code", "httpStatus", "platform", "kind", "accountId", "expectedChannelId", "actualChannelId",
    "expected", "actual", "expectedBytes", "actualBytes", "statusCode", "uploadStatus",
    "processingStatus", "failureReason", "processingFailureReason", "rejectionReason",
    "remotePrivacyStatus", "desiredPrivacy", "index", "item", "retryAttempts"
  ]);
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (!allowed.has(key) || !["string", "number", "boolean"].includes(typeof value)) continue;
    if (typeof value === "string" && (value.length > 160 || /https?:|bearer|token|secret|authorization|[?&][^=]{1,40}=/i.test(value))) continue;
    safe[key] = value;
  }
  return Object.keys(safe).length ? safe : null;
}

async function loadQueue(credentials) {
  const text = await getObjectText(credentials, QUEUE_KEY);
  return normalizeQueue(text === null ? {} : JSON.parse(text));
}

async function writeRunLog(credentials, summary) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `${LOG_PREFIX}${stamp}-${Math.random().toString(36).slice(2, 8)}.json`;
  await putObjectText(credentials, key, JSON.stringify(summary, null, 1));
}

export function staleClaim(item, now) {
  const claimed = Date.parse(item.claimedAt ?? 0);
  if (item.claimToken) return !Number.isFinite(claimed) || now - claimed > STALE_CLAIM_MS;
  if (item.status !== "PUBLISHING") return true;
  return !Number.isFinite(claimed) || now - claimed > STALE_CLAIM_MS;
}

export function applyClaimHeartbeat(item, target, state, claimToken, heartbeatAt = new Date().toISOString()) {
  const normalized = normalizeItem(item);
  if (!claimToken || normalized.claimToken !== claimToken || normalized.targetStates[target.id]?.claimToken !== claimToken) return null;
  const durable = normalized.targetStates[target.id];
  const durableStatus = String(durable.status ?? "PENDING").toUpperCase();
  const incomingStatus = String(state?.status ?? durableStatus).toUpperCase();
  const preserveTerminal = TERMINAL_CHECKPOINT_STATUSES.has(durableStatus) && incomingStatus !== durableStatus;
  normalized.targetStates[target.id] = {
    ...durable,
    ...(preserveTerminal ? {} : state),
    targetId: target.id,
    platform: target.platform,
    accountId: target.accountId,
    claimToken,
    claimedAt: heartbeatAt,
    updatedAt: heartbeatAt
  };
  normalized.platformStates = mirrorPlatformStates(normalized.targets, normalized.targetStates);
  normalized.status = aggregateItemStatus(normalized);
  normalized.claimedAt = heartbeatAt;
  normalized.updatedAt = heartbeatAt;
  return normalized;
}

export function ownedClaimTargets(item, claimToken) {
  const normalized = normalizeItem(item);
  return normalized.targets.filter((target) => normalized.targetStates[target.id]?.claimToken === claimToken);
}

function actionableTargets(item, now) {
  const normalized = normalizeItem(item);
  return normalized.targets.filter((target) => isTargetActionable(target, normalized.targetStates[target.id], normalized, now));
}

export async function claimItem(credentials, fingerprint, now, options = {}) {
  const claimToken = randomUUID();
  const claim = await mutateQueueItemWithCas(credentials, fingerprint, (item) => {
    const normalized = normalizeItem(item);
    if (normalized.claimToken === claimToken) return { changed: false, value: normalized };
    const targets = actionableTargets(normalized, now);
    if (!staleClaim(normalized, now) || !targets.length) return { changed: false, value: null };
    normalized.attempts = Number(normalized.attempts ?? 0) + 1;
    normalized.claimedAt = new Date(now).toISOString();
    normalized.claimToken = claimToken;
    normalized.updatedAt = normalized.claimedAt;
    for (const target of targets) {
      const previous = normalized.targetStates[target.id] ?? {};
      normalized.targetStates[target.id] = {
        ...previous,
        status: "CLAIMED",
        attempts: Number(previous.attempts ?? 0) + 1,
        claimedAt: normalized.claimedAt,
        claimToken
      };
    }
    normalized.platformStates = mirrorPlatformStates(normalized.targets, normalized.targetStates);
    normalized.status = aggregateItemStatus(normalized);
    Object.assign(item, normalized);
    return { value: normalizeItem(item) };
  }, options);
  return claim.result;
}

async function checkpointTarget(credentials, fingerprint, target, state, claimToken) {
  const outcome = await mutateQueueItemWithCas(credentials, fingerprint, (item) => {
    const heartbeatAt = new Date().toISOString();
    const normalized = applyClaimHeartbeat(item, target, state, claimToken, heartbeatAt);
    if (!normalized) return { changed: false, value: { lostClaim: true } };
    Object.assign(item, normalized);
    return { value: normalized.targetStates[target.id] };
  });
  if (outcome.result === null) throw new QaBlockedError("Queue-Item verschwand vor dem Provider-Checkpoint; Mutation wird abgebrochen.", { code: "QUEUE_ITEM_MISSING" });
  if (outcome.result?.lostClaim) throw new ClaimLostError();
}

function failedState(error, state) {
  const common = { blockedReason: error.message, lastErrorAt: new Date().toISOString(), details: safeDetails(error) };
  if (error instanceof AmbiguousMutationError || error?.ambiguous) return { ...common, status: "AMBIGUOUS" };
  if (error?.approval || error?.details?.code === "WAITING_APPROVAL") return { ...common, status: "WAITING_APPROVAL" };
  if (error?.configuration || error?.details?.code === "WAITING_CONFIGURATION") return { ...common, status: "WAITING_CONFIGURATION" };
  if (["TIKTOK_PROCESSING", "YOUTUBE_PROCESSING"].includes(error?.details?.code)) return { ...common, status: "PROCESSING" };
  const retryAttempts = Number(state?.retryAttempts ?? 0) + 1;
  if (error instanceof QaBlockedError && error.retryable && retryAttempts < MAX_ATTEMPTS) return { ...common, status: "RETRY_SCHEDULED", retryAttempts };
  return { ...common, status: "FAILED" };
}

async function finishItem(credentials, fingerprint, claimToken) {
  const outcome = await mutateQueueItemWithCas(credentials, fingerprint, (item) => {
    const normalized = normalizeItem(item);
    if (!claimToken || normalized.claimToken !== claimToken) return { changed: false, value: { lostClaim: true } };
    normalized.status = aggregateItemStatus(normalized);
    delete normalized.claimedAt;
    delete normalized.claimToken;
    for (const state of Object.values(normalized.targetStates)) delete state.claimToken;
    normalized.platformStates = mirrorPlatformStates(normalized.targets, normalized.targetStates);
    if (normalized.status === "PUBLISHED") {
      normalized.publishedAt = normalized.publishedAt ?? new Date().toISOString();
      normalized.firstPublishedAt = normalized.firstPublishedAt ?? normalized.publishedAt;
    }
    normalized.updatedAt = new Date().toISOString();
    Object.assign(item, normalized);
    return { value: { status: normalized.status, targetStates: normalized.targetStates } };
  });
  if (outcome.result === null) throw new QaBlockedError("Queue-Item verschwand waehrend der Verarbeitung.", { code: "QUEUE_ITEM_MISSING" });
  if (outcome.result?.lostClaim) throw new ClaimLostError();
  return outcome.result;
}

async function publishItem(credentials, claimed) {
  const item = normalizeItem(claimed);
  const claimToken = String(claimed.claimToken ?? "");
  if (!claimToken) throw new ClaimLostError("Der Queue-Claim besitzt kein Owner-Token.");
  const targets = ownedClaimTargets(item, claimToken);
  const results = [];
  for (const target of targets) {
    let state = item.targetStates[target.id] ?? { status: "PENDING" };
    try {
      const published = await dispatchTarget({
        r2Credentials: credentials,
        item,
        target,
        state,
        checkpoint: async (nextState) => {
          state = { ...state, ...nextState };
          item.targetStates[target.id] = state;
          await checkpointTarget(credentials, item.fingerprint, target, state, claimToken);
        }
      });
      state = { ...state, ...published };
      item.targetStates[target.id] = state;
      results.push({ targetId: target.id, platform: target.platform, outcome: state.status });
    } catch (error) {
      if (error instanceof ClaimLostError) throw error;
      state = { ...state, ...failedState(error, state) };
      item.targetStates[target.id] = state;
      await checkpointTarget(credentials, item.fingerprint, target, state, claimToken);
      results.push({ targetId: target.id, platform: target.platform, outcome: state.status, error: error.message, details: safeDetails(error) });
    }
  }
  const final = await finishItem(credentials, item.fingerprint, claimToken);
  return { ...final, results };
}

async function retryWaiting(credentials) {
  const onlyFingerprint = process.argv.includes("--fingerprint") ? process.argv[process.argv.indexOf("--fingerprint") + 1] : null;
  const outcome = await mutateQueueWithCas(credentials, (queue) => {
    let changed = 0;
    for (const item of queue.items) {
      if (onlyFingerprint && item.fingerprint !== onlyFingerprint) continue;
      for (const state of Object.values(item.targetStates ?? {})) {
        if (state.status !== "WAITING_CONFIGURATION") continue;
        state.status = "PENDING";
        delete state.blockedReason;
        delete state.details;
        changed += 1;
      }
      item.status = aggregateItemStatus(item);
    }
    return changed ? { value: changed } : { changed: false, value: 0 };
  });
  process.stdout.write(`${outcome.result} Konfigurationssperre(n) zur erneuten Pruefung freigegeben.\n`);
}

async function run() {
  const credentials = r2Credentials();
  if (process.argv.includes("--retry-waiting")) await retryWaiting(credentials);
  const queue = await loadQueue(credentials);
  const now = Date.now();
  const due = queue.items
    .filter((item) => staleClaim(item, now))
    .filter((item) => actionableTargets(item, now).length)
    .sort((left, right) => String(left.nextActionAt ?? left.scheduledAt).localeCompare(String(right.nextActionAt ?? right.scheduledAt)));
  const summary = { startedAt: new Date().toISOString(), dueCount: due.length, results: [] };
  for (const candidate of due) {
    const claimed = await claimItem(credentials, candidate.fingerprint, Date.now());
    if (!claimed) continue;
    const result = { fingerprint: claimed.fingerprint.slice(0, 8), accountId: claimed.accountId, kind: claimed.kind, scheduledAt: claimed.scheduledAt, attempt: claimed.attempts };
    try {
      const published = await publishItem(credentials, claimed);
      result.outcome = published.status;
      result.targets = published.results;
    } catch (error) {
      result.outcome = error instanceof ClaimLostError ? "CLAIM_LOST" : "RUNNER_ERROR";
      result.error = error.message;
      result.details = safeDetails(error);
      if (!(error instanceof ClaimLostError)) await finishItem(credentials, claimed.fingerprint, claimed.claimToken).catch(() => {});
    }
    summary.results.push(result);
  }
  summary.finishedAt = new Date().toISOString();
  await writeRunLog(credentials, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
}

export async function check({ writeOutput = true } = {}) {
  const credentials = r2Credentials();
  const queue = await loadQueue(credentials);
  const report = {
    r2: { status: "OK" },
    queue: { items: queue.items.length, schemaVersion: queue.schemaVersion, counts: {} },
    accounts: {},
    mediaProbe: []
  };
  for (const item of queue.items) report.queue.counts[item.status] = (report.queue.counts[item.status] ?? 0) + 1;
  for (const item of queue.items.filter((candidate) => candidate.status === "SCHEDULED").slice(0, 2)) {
    const probeKey = item.media.objectKey ?? item.media.slides?.[0]?.objectKey;
    const head = await headObject(credentials, probeKey);
    report.mediaProbe.push({ fingerprint: item.fingerprint.slice(0, 8), vorhanden: head.exists, bytes: head.bytes ?? 0 });
  }
  const youtubeBindings = new Map();
  const addYouTubeBinding = ({ accountId, channelId, config, item }) => {
    const key = JSON.stringify([
      accountId,
      channelId,
      config?.clientIdEnv ?? "",
      config?.clientSecretEnv ?? "",
      config?.refreshTokenEnv ?? "",
      config?.enabled === false
    ]);
    if (!youtubeBindings.has(key)) youtubeBindings.set(key, { accountId, channelId, config, item });
  };
  for (const profile of youtubeCheckProfiles()) {
    addYouTubeBinding({
      accountId: profile.accountId,
      channelId: profile.channelId,
      config: profile,
      item: { accountId: profile.accountId, account: { youtube: profile } }
    });
  }
  for (const item of queue.items) {
    for (const target of item.targets.filter((candidate) => candidate.platform === "youtube")) {
      const config = item.account?.youtube ?? {};
      addYouTubeBinding({
        accountId: target.accountId,
        channelId: config.channelId ?? target.channelId,
        config,
        item
      });
    }
  }
  for (const binding of youtubeBindings.values()) {
    const account = (report.accounts[binding.accountId] ??= {});
    let outcome = "OK";
    try {
      if (binding.config?.enabled === false) throw new QaBlockedError("YouTube ist deaktiviert.", { code: "WAITING_CONFIGURATION" });
      await checkYouTubeConnection({
        credentials: youtubeCredentials(binding.item),
        expectedChannelId: binding.channelId
      });
    } catch {
      outcome = "FEHLT";
    }
    account.youtube = account.youtube === "FEHLT" || outcome === "FEHLT" ? "FEHLT" : "OK";
  }
  for (const item of queue.items) {
    const account = (report.accounts[item.accountId] ??= {});
    for (const platform of item.platforms) {
      if (platform === "youtube") continue;
      if (account[platform]) continue;
      try {
        if (["instagram", "facebook"].includes(platform)) {
          const token = metaCredentials(item).accessToken;
          const api = graphConfig().graphApi;
          const response = await fetch(`${api.baseUrl}/${api.version}/me?fields=id`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
          account[platform] = response.ok ? "OK" : `ABGELEHNT (HTTP ${response.status})`;
          await response.body?.cancel().catch(() => {});
        } else if (platform === "tiktok") {
          tiktokCredentials(item);
          account[platform] = "CREDENTIALS_VORHANDEN";
        }
      } catch {
        account[platform] = "FEHLT";
      }
    }
  }
  const safeReport = redactQueue({ schemaVersion: 2, items: [], report }).report;
  const failed = Object.values(report.accounts).some((account) => Object.values(account).some((value) => value === "FEHLT" || String(value).startsWith("ABGELEHNT")));
  if (writeOutput) process.stdout.write(`${JSON.stringify(safeReport, null, 1)}\n`);
  if (failed) process.exitCode = 1;
  return { report: safeReport, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv.includes("--check") ? "check" : "run";
  (mode === "check" ? check() : run()).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
