// Gemeinsame Bibliothek fuer den PC-unabhaengigen Publisher:
// R2-Speicher (AWS-SigV4) + Meta-Graph-Publishing (Port aus dem upload-Skill).
// Laeuft ohne npm-Abhaengigkeiten auf Node 20+ (GitHub Actions, lokal).
"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";

export class QaBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "QaBlockedError";
    this.details = details;
    this.retryable = false;
  }
}
export class AmbiguousMutationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AmbiguousMutationError";
    this.details = details;
    this.ambiguous = true;
  }
}
export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function fail(message) {
  process.stderr.write(`QA_BLOCKED: ${message}\n`);
  process.exit(2);
}

// ---------- R2 (S3-SigV4) ----------

const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");
const CONTENT_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"]
]);

export function r2Credentials() {
  const accessKeyId = process.env.META_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.META_R2_SECRET_ACCESS_KEY;
  const endpointRaw = process.env.META_R2_ENDPOINT;
  const bucket = process.env.META_R2_BUCKET_NAME;
  if (![accessKeyId, secretAccessKey, endpointRaw, bucket].every((value) => typeof value === "string" && value.trim())) {
    fail("required R2 environment variables are missing");
  }
  let endpoint;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    fail("R2 endpoint is invalid");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket.trim())) fail("R2 bucket name is invalid");
  return { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), endpoint, bucket: bucket.trim() };
}

