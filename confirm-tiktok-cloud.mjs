#!/usr/bin/env node
// Operator-controlled completion of a TikTok inbox handoff in the cloud queue.
// The mutation is idempotent and uses the same R2 ETag/CAS protection as the
// scheduler so a lost CLI response cannot create a conflicting state.
"use strict";

import { QaBlockedError, r2Credentials } from "./cloud-lib.mjs";
import { aggregateItemStatus, mirrorPlatformStates, mutateQueueItemWithCas, normalizeItem } from "./queue-store.mjs";
import { pathToFileURL } from "node:url";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function validateFingerprint(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new QaBlockedError("--fingerprint muss ein 64-stelliger SHA-256-Wert sein.");
  return normalized;
}

function validateTikTokUrl(raw) {
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new QaBlockedError("--url muss eine gueltige TikTok-HTTPS-URL sein.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !/(^|\.)tiktok\.com$/i.test(url.hostname)) {
    throw new QaBlockedError("--url muss einen offiziellen tiktok.com-Host verwenden.");
  }
  return url.toString();
}

export function confirmTikTokInboxItem(rawItem, options = {}) {
  const item = normalizeItem(rawItem);
  const accountId = options.accountId ? String(options.accountId) : null;
  const tiktokTargets = item.targets.filter((target) => target.platform === "tiktok" && (!accountId || target.accountId === accountId));
  const waiting = tiktokTargets.filter((target) => item.targetStates[target.id]?.status === "ACTION_REQUIRED");
  if (waiting.length > 1) throw new QaBlockedError("Mehrere TikTok-Ziele warten; --account ist zur eindeutigen Auswahl erforderlich.");
  if (!waiting.length) {
    const confirmed = tiktokTargets.find((target) => {
      const state = item.targetStates[target.id];
      return state?.status === "PUBLISHED" && state.confirmedBy === "operator";
    });
    if (confirmed) return { changed: false, item, target: confirmed, targetState: item.targetStates[confirmed.id], alreadyConfirmed: true };
    throw new QaBlockedError("Kein TikTok-Inbox-Ziel wartet auf die manuelle Veroeffentlichungsbestaetigung.");
  }
  const target = waiting[0];
  const confirmedAt = new Date(options.confirmedAt ?? Date.now()).toISOString();
  const next = {
    ...item.targetStates[target.id],
    status: "PUBLISHED",
    publishedAt: confirmedAt,
    confirmedBy: "operator",
    ...(options.remoteMediaId ? { remoteMediaId: String(options.remoteMediaId).trim() } : {}),
    ...(options.publishedUrl ? { publishedUrl: options.publishedUrl } : {})
  };
  delete next.action;
  delete next.blockedReason;
  delete next.details;
  delete next.claimToken;
  delete next.claimedAt;
  item.targetStates[target.id] = next;
  item.platformStates = mirrorPlatformStates(item.targets, item.targetStates);
  item.status = aggregateItemStatus(item);
  item.updatedAt = confirmedAt;
  if (item.status === "PUBLISHED") item.publishedAt = item.publishedAt ?? confirmedAt;
  return { changed: true, item, target, targetState: next, alreadyConfirmed: false };
}

export function publicConfirmationResult({ alreadyConfirmed, itemStatus, targetState }) {
  const state = targetState && typeof targetState === "object" ? targetState : {};
  return {
    alreadyConfirmed: alreadyConfirmed === true,
    itemStatus: String(itemStatus ?? ""),
    targetState: {
      status: String(state.status ?? ""),
      ...(state.publishedAt ? { publishedAt: String(state.publishedAt) } : {}),
      ...(state.remoteMediaId ? { remoteMediaId: String(state.remoteMediaId) } : {})
    }
  };
}

async function main() {
  if (!flag("confirm")) throw new QaBlockedError("Manuelle TikTok-Bestaetigung erfordert --confirm.");
  const fingerprint = validateFingerprint(arg("fingerprint"));
  const publishedUrl = validateTikTokUrl(arg("url"));
  const remoteMediaId = String(arg("post-id") ?? "").trim() || undefined;
  const accountId = String(arg("account") ?? "").trim() || undefined;
  const credentials = r2Credentials();
  const outcome = await mutateQueueItemWithCas(credentials, fingerprint, (queueItem) => {
    const confirmation = confirmTikTokInboxItem(queueItem, { accountId, publishedUrl, remoteMediaId });
    const value = publicConfirmationResult({
      alreadyConfirmed: !confirmation.changed,
      itemStatus: confirmation.item.status,
      targetState: confirmation.targetState
    });
    if (!confirmation.changed) {
      return { changed: false, value };
    }
    Object.assign(queueItem, confirmation.item);
    return { value };
  });
  if (outcome.result === null) throw new QaBlockedError("Cloud-Queue enthaelt diesen Fingerprint nicht.");
  process.stdout.write(`${JSON.stringify({ ok: true, fingerprint, ...outcome.result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 2;
  });
}
