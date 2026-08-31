"use strict";

import { getObjectTextWithEtag, putObjectTextConditional, sleep } from "./cloud-lib.mjs";

export const QUEUE_KEY = "scheduler/queue.json";
export const SUPPORTED_PLATFORMS = Object.freeze(["instagram", "facebook", "youtube", "tiktok"]);
const PLATFORM_SET = new Set(SUPPORTED_PLATFORMS);
const TERMINAL_TARGET_STATUSES = new Set(["PUBLISHED", "FAILED", "AMBIGUOUS", "ACTION_REQUIRED", "CANCELLED"]);
const SECRET_KEY = /(access.?token|refresh.?token|claim.?token|client.?secret|authorization|credentials|resumable(session)?(uri)?|uploadurl|mediaurltemplate|oauth(code)?)/i;

export class QueueConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueConflictError";
    this.retryable = true;
  }
}

function clone(value) {
  return structuredClone(value);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isoOrNull(value) {
  const milliseconds = Date.parse(String(value ?? ""));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function targetId(platform, accountId) {
  return `${platform}:${accountId}`;
}

export function normalizeTargets(item) {
  const accountId = String(item.accountId ?? item.brand ?? "").trim();
  const source = Array.isArray(item.targets) && item.targets.length
    ? item.targets
    : (Array.isArray(item.platforms) ? item.platforms : []).map((platform) => ({ platform }));
  const seen = new Set();
  const targets = [];
  for (const raw of source) {
    const platform = String(typeof raw === "string" ? raw : raw?.platform ?? "").toLowerCase();
    if (!PLATFORM_SET.has(platform)) continue;
    const targetAccountId = String((typeof raw === "object" && raw?.accountId) || accountId).trim();
    if (!targetAccountId) continue;
    const id = String((typeof raw === "object" && raw?.id) || targetId(platform, targetAccountId));
    if (seen.has(id)) continue;
    seen.add(id);
    const options = plainObject(typeof raw === "object" ? raw.options : item.options?.[platform]);
    targets.push({
      ...(typeof raw === "object" ? raw : {}),
      id,
      platform,
      accountId: targetAccountId,
      options,
      actionAt: isoOrNull(typeof raw === "object" ? raw.actionAt : null)
        ?? isoOrNull(plainObject(item.targetStates)[id]?.actionAt)
        ?? isoOrNull(plainObject(item.platformStates)[platform]?.actionAt)
        ?? isoOrNull(item.scheduledAt)
    });
  }
  return targets;
}

export function normalizeTargetStates(item, targets = normalizeTargets(item)) {
  const source = plainObject(item.targetStates);
  const legacy = plainObject(item.platformStates);
  const states = {};
  const legacyItemStatus = String(item.status ?? "").toUpperCase();
  const legacyFallback = ["PUBLISHED", "FAILED", "AMBIGUOUS", "CANCELLED"].includes(legacyItemStatus) ? legacyItemStatus : "PENDING";
  for (const target of targets) {
    const candidate = plainObject(source[target.id]);
    const legacyCandidate = plainObject(legacy[target.platform]);
    const state = Object.keys(candidate).length ? candidate : legacyCandidate;
    states[target.id] = {
      status: String(state.status ?? legacyFallback).toUpperCase(),
      ...state,
      targetId: target.id,
      platform: target.platform,
      accountId: target.accountId
    };
  }
  return states;
}

export function mirrorPlatformStates(targets, targetStates) {
  const states = {};
  for (const target of targets) {
    states[target.platform] = clone(targetStates[target.id] ?? { status: "PENDING" });
  }
  return states;
}

export function aggregateItemStatus(item) {
  const targets = normalizeTargets(item);
  const states = Object.values(normalizeTargetStates(item, targets));
  if (!states.length) return String(item.status ?? "SCHEDULED").toUpperCase();
  const values = states.map((state) => String(state.status ?? "PENDING").toUpperCase());
  const has = (status) => values.includes(status);
  const all = (status) => values.every((value) => value === status);
  const somePublished = has("PUBLISHED");
  if (has("AMBIGUOUS")) return "AMBIGUOUS";
  if (all("CANCELLED")) return "CANCELLED";
  if (all("PUBLISHED")) return "PUBLISHED";
  if (has("FAILED")) return somePublished ? "PARTIAL" : (values.every((value) => value === "FAILED") ? "FAILED" : "PARTIAL");
  if (values.some((value) => !["PENDING", "SCHEDULED", "SCHEDULED_REMOTE", "RETRY_SCHEDULED", "PUBLISHED", "CANCELLED", "ACTION_REQUIRED", "WAITING_APPROVAL", "WAITING_CONFIGURATION"].includes(value))) return "PUBLISHING";
  if (values.some((value) => ["PENDING", "SCHEDULED", "SCHEDULED_REMOTE", "RETRY_SCHEDULED"].includes(value))) {
    return somePublished || has("ACTION_REQUIRED") || has("WAITING_APPROVAL") || has("WAITING_CONFIGURATION") ? "PARTIAL" : "SCHEDULED";
  }
  if (has("ACTION_REQUIRED")) return somePublished ? "PARTIAL" : "NEEDS_ACTION";
  if (has("WAITING_APPROVAL")) return somePublished ? "PARTIAL" : "WAITING_APPROVAL";
  if (has("WAITING_CONFIGURATION")) return somePublished ? "PARTIAL" : "NEEDS_CONFIGURATION";
  if (somePublished) return "PARTIAL";
  return "SCHEDULED";
}

export function normalizeItem(raw) {
  const item = clone(raw ?? {});
  item.schemaVersion = Number(item.schemaVersion ?? 1);
  item.identityVersion = Number(item.identityVersion ?? 1);
  item.accountId = String(item.accountId ?? item.brand ?? "").trim();
  item.brand = String(item.brand ?? item.accountId).trim();
  item.targets = normalizeTargets(item);
  item.platforms = [...new Set(item.targets.map((target) => target.platform))];
  item.targetStates = normalizeTargetStates(item, item.targets);
  item.platformStates = mirrorPlatformStates(item.targets, item.targetStates);
  item.status = aggregateItemStatus(item);
  return item;
}

export function normalizeQueue(raw) {
  const queue = plainObject(raw);
  return {
    ...queue,
    schemaVersion: Math.max(2, Number(queue.schemaVersion ?? 1)),
    accounts: plainObject(queue.accounts),
    items: Array.isArray(queue.items) ? queue.items.map(normalizeItem) : []
  };
}

export function accountRegistryFromConfig(config) {
  const registry = {};
  for (const [id, raw] of Object.entries(plainObject(config?.accounts))) {
    const account = plainObject(raw);
    registry[id] = {
      id,
      displayName: String(account.displayName ?? account.name ?? id),
      shortName: String(account.shortName ?? account.displayName ?? id).slice(0, 10),
      color: /^#[0-9a-f]{6}$/i.test(String(account.color ?? "")) ? account.color : "#7891b2",
      purpose: String(account.purpose ?? "organic"),
      enabled: account.enabled !== false
    };
  }
  return registry;
}

export function mergeSeedItem(existingRaw, incomingRaw) {
  const incoming = normalizeItem(incomingRaw);
  if (!existingRaw) {
    incoming.status = aggregateItemStatus(incoming);
    incoming.attempts = Number(incoming.attempts ?? 0);
    return incoming;
  }
  const existing = normalizeItem(existingRaw);
  const byId = new Map(existing.targets.map((target) => [target.id, target]));
  for (const target of incoming.targets) byId.set(target.id, { ...byId.get(target.id), ...target });
  const targets = [...byId.values()];
  const targetStates = {};
  for (const target of targets) {
    const previousState = existing.targetStates[target.id];
    const incomingState = incoming.targetStates[target.id];
    const approvalUnlocks = previousState?.status === "WAITING_APPROVAL" && target.approval && Date.parse(target.approval.expiresAt ?? 0) > Date.now();
    targetStates[target.id] = clone((approvalUnlocks ? incomingState : previousState) ?? incomingState ?? {
      status: "PENDING",
      targetId: target.id,
      platform: target.platform,
      accountId: target.accountId
    });
  }
  const merged = {
    ...existing,
    ...incoming,
    targets,
    platforms: [...new Set(targets.map((target) => target.platform))],
    targetStates,
    attempts: Number(existing.attempts ?? 0),
    firstPublishedAt: existing.firstPublishedAt ?? existing.publishedAt ?? null,
    seededAt: new Date().toISOString()
  };
  merged.platformStates = mirrorPlatformStates(targets, targetStates);
  merged.status = aggregateItemStatus(merged);
  if (merged.status !== "PUBLISHED") delete merged.publishedAt;
  return merged;
}

export function isTargetActionable(target, state, item, now = Date.now()) {
  const status = String(state?.status ?? "PENDING").toUpperCase();
  if (TERMINAL_TARGET_STATUSES.has(status) || ["WAITING_APPROVAL", "WAITING_CONFIGURATION"].includes(status)) return false;
  const actionAt = Date.parse(state?.actionAt ?? target.actionAt ?? item.nextActionAt ?? item.scheduledAt ?? 0);
  return Number.isFinite(actionAt) && actionAt <= now;
}

export function nextActionAt(item, now = Date.now()) {
  const normalized = normalizeItem(item);
  const candidates = normalized.targets
    .filter((target) => isTargetActionable(target, normalized.targetStates[target.id], normalized, Number.POSITIVE_INFINITY))
    .map((target) => Date.parse(normalized.targetStates[target.id]?.actionAt ?? target.actionAt ?? normalized.scheduledAt ?? 0))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!candidates.length) return null;
  return new Date(candidates[0]).toISOString();
}

export async function mutateQueueWithCas(credentials, mutation, options = {}) {
  const queueKey = options.queueKey ?? QUEUE_KEY;
  const attempts = Number(options.attempts ?? 8);
  const readObject = options.readObject ?? getObjectTextWithEtag;
  const writeObject = options.writeObject ?? putObjectTextConditional;
  const wait = options.wait ?? sleep;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await readObject(credentials, queueKey);
    const parsed = current === null ? {} : JSON.parse(current.text);
    const queue = normalizeQueue(parsed);
    const result = await mutation(queue);
    if (result?.changed === false) return { queue, result: result.value, attempts: attempt + 1, changed: false };
    queue.updatedAt = new Date().toISOString();
    const conditional = current === null ? { ifNoneMatch: "*" } : { ifMatch: current.etag };
    if (current !== null && !current.etag) throw new QueueConflictError("R2 lieferte keinen ETag; Queue-Update wird aus Sicherheitsgründen abgebrochen.");
    const written = await writeObject(credentials, queueKey, JSON.stringify(queue, null, 1), conditional);
    if (written.written) return { queue, result: result?.value, attempts: attempt + 1, changed: true };
    await wait(Math.min(80 * 2 ** attempt, 1200));
  }
  throw new QueueConflictError(`Queue konnte nach ${attempts} ETag/CAS-Versuchen nicht konfliktfrei gespeichert werden.`);
}

export async function mutateQueueItemWithCas(credentials, fingerprint, mutation, options = {}) {
  return mutateQueueWithCas(credentials, async (queue) => {
    const index = queue.items.findIndex((item) => item.fingerprint === fingerprint);
    if (index < 0) return { changed: false, value: null };
    const value = await mutation(queue.items[index], queue);
    if (value?.changed === false) return value;
    queue.items[index] = normalizeItem(queue.items[index]);
    return { value: value?.value ?? queue.items[index] };
  }, options);
}

export function redactQueue(queueRaw) {
  const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      output[key] = sanitize(child);
    }
    return output;
  };
  return sanitize(normalizeQueue(queueRaw));
}