export function contentTypeFor(extension) {
  return CONTENT_TYPES.get(String(extension).toLowerCase());
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function awsTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function objectUri(bucket, objectKey) {
  return `/${awsEncode(bucket)}/${objectKey.split("/").map(awsEncode).join("/")}`;
}

function signString(secret, dateStamp, stringToSign) {
  const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
  const dateKey = hmac(Buffer.from(`AWS4${secret}`), dateStamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  return crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

function backoff(attempt) {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 15000);
  return base + Math.floor(Math.random() * Math.max(100, base * 0.25));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lowercaseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function normalizeHeader(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

async function signedFetch(credentials, request) {
  const now = new Date();
  const amzDate = awsTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = objectUri(credentials.bucket, request.objectKey);
  const headers = {
    ...lowercaseHeaders(request.headers ?? {}),
    host: credentials.endpoint.host,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate
  };
  const signedHeaderNames = Object.keys(headers).filter((name) => name !== "content-length").sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${normalizeHeader(headers[name])}\n`).join("");
  const canonicalRequest = [request.method, canonicalUri, "", canonicalHeaders, signedHeaderNames.join(";"), request.payloadHash].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Text(canonicalRequest)].join("\n");
  const signature = signString(credentials.secretAccessKey, dateStamp, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;
  const url = new URL(canonicalUri, credentials.endpoint);
  return fetch(url, {
    method: request.method,
    headers: { ...headers, authorization },
    body: request.body,
    duplex: request.body && typeof request.body.pipe === "function" ? "half" : undefined,
    signal: AbortSignal.timeout(180000)
  });
}

async function signedFetchWithRetry(credentials, request) {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    try {
      const response = await signedFetch(credentials, request);
      lastStatus = response.status;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) return response;
      await response.body?.cancel().catch(() => {});
    } catch {
      if (attempt === 4) fail("R2 request failed at network level");
    }
    await delay(backoff(attempt + 1));
  }
  fail(`R2 request exhausted safe retries after HTTP ${lastStatus}`);
}

export async function headObject(credentials, objectKey) {
  const response = await signedFetchWithRetry(credentials, {
    method: "HEAD",
    objectKey,
    payloadHash: EMPTY_SHA256
  });
  if (response.status === 404) return { exists: false };
  if (!response.ok) fail(`R2 HEAD returned HTTP ${response.status}`);
  const bytes = Number(response.headers.get("content-length"));
  return {
    exists: true,
    bytes: Number.isSafeInteger(bytes) ? bytes : -1,
    sha256: response.headers.get("x-amz-meta-sha256") ?? ""
  };
}

export async function putObjectFile(credentials, upload) {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    if (attempt > 0) {
      const reconciled = await headObject(credentials, upload.objectKey);
      if (reconciled.exists && reconciled.sha256 === upload.sha256 && reconciled.bytes === upload.bytes) return;
      await delay(backoff(attempt));
    }
    const body = fs.createReadStream(upload.file);
    let response;
    try {
      response = await signedFetch(credentials, {
        method: "PUT",
        objectKey: upload.objectKey,
        payloadHash: upload.sha256,
        headers: {
          "content-length": String(upload.bytes),
          "content-type": upload.contentType,
          "x-amz-meta-sha256": upload.sha256
        },
        body
      });
    } catch {
      body.destroy();
      if (attempt === 4) fail("R2 PUT failed at network level");
      continue;
    }
    lastStatus = response.status;
    await response.body?.cancel().catch(() => {});
    if (response.ok) return;
    if (![429, 500, 502, 503, 504].includes(response.status)) fail(`R2 PUT returned HTTP ${response.status}`);
  }
  fail(`R2 PUT exhausted safe retries after HTTP ${lastStatus}`);
}

export async function getObjectText(credentials, objectKey) {
  const response = await signedFetchWithRetry(credentials, {
    method: "GET",
    objectKey,
    payloadHash: EMPTY_SHA256
  });
  if (response.status === 404) return null;
  if (!response.ok) fail(`R2 GET returned HTTP ${response.status}`);
  return await response.text();
}

export async function putObjectText(credentials, objectKey, text, contentType = "application/json") {
  const payload = Buffer.from(text, "utf8");
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const response = await signedFetchWithRetry(credentials, {
    method: "PUT",
    objectKey,
    payloadHash: sha256,
    headers: {
      "content-length": String(payload.byteLength),
      "content-type": contentType
    },
    body: payload
  });
  if (!response.ok) fail(`R2 PUT returned HTTP ${response.status}`);
  await response.body?.cancel().catch(() => {});
}

export function presignGet(credentials, objectKey, ttlSeconds) {
  const now = new Date();
  const amzDate = awsTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = objectUri(credentials.bucket, objectKey);
  const query = new Map([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(ttlSeconds)],
    ["X-Amz-SignedHeaders", "host"]
  ]);
  const canonicalQuery = [...query.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = ["GET", canonicalUri, canonicalQuery, `host:${credentials.endpoint.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Text(canonicalRequest)].join("\n");
  const signature = signString(credentials.secretAccessKey, dateStamp, stringToSign);
  return `${new URL(canonicalUri, credentials.endpoint)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---------- Meta Graph Publishing (Port aus dem upload-Skill) ----------

export function graphConfig() {
  return {
    graphApi: {
      baseUrl: "https://graph.facebook.com",
      version: "v23.0",
      requestTimeoutSeconds: 45,
      pollIntervalSeconds: 20,
      pollTimeoutSeconds: 300,
      maxSafeRetries: 4,
      baseBackoffMs: 1000
    }
  };
}

async function withSafeRetry(operation, graphApi, onRetry = async () => {}) {
  let lastError;
  for (let attempt = 0; attempt <= graphApi.maxSafeRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!error.retryable) throw error;
      lastError = error;
      if (attempt < graphApi.maxSafeRetries) {
        const wait = Math.max(Number(error.retryAfterMs) || 0, graphApi.baseBackoffMs * 2 ** attempt);
        await onRetry(error, attempt + 1, wait);
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

function makeContext(config, token) {
  return {
    config,
    token,
    graphUrl(objectId, edge = "") {
      const suffix = edge ? `/${edge}` : "";
      return `${config.graphApi.baseUrl}/${config.graphApi.version}/${encodeURIComponent(objectId)}${suffix}`;
    }
  };
}

async function graphFetch(context, request) {
  const url = new URL(request.url);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value));
  const body = request.form ? new URLSearchParams(Object.entries(request.form).filter(([, value]) => value !== undefined && value !== "")) : undefined;
  return fetch(url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${context.token}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    },
    body,
    signal: AbortSignal.timeout(context.config.graphApi.requestTimeoutSeconds * 1000)
  });
}

async function graphErrorDetails(response) {
  let data = {};
  try {
    data = await response.json();
  } catch {}
  const meta = data?.error ?? {};
  return {
    metaType: typeof meta.type === "string" ? meta.type : undefined,
    metaCode: Number.isFinite(meta.code) ? meta.code : undefined,
    metaSubcode: Number.isFinite(meta.error_subcode) ? meta.error_subcode : undefined,
    metaMessage: typeof meta.message === "string" ? meta.message.slice(0, 500) : undefined
  };
}

async function graphHttpError(response, label, safeToRetry) {
  const details = await graphErrorDetails(response);
  const error = new QaBlockedError(`${label} was rejected by Meta.`, { httpStatus: response.status, ...details });
  error.retryable = Boolean(safeToRetry && (response.status === 429 || response.status >= 500));
  const retryAfter = response.headers.get("retry-after");
  error.retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
  return error;
}

async function parseJsonResponse(response, label) {
  try {
    return await response.json();
  } catch {
    throw new QaBlockedError(`${label} returned a non-JSON success response.`);
  }
}

async function safeGraphRequest(context, request) {
  return withSafeRetry(async () => {
    const response = await graphFetch(context, request).catch(() => {
      const error = new Error(`${request.label} failed at network level.`);
      error.retryable = true;
      throw error;
    });
    if (!response.ok) throw await graphHttpError(response, request.label, true);
    return parseJsonResponse(response, request.label);
  }, context.config.graphApi);
}

async function publishMutationOnce(context, request) {
  let response;
  try {
    response = await graphFetch(context, request);
  } catch {
    throw new AmbiguousMutationError(`${request.label} had an ambiguous network outcome.`);
  }
  if (!response.ok) {
    const parsed = await graphErrorDetails(response);
    if (response.status === 429 || response.status >= 500) {
      throw new AmbiguousMutationError(`${request.label} returned an ambiguous HTTP ${response.status}.`, parsed);
    }
    throw new QaBlockedError(`${request.label} was rejected by Meta.`, { httpStatus: response.status, ...parsed });
  }
  return parseJsonResponse(response, request.label);
}

async function pollInstagramContainer(context, containerId, { allowFinished = true } = {}) {
  const deadline = Date.now() + context.config.graphApi.pollTimeoutSeconds * 1000;
  let last = { statusCode: "UNKNOWN" };
  while (Date.now() <= deadline) {
    const data = await safeGraphRequest(context, {
      method: "GET",
      url: context.graphUrl(containerId),
      query: { fields: "status_code,status" },
      label: "Instagram container status"
    });
    const statusCode = String(data.status_code ?? "UNKNOWN").toUpperCase();
    last = { statusCode };
    if (statusCode === "PUBLISHED" || (allowFinished && statusCode === "FINISHED")) return last;
    if (["ERROR", "EXPIRED"].includes(statusCode)) {
      throw new QaBlockedError("Instagram container entered a terminal failure state.", { containerId, statusCode });
    }
    await sleep(context.config.graphApi.pollIntervalSeconds * 1000);
  }
  return last;
}

function blockUnresolvedRequest(state, label) {
  if (state.publishPhase === "REQUESTING" || state.publishPhase === "AMBIGUOUS") {
    throw new AmbiguousMutationError(`${label} has an unresolved prior publish request.`);
  }
}

async function reconcileInstagramAmbiguity(context, state, save) {
  if (!state.containerId) {
    await save({ status: "AMBIGUOUS", publishPhase: "AMBIGUOUS" });
    throw new AmbiguousMutationError("Instagram publish checkpoint lacks a container ID.");
  }
  const result = await pollInstagramContainer(context, state.containerId, { allowFinished: false });
  if (result.statusCode === "PUBLISHED") {
    await save({ status: "PUBLISHED", publishPhase: "CONFIRMED_BY_STATUS", publishedAt: new Date().toISOString() });
    return;
  }
  await save({ status: "AMBIGUOUS", publishPhase: "AMBIGUOUS", lastContainerStatus: result.statusCode });
  throw new AmbiguousMutationError("Instagram publish outcome is not definitive; refusing automatic replay.", { containerId: state.containerId, statusCode: result.statusCode });
}

async function publishInstagram(context, socialPackage, account, mediaUrl, initialState, checkpoint) {
  let state = { ...initialState };
  const save = async (patch) => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await checkpoint(state);
  };
  if (state.publishPhase === "REQUESTING") {
    await reconcileInstagramAmbiguity(context, state, save);
    if (state.status === "PUBLISHED") return state;
  }
  if (!state.containerId) {
    const form = socialPackage.kind === "story" ? {} : { caption: socialPackage.caption };
    if (socialPackage.kind === "post") form.image_url = mediaUrl;
    else if (socialPackage.kind === "story") {
      const imageStory = /\.jpe?g$/i.test(socialPackage.media.path ?? "");
      if (imageStory) form.image_url = mediaUrl;
      else form.video_url = mediaUrl;
      form.media_type = "STORIES";
    } else {
      form.video_url = mediaUrl;
      form.media_type = socialPackage.kind === "reel" ? "REELS" : "VIDEO";
      if (socialPackage.kind === "reel") form.share_to_feed = String(socialPackage.options.instagram.shareToFeed);
    }
    const response = await safeGraphRequest(context, {
      method: "POST",
      url: context.graphUrl(account.instagramAccountId, "media"),
      form,
      label: "Instagram container creation"
    });
    if (!response.id) throw new QaBlockedError("Instagram container creation returned no id.");
    await save({ status: "CONTAINER_CREATED", containerId: String(response.id), containerCreatedAt: new Date().toISOString() });
  }

  const containerStatus = await pollInstagramContainer(context, state.containerId);
  await save({ lastContainerStatus: containerStatus.statusCode, lastContainerStatusAt: new Date().toISOString() });
  if (containerStatus.statusCode === "PUBLISHED") {
    await save({ status: "PUBLISHED", publishedAt: new Date().toISOString(), recoveredFromContainerStatus: true });
    return state;
  }
  if (containerStatus.statusCode !== "FINISHED") {
    throw new QaBlockedError("Instagram container did not become publishable.", { containerId: state.containerId, statusCode: containerStatus.statusCode });
  }

  await save({ status: "SUBMITTING", publishPhase: "REQUESTING", publishRequestedAt: new Date().toISOString() });
  let response;
  try {
    response = await publishMutationOnce(context, {
      method: "POST",
      url: context.graphUrl(account.instagramAccountId, "media_publish"),
      form: { creation_id: state.containerId },
      label: "Instagram media publish"
    });
  } catch (error) {
    if (error.ambiguous) await save({ status: "AMBIGUOUS", publishPhase: "AMBIGUOUS", blockedReason: error.message });
    throw error;
  }
  if (!response.id) throw new QaBlockedError("Instagram media publish returned no media id.");
  await save({ status: "PUBLISHED", publishPhase: "CONFIRMED", remoteMediaId: String(response.id), publishedAt: new Date().toISOString() });
  return state;
}

async function publishFacebookPhoto(context, socialPackage, account, mediaUrl, initialState, checkpoint) {
  let state = { ...initialState };
  const save = async (patch) => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await checkpoint(state);
  };
  blockUnresolvedRequest(state, "Facebook photo");
  await save({ status: "SUBMITTING", publishPhase: "REQUESTING", publishRequestedAt: new Date().toISOString() });
  let response;
  try {
    response = await publishMutationOnce(context, {
      method: "POST",
      url: context.graphUrl(account.pageId, "photos"),
      form: { url: mediaUrl, caption: socialPackage.caption, published: "true" },
      label: "Facebook photo publish"
    });
  } catch (error) {
    if (error.ambiguous) await save({ status: "AMBIGUOUS", publishPhase: "AMBIGUOUS", blockedReason: error.message });
    throw error;
  }
  if (!response.id && !response.post_id) throw new QaBlockedError("Facebook photo publish returned no object id.");
  await save({ status: "PUBLISHED", publishPhase: "CONFIRMED", remoteMediaId: String(response.post_id ?? response.id), publishedAt: new Date().toISOString() });
  return state;
}

function normalizeVideoStatus(status) {
  const values = [];
  (function collect(value, key = "") {
    if (typeof value === "string" && /status|phase/i.test(key)) values.push(value.toLowerCase());
    else if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) collect(childValue, childKey);
    }
  })(status);
  const failed = values.some((value) => ["error", "failed", "expired"].includes(value));
  const root = status && typeof status === "object" ? status : {};
  const publishing = String(root.publishing_phase?.status ?? "").toLowerCase();
  const processing = String(root.processing_phase?.status ?? "").toLowerCase();
  const videoStatus = String(root.video_status ?? root.status ?? "").toLowerCase();
  const complete = !failed && (
    ["complete", "completed", "published"].includes(publishing) ||
    (["ready", "published"].includes(videoStatus) && (!processing || ["complete", "completed"].includes(processing)))
  );
  return { complete, failed, summary: values.slice(0, 12).join(",") || "UNKNOWN" };
}

async function getFacebookVideoStatus(context, videoId) {
  const data = await safeGraphRequest(context, {
    method: "GET",
    url: context.graphUrl(videoId),
    query: { fields: "status" },
    label: "Facebook video status"
  });
  return normalizeVideoStatus(data.status ?? data);
}

async function pollFacebookVideo(context, videoId) {
  if (!videoId) throw new AmbiguousMutationError("Cannot reconcile Facebook video without videoId.");
  const deadline = Date.now() + context.config.graphApi.pollTimeoutSeconds * 1000;
  let result = { complete: false, failed: false, summary: "UNKNOWN" };
  while (Date.now() <= deadline) {
    result = await getFacebookVideoStatus(context, videoId);
    if (result.failed) throw new QaBlockedError("Facebook video entered a terminal failure state.", { videoId, status: result.summary });
    if (result.complete) return result;
    await sleep(context.config.graphApi.pollIntervalSeconds * 1000);
  }
  return result;
}

async function publishFacebookVideo(context, socialPackage, account, mediaUrl, initialState, checkpoint) {
  let state = { ...initialState };
  const save = async (patch) => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await checkpoint(state);
  };
  if (!state.videoId) {
    blockUnresolvedRequest(state, "Facebook video");
    await save({ status: "SUBMITTING", publishPhase: "REQUESTING", publishRequestedAt: new Date().toISOString() });
    let response;
    try {
      response = await publishMutationOnce(context, {
        method: "POST",
        url: context.graphUrl(account.pageId, "videos"),
        form: { file_url: mediaUrl, description: socialPackage.caption, published: "true" },
        label: "Facebook Page video publish"
      });
    } catch (error) {
      if (error.ambiguous) await save({ status: "AMBIGUOUS", publishPhase: "AMBIGUOUS", blockedReason: error.message });
      throw error;
    }
    if (!response.id) throw new QaBlockedError("Facebook video publish returned no video id.");
    await save({ status: "SUBMITTED", publishPhase: "CONFIRMED", videoId: String(response.id) });
  }
  const result = await pollFacebookVideo(context, state.videoId);
  if (!result.complete) throw new QaBlockedError("Facebook video processing did not complete before polling timeout.", { videoId: state.videoId });
  await save({ status: "PUBLISHED", remoteMediaId: state.videoId, lastVideoStatus: result.summary, publishedAt: new Date().toISOString() });
  return state;
}

function validateRuploadUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new QaBlockedError("Facebook returned an invalid Reel upload URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "rupload.facebook.com") {
    throw new QaBlockedError("Facebook returned an unexpected Reel upload host.", { hostname: url.hostname });
  }
  return url.toString();
}

async function safeExternalUpload(context, uploadUrl, mediaUrl, label) {
  return withSafeRetry(async () => {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `OAuth ${context.token}`, file_url: mediaUrl },
      signal: AbortSignal.timeout(context.config.graphApi.requestTimeoutSeconds * 1000)
    }).catch(() => {
      const error = new Error(`${label} failed at network level.`);
      error.retryable = true;
      throw error;
    });
    if (!response.ok) throw await graphHttpError(response, label, true);
    return parseJsonResponse(response, label);
  }, context.config.graphApi);
}

async function publishFacebookReel(context, socialPackage, account, mediaUrl, initialState, checkpoint) {
  let state = { ...initialState };
  const save = async (patch) => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await checkpoint(state);
  };
  if (state.finishPhase === "REQUESTING") {
    const reconciliation = await pollFacebookVideo(context, state.videoId);
    if (reconciliation.complete) {
      await save({ status: "PUBLISHED", finishPhase: "CONFIRMED_BY_STATUS", remoteMediaId: state.videoId, publishedAt: new Date().toISOString() });
      return state;
    }
    await save({ status: "AMBIGUOUS", finishPhase: "AMBIGUOUS", lastVideoStatus: reconciliation.summary });
    throw new AmbiguousMutationError("Facebook Reel finish outcome is not definitive; refusing automatic replay.", { videoId: state.videoId });
  }
  if (!state.videoId || !state.uploadUrl) {
    const response = await safeGraphRequest(context, {
      method: "POST",
      url: context.graphUrl(account.pageId, "video_reels"),
      form: { upload_phase: "start" },
      label: "Facebook Reel session creation"
    });
    if (!response.video_id || !response.upload_url) throw new QaBlockedError("Facebook Reel start returned no video_id/upload_url.");
    const uploadUrl = validateRuploadUrl(response.upload_url);
    await save({ status: "UPLOAD_SESSION", videoId: String(response.video_id), uploadUrl, sessionCreatedAt: new Date().toISOString() });
  }
  if (!state.uploadComplete) {
    await safeExternalUpload(context, state.uploadUrl, mediaUrl, "Facebook Reel hosted upload");
    await save({ status: "UPLOADED", uploadComplete: true, uploadCompletedAt: new Date().toISOString() });
    const snapshot = await getFacebookVideoStatus(context, state.videoId);
    if (snapshot.failed) throw new QaBlockedError("Facebook Reel upload status reports failure.", { videoId: state.videoId, status: snapshot.summary });
    await save({ lastVideoStatus: snapshot.summary });
  }
  await save({ status: "SUBMITTING", finishPhase: "REQUESTING", finishRequestedAt: new Date().toISOString() });
  try {
    await publishMutationOnce(context, {
      method: "POST",
      url: context.graphUrl(account.pageId, "video_reels"),
      form: {
        upload_phase: "finish",
        video_id: state.videoId,
        video_state: "PUBLISHED",
        description: socialPackage.caption,
        title: socialPackage.options.facebook.title
      },
      label: "Facebook Reel finish/publish"
    });
  } catch (error) {
    if (error.ambiguous) await save({ status: "AMBIGUOUS", finishPhase: "AMBIGUOUS", blockedReason: error.message });
    throw error;
  }
  await save({ status: "SUBMITTED", finishPhase: "CONFIRMED" });
  const result = await pollFacebookVideo(context, state.videoId);
  if (!result.complete) throw new QaBlockedError("Facebook video processing did not complete before polling timeout.", { videoId: state.videoId });
  await save({ status: "PUBLISHED", remoteMediaId: state.videoId, lastVideoStatus: result.summary, publishedAt: new Date().toISOString() });
  return state;
}

export async function publishPlatform({ config, socialPackage, account, token, mediaUrl, platform, platformState = {}, checkpoint = async () => {} }) {
  if (platformState.status === "PUBLISHED") return platformState;
  if (platformState.status === "AMBIGUOUS") {
    throw new AmbiguousMutationError(`Existing ambiguous ${platform} state requires operator reconciliation.`, { platform });
  }
  const context = makeContext(config, token);
  if (platform === "instagram") {
    return publishInstagram(context, socialPackage, account, mediaUrl, platformState, checkpoint);
  }
  if (platform === "facebook" && socialPackage.kind === "post") {
    return publishFacebookPhoto(context, socialPackage, account, mediaUrl, platformState, checkpoint);
  }
  if (platform === "facebook" && socialPackage.kind === "video") {
    return publishFacebookVideo(context, socialPackage, account, mediaUrl, platformState, checkpoint);
  }
  if (platform === "facebook" && socialPackage.kind === "reel") {
    return publishFacebookReel(context, socialPackage, account, mediaUrl, platformState, checkpoint);
  }
  throw new QaBlockedError("Unsupported platform/kind publishing route.", { platform, kind: socialPackage.kind });
}
