"use strict";

import { createHash } from "node:crypto";
import { AmbiguousMutationError, QaBlockedError, presignGet, sleep } from "./cloud-lib.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://www.googleapis.com/youtube/v3";
const UPLOAD_ROOT = "https://www.googleapis.com/upload/youtube/v3";
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl"
];
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);

async function responseJson(response) {
  return response.json().catch(() => ({}));
}

async function refreshAccessToken(credentials) {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
    scope: REQUIRED_SCOPES.join(" ")
  });
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    const error = new QaBlockedError("YouTube OAuth-Token konnte voruebergehend nicht erneuert werden.", { code: "YOUTUBE_OAUTH_RETRY" });
    error.retryable = true;
    throw error;
  }
  const data = await responseJson(response);
  if (!response.ok || !data.access_token) {
    const transient = response.status === 429 || response.status >= 500;
    const error = new QaBlockedError("YouTube OAuth-Token konnte nicht erneuert werden.", { httpStatus: response.status, code: transient ? "YOUTUBE_OAUTH_RETRY" : "WAITING_CONFIGURATION" });
    error.retryable = transient;
    error.configuration = !transient;
    throw error;
  }
  if (typeof data.scope === "string") {
    const granted = new Set(data.scope.split(/\s+/).filter(Boolean));
    if (REQUIRED_SCOPES.some((scope) => !granted.has(scope))) {
      const error = new QaBlockedError("YouTube OAuth-Berechtigungen sind unvollstaendig.", { code: "WAITING_CONFIGURATION" });
      error.configuration = true;
      throw error;
    }
  }
  return String(data.access_token);
}

async function verifyChannel(accessToken, expectedChannelId) {
  let response;
  try {
    response = await fetch(`${API_ROOT}/channels?part=snippet&mine=true`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    const error = new QaBlockedError("YouTube-Kanalidentitaet konnte voruebergehend nicht geprueft werden.", { code: "YOUTUBE_CHANNEL_RETRY" });
    error.retryable = true;
    throw error;
  }
  const data = await responseJson(response);
  if (!response.ok) {
    const transient = response.status === 429 || response.status >= 500;
    const error = new QaBlockedError("YouTube-Kanalidentitaet konnte nicht geprueft werden.", { httpStatus: response.status, code: transient ? "YOUTUBE_CHANNEL_RETRY" : "WAITING_CONFIGURATION" });
    error.retryable = transient;
    error.configuration = !transient;
    throw error;
  }
  const actual = String(data.items?.[0]?.id ?? "");
  if (!actual || actual !== expectedChannelId) {
    const error = new QaBlockedError("YouTube OAuth-Identitaet passt nicht zum geplanten Kanal.", { code: "WAITING_CONFIGURATION", expectedChannelId, actualChannelId: actual || null });
    error.configuration = true;
    throw error;
  }
}

async function authorizeYouTube(credentials, expectedChannelId) {
  const channelId = String(expectedChannelId ?? "").trim();
  if (!channelId) {
    const error = new QaBlockedError("YouTube channelId fehlt.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
  const accessToken = await refreshAccessToken(credentials);
  await verifyChannel(accessToken, channelId);
  return accessToken;
}

export async function checkYouTubeConnection({ credentials, expectedChannelId }) {
  await authorizeYouTube(credentials, expectedChannelId);
}

function youtubeMetadata(item, target) {
  const options = target.options ?? item.options?.youtube ?? {};
  const desiredPrivacy = String(options.privacyStatus ?? options.privacy ?? "private").toLowerCase();
  if (!["private", "unlisted", "public"].includes(desiredPrivacy)) throw new QaBlockedError("Ungueltige YouTube-Sichtbarkeit.", { code: "YOUTUBE_PRIVACY_INVALID" });
  const accountAudit = item.account?.youtube?.auditApproved === true;
  if (desiredPrivacy !== "private" && options.auditApproved !== true && !accountAudit) {
    const error = new QaBlockedError("YouTube Public/Unlisted bleibt bis zur API-Auditfreigabe gesperrt.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
  const actionAt = Date.parse(target.actionAt ?? item.scheduledAt);
  const scheduledAt = Date.parse(item.scheduledAt);
  const scheduledPublication = Number.isFinite(actionAt)
    && Number.isFinite(scheduledAt)
    && actionAt + 60000 < scheduledAt
    && desiredPrivacy === "public";
  const commonStatus = {
    selfDeclaredMadeForKids: options.madeForKids === true,
    containsSyntheticMedia: options.containsSyntheticMedia === true,
    license: String(options.license ?? "youtube"),
    embeddable: options.embeddable !== false,
    publicStatsViewable: options.publicStatsViewable !== false
  };
  if (!["youtube", "creativeCommon"].includes(commonStatus.license)) throw new QaBlockedError("Ungueltige YouTube-Lizenz.", { code: "YOUTUBE_LICENSE_INVALID" });
  const title = String(options.title ?? item.caption?.split(/\r?\n/)[0] ?? `${item.brand} ${item.kind}`);
  if (!title.trim()) throw new QaBlockedError("YouTube-Titel fehlt.", { code: "YOUTUBE_TITLE_MISSING" });
  return {
    desiredPrivacy,
    snippet: {
      title,
      description: String(options.description ?? item.caption ?? ""),
      tags: Array.isArray(options.tags) ? [...options.tags] : undefined,
      categoryId: String(options.categoryId ?? "22"),
      defaultLanguage: options.defaultLanguage || undefined
    },
    status: { privacyStatus: "private", ...commonStatus },
    commonStatus,
    scheduledPublishAt: scheduledPublication ? new Date(scheduledAt).toISOString() : null,
    notifySubscribers: options.notifySubscribers !== false
  };
}

function thumbnailExpectation(item, target, expectedChannelId) {
  if (Number(item.identityVersion) !== 2) {
    throw new QaBlockedError("YouTube Custom Thumbnail ist nicht per Identity-v2 gebunden.", { code: "YOUTUBE_THUMBNAIL_INVALID" });
  }
  const snapshotChannelId = String(item.targetSnapshot?.youtube?.channelId ?? "");
  if (!snapshotChannelId || snapshotChannelId !== expectedChannelId) {
    throw new QaBlockedError("Der Identity-v2-Snapshot bindet nicht den geplanten YouTube-Kanal.", {
      code: "YOUTUBE_THUMBNAIL_INVALID",
      expectedChannelId,
      snapshotChannelId: snapshotChannelId || null
    });
  }
  const expected = target.options?.thumbnail;
  const asset = item.youtubeThumbnail;
  const sha256 = String(expected?.sha256 ?? "").toLowerCase();
  const bytes = Number(expected?.bytes);
  const extension = String(expected?.extension ?? "").toLowerCase();
  const contentType = String(expected?.contentType ?? "").toLowerCase();
  if (!asset?.objectKey || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_THUMBNAIL_BYTES
    || ![".jpg", ".jpeg", ".png"].includes(extension) || !THUMBNAIL_CONTENT_TYPES.has(contentType)
    || String(asset.sha256 ?? "").toLowerCase() !== sha256 || Number(asset.bytes) !== bytes
    || String(asset.extension ?? "").toLowerCase() !== extension || String(asset.contentType ?? "").toLowerCase() !== contentType) {
    throw new QaBlockedError("YouTube-Thumbnail ist nicht vollstaendig an den validierten Queue-Snapshot gebunden.", { code: "YOUTUBE_THUMBNAIL_INVALID" });
  }
  return { asset, sha256, bytes, extension, contentType };
}

function isThumbnailConfirmed(state, expected) {
  if (state.thumbnailPhase !== "CONFIRMED" && state.thumbnailSet !== true) return false;
  if (String(state.thumbnailSha256 ?? "").toLowerCase() !== expected.sha256) {
    throw new AmbiguousMutationError("Bestaetigtes YouTube-Thumbnail hat einen anderen Hash; kein automatischer Replay.", {
      expectedSha256: expected.sha256,
      confirmedSha256: state.thumbnailSha256 ?? null
    });
  }
  return true;
}

function retryDelay(response, fallbackMilliseconds) {
  const value = response.headers.get("retry-after");
  if (value && /^\d+$/.test(value)) return Math.max(1000, Number(value) * 1000);
  const instant = Date.parse(String(value ?? ""));
  return Number.isFinite(instant) ? Math.max(1000, instant - Date.now()) : fallbackMilliseconds;
}

async function downloadThumbnail(r2Credentials, expected) {
  let response;
  try {
    response = await fetch(presignGet(r2Credentials, expected.asset.objectKey, 900), {
      signal: AbortSignal.timeout(60000)
    });
  } catch {
    const error = new QaBlockedError("R2-Thumbnail konnte voruebergehend nicht gelesen werden.", { code: "R2_THUMBNAIL_READ_RETRY" });
    error.retryable = true;
    throw error;
  }
  if (!response.ok) {
    const error = new QaBlockedError("R2-Thumbnail konnte nicht gelesen werden.", { httpStatus: response.status, code: "R2_THUMBNAIL_READ_FAILED" });
    error.retryable = response.status === 404 || response.status === 429 || response.status >= 500;
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  const body = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (body.byteLength !== expected.bytes || sha256 !== expected.sha256) {
    throw new QaBlockedError("R2-Thumbnail stimmt nicht mit der QA-gebundenen Bytefolge ueberein.", {
      code: "R2_THUMBNAIL_MISMATCH",
      expectedBytes: expected.bytes,
      actualBytes: body.byteLength,
      expectedSha256: expected.sha256,
      actualSha256: sha256
    });
  }
  return body;
}

async function ensureThumbnail({ r2Credentials, accessToken, videoId, state, expected, save }) {
  if (isThumbnailConfirmed(state, expected)) return;
  if (state.thumbnailPhase === "REQUESTING") {
    throw new AmbiguousMutationError("YouTube-Thumbnail besitzt eine unaufgeloeste fruehere Set-Anfrage; kein automatischer Replay.", {
      videoId,
      thumbnailSha256: expected.sha256
    });
  }
  if (!videoId) throw new AmbiguousMutationError("YouTube-Thumbnail darf nicht ohne bestaetigte Video-ID gesetzt werden.");
  const body = await downloadThumbnail(r2Credentials, expected);
  const requestedAt = new Date().toISOString();
  await save({
    status: "SETTING_THUMBNAIL",
    videoId,
    remoteMediaId: videoId,
    uploadComplete: true,
    thumbnailPhase: "REQUESTING",
    thumbnailSha256: expected.sha256,
    thumbnailRequestedAt: requestedAt
  });
  const query = new URLSearchParams({ videoId, uploadType: "media" });
  let response;
  try {
    response = await fetch(`${UPLOAD_ROOT}/thumbnails/set?${query}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": expected.contentType,
        "content-length": String(body.byteLength)
      },
      body,
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    throw new AmbiguousMutationError("YouTube thumbnails.set brach nach dem REQUESTING-Checkpoint auf Netzwerkebene ab.", {
      cause: error.message,
      videoId,
      thumbnailSha256: expected.sha256
    });
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => {});
    await save({
      status: "UPLOADED",
      videoId,
      remoteMediaId: videoId,
      uploadComplete: true,
      thumbnailPhase: "CONFIRMED",
      thumbnailSet: true,
      thumbnailSha256: expected.sha256,
      thumbnailSetAt: new Date().toISOString(),
      thumbnailLastHttpStatus: response.status
    });
    return;
  }
  const status = response.status;
  const details = await responseJson(response);
  const reason = details.error?.errors?.[0]?.reason ?? null;
  if (status >= 500) {
    throw new AmbiguousMutationError("YouTube thumbnails.set lieferte nach dem REQUESTING-Checkpoint ein uneindeutiges Serverergebnis.", {
      httpStatus: status,
      reason,
      videoId,
      thumbnailSha256: expected.sha256
    });
  }
  if (status === 404 || status === 429) {
    const waitMilliseconds = retryDelay(response, status === 404 ? 5 * 60_000 : 60 * 60_000);
    const actionAt = new Date(Date.now() + waitMilliseconds).toISOString();
    await save({
      status: "RETRY_SCHEDULED",
      thumbnailPhase: "REJECTED_RETRYABLE",
      thumbnailSha256: expected.sha256,
      thumbnailLastHttpStatus: status,
      actionAt
    });
    const error = new QaBlockedError("YouTube Custom Thumbnail wird nach einer eindeutigen voruebergehenden Ablehnung erneut versucht.", {
      code: "YOUTUBE_THUMBNAIL_RETRY",
      httpStatus: status,
      reason,
      actionAt
    });
    error.retryable = true;
    error.retryAfterMs = waitMilliseconds;
    throw error;
  }
  await save({
    ...((status === 401 || status === 403) ? { status: "WAITING_CONFIGURATION" } : {}),
    thumbnailPhase: "REJECTED",
    thumbnailSha256: expected.sha256,
    thumbnailLastHttpStatus: status
  });
  if (status === 401 || status === 403) {
    const error = new QaBlockedError("YouTube Custom Thumbnail ist fuer diesen Kanal oder OAuth-Zugang nicht freigeschaltet.", {
      code: "WAITING_CONFIGURATION",
      httpStatus: status,
      reason
    });
    error.configuration = true;
    throw error;
  }
  throw new QaBlockedError("YouTube lehnte das Custom Thumbnail ab.", {
    code: "YOUTUBE_THUMBNAIL_REJECTED",
    httpStatus: status,
    reason
  });
}

function visibilityExpectation(metadata) {
  const semantic = {
    desiredPrivacy: metadata.desiredPrivacy,
    scheduledPublishAt: metadata.scheduledPublishAt,
    selfDeclaredMadeForKids: metadata.commonStatus.selfDeclaredMadeForKids,
    containsSyntheticMedia: metadata.commonStatus.containsSyntheticMedia,
    license: metadata.commonStatus.license,
    embeddable: metadata.commonStatus.embeddable,
    publicStatsViewable: metadata.commonStatus.publicStatsViewable
  };
  const sha256 = createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
  const scheduledAt = Date.parse(String(metadata.scheduledPublishAt ?? ""));
  const scheduleInFuture = Number.isFinite(scheduledAt) && scheduledAt > Date.now();
  const status = {
    privacyStatus: scheduleInFuture ? "private" : metadata.desiredPrivacy,
    ...metadata.commonStatus
  };
  if (scheduleInFuture) status.publishAt = metadata.scheduledPublishAt;
  return {
    sha256,
    semantic,
    status,
    requiresMutation: status.privacyStatus !== "private" || Boolean(status.publishAt)
  };
}

function visibilityRequestSha256(videoId, status) {
  return createHash("sha256").update(JSON.stringify({ id: videoId, status })).digest("hex");
}

function matchesVisibilityResponse(data, videoId, expectedStatus) {
  if (!data || String(data.id ?? "") !== videoId || !data.status || typeof data.status !== "object") return false;
  for (const [key, expected] of Object.entries(expectedStatus)) {
    const actual = data.status[key];
    if (key === "privacyStatus") {
      if (String(actual ?? "").toLowerCase() !== expected) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  if (!("publishAt" in expectedStatus) && data.status.publishAt != null) return false;
  return true;
}

function isVisibilityConfirmed(state, expected) {
  if (state.visibilityPhase !== "CONFIRMED") return false;
  if (String(state.visibilitySha256 ?? "").toLowerCase() !== expected.sha256) {
    throw new AmbiguousMutationError("Bestaetigte YouTube-Sichtbarkeit passt nicht mehr zum gebundenen Ziel; kein automatischer Replay.", {
      expectedSha256: expected.sha256,
      confirmedSha256: state.visibilitySha256 ?? null
    });
  }
  return true;
}

async function ensureVisibility({ accessToken, videoId, state, expected, actualStatus, save }) {
  if (isVisibilityConfirmed(state, expected)) return { updated: false };
  if (state.visibilityPhase === "REQUESTING") {
    throw new AmbiguousMutationError("YouTube-Sichtbarkeit besitzt eine unaufgeloeste REQUESTING-Transition; kein automatischer Replay.", {
      videoId,
      visibilitySha256: expected.sha256
    });
  }
  if (!expected.requiresMutation) {
    const actualPrivacyStatus = String(actualStatus?.privacyStatus ?? "").toLowerCase();
    if (actualPrivacyStatus !== "private") {
      throw new QaBlockedError("YouTube-Video ist trotz gebundener privater Sichtbarkeit nicht privat.", {
        code: "YOUTUBE_PRIVACY_MISMATCH",
        desiredPrivacy: "private",
        remotePrivacyStatus: actualPrivacyStatus || null
      });
    }
    const requestSha256 = visibilityRequestSha256(videoId, expected.status);
    await save({
      status: "UPLOADED",
      videoId,
      remoteMediaId: videoId,
      uploadComplete: true,
      visibilityPhase: "CONFIRMED",
      visibilitySha256: expected.sha256,
      visibilityRequestSha256: requestSha256,
      visibilityDesiredPrivacy: expected.semantic.desiredPrivacy,
      visibilityPublishAt: expected.semantic.scheduledPublishAt,
      visibilityAppliedPrivacyStatus: "private",
      visibilityAppliedPublishAt: null,
      visibilityConfirmedVia: "READ_BACK",
      visibilityConfirmedAt: new Date().toISOString()
    });
    return { updated: false, remotePrivacyStatus: "private" };
  }
  const requestSha256 = visibilityRequestSha256(videoId, expected.status);
  await save({
    status: "UPDATING_VISIBILITY",
    videoId,
    remoteMediaId: videoId,
    uploadComplete: true,
    visibilityPhase: "REQUESTING",
    visibilitySha256: expected.sha256,
    visibilityRequestSha256: requestSha256,
    visibilityDesiredPrivacy: expected.semantic.desiredPrivacy,
    visibilityPublishAt: expected.semantic.scheduledPublishAt,
    visibilityRequestedPrivacyStatus: expected.status.privacyStatus,
    visibilityRequestedPublishAt: expected.status.publishAt ?? null,
    visibilityRequestedAt: new Date().toISOString()
  });
  const query = new URLSearchParams({ part: "status" });
  let response;
  try {
    response = await fetch(`${API_ROOT}/videos?${query}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify({ id: videoId, status: expected.status }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw new AmbiguousMutationError("YouTube-Sichtbarkeitsupdate brach nach dem REQUESTING-Checkpoint auf Netzwerkebene ab.", {
      cause: error.message,
      videoId,
      visibilitySha256: expected.sha256
    });
  }
  if (response.ok) {
    const data = await responseJson(response);
    if (!matchesVisibilityResponse(data, videoId, expected.status)) {
      throw new AmbiguousMutationError("YouTube bestaetigte das Sichtbarkeitsupdate nicht mit der exakt angeforderten Video-Resource.", {
        httpStatus: response.status,
        videoId,
        visibilitySha256: expected.sha256,
        visibilityRequestSha256: requestSha256
      });
    }
    await save({
      status: "UPLOADED",
      videoId,
      remoteMediaId: videoId,
      uploadComplete: true,
      visibilityPhase: "CONFIRMED",
      visibilitySha256: expected.sha256,
      visibilityRequestSha256: requestSha256,
      visibilityDesiredPrivacy: expected.semantic.desiredPrivacy,
      visibilityPublishAt: expected.semantic.scheduledPublishAt,
      visibilityAppliedPrivacyStatus: expected.status.privacyStatus,
      visibilityAppliedPublishAt: expected.status.publishAt ?? null,
      visibilityConfirmedAt: new Date().toISOString(),
      visibilityLastHttpStatus: response.status
    });
    return { updated: true, remotePrivacyStatus: expected.status.privacyStatus };
  }
  const status = response.status;
  const details = await responseJson(response);
  const reason = details.error?.errors?.[0]?.reason ?? null;
  if (status >= 500) {
    throw new AmbiguousMutationError("YouTube-Sichtbarkeitsupdate lieferte nach dem REQUESTING-Checkpoint ein uneindeutiges Ergebnis.", {
      httpStatus: status,
      reason,
      videoId,
      visibilitySha256: expected.sha256
    });
  }
  if (status === 404 || status === 429) {
    const waitMilliseconds = retryDelay(response, status === 404 ? 5 * 60_000 : 60 * 60_000);
    const actionAt = new Date(Date.now() + waitMilliseconds).toISOString();
    await save({
      status: "RETRY_SCHEDULED",
      visibilityPhase: "REJECTED_RETRYABLE",
      visibilitySha256: expected.sha256,
      visibilityLastHttpStatus: status,
      actionAt
    });
    const error = new QaBlockedError("YouTube-Video ist fuer das Sichtbarkeitsupdate noch nicht auffindbar.", {
      code: "YOUTUBE_VISIBILITY_RETRY",
      httpStatus: status,
      reason,
      actionAt
    });
    error.retryable = true;
    error.retryAfterMs = waitMilliseconds;
    throw error;
  }
  await save({
    ...((status === 401 || status === 403) ? { status: "WAITING_CONFIGURATION" } : {}),
    visibilityPhase: "REJECTED",
    visibilitySha256: expected.sha256,
    visibilityLastHttpStatus: status
  });
  if (status === 401 || status === 403) {
    const error = new QaBlockedError("YouTube-Sichtbarkeit konnte mit diesem OAuth-Zugang nicht gesetzt werden.", {
      code: "WAITING_CONFIGURATION",
      httpStatus: status,
      reason
    });
    error.configuration = true;
    throw error;
  }
  throw new QaBlockedError("YouTube lehnte das Sichtbarkeitsupdate ab; das Video bleibt privat.", {
    code: "YOUTUBE_VISIBILITY_REJECTED",
    httpStatus: status,
    reason
  });
}

async function fetchVideoState(accessToken, videoId) {
  const query = new URLSearchParams({ part: "status,processingDetails", id: videoId });
  let response;
  try {
    response = await fetch(`${API_ROOT}/videos?${query}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    const error = new QaBlockedError("YouTube-Verarbeitungsstatus konnte nicht gelesen werden.", { code: "YOUTUBE_PROCESSING" });
    error.retryable = true;
    throw error;
  }
  const data = await responseJson(response);
  if (!response.ok) {
    const error = new QaBlockedError("YouTube-Verarbeitungsstatus wurde abgelehnt.", { httpStatus: response.status, code: response.status === 429 || response.status >= 500 ? "YOUTUBE_PROCESSING" : "YOUTUBE_STATUS_FAILED" });
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  const video = data.items?.[0];
  if (!video) {
    const error = new QaBlockedError("YouTube-Video ist unmittelbar nach dem Upload noch nicht auffindbar.", { code: "YOUTUBE_PROCESSING" });
    error.retryable = true;
    throw error;
  }
  return video;
}

async function reconcileVideo(accessToken, videoId, item, target, metadata, r2Credentials, state, expectedThumbnail, expectedVisibility, save) {
  const video = await fetchVideoState(accessToken, videoId);
  const uploadStatus = String(video.status?.uploadStatus ?? "").toLowerCase();
  const processingStatus = String(video.processingDetails?.processingStatus ?? "").toLowerCase();
  const initialPrivacyStatus = String(video.status?.privacyStatus ?? "").toLowerCase();
  if (["failed", "rejected", "deleted"].includes(uploadStatus) || ["failed", "terminated"].includes(processingStatus)) {
    throw new QaBlockedError("YouTube-Verarbeitung ist fehlgeschlagen.", {
      code: "YOUTUBE_PROCESSING_FAILED",
      uploadStatus,
      processingStatus,
      failureReason: video.status?.failureReason ?? video.processingDetails?.processingFailureReason ?? null,
      rejectionReason: video.status?.rejectionReason ?? null
    });
  }
  if (!isThumbnailConfirmed(state, expectedThumbnail) && initialPrivacyStatus && initialPrivacyStatus !== "private") {
    throw new QaBlockedError("YouTube-Video wurde sichtbar, bevor das exakt gebundene Thumbnail bestaetigt war.", {
      code: "YOUTUBE_PREMATURE_VISIBILITY",
      remotePrivacyStatus: initialPrivacyStatus,
      videoId
    });
  }
  await ensureThumbnail({ r2Credentials, accessToken, videoId, state, expected: expectedThumbnail, save });
  const ready = uploadStatus === "processed" || processingStatus === "succeeded";
  if (!ready) {
    const nextPollAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await save({ status: "PROCESSING", videoId, remoteMediaId: videoId, uploadComplete: true, actionAt: nextPollAt, uploadStatus, processingStatus });
    const error = new QaBlockedError("YouTube verarbeitet das Video noch.", { code: "YOUTUBE_PROCESSING", uploadStatus, processingStatus });
    error.retryable = true;
    throw error;
  }
  const visibility = await ensureVisibility({ accessToken, videoId, state, expected: expectedVisibility, actualStatus: video.status, save });
  if (visibility.updated) {
    video.status ??= {};
    video.status.privacyStatus = visibility.remotePrivacyStatus;
    if (expectedVisibility.status.publishAt) video.status.publishAt = expectedVisibility.status.publishAt;
    else delete video.status.publishAt;
  }
  const actualPrivacy = String(video.status?.privacyStatus ?? "").toLowerCase();
  const scheduledAtMs = Date.parse(item.scheduledAt);
  if (metadata.desiredPrivacy === "public" && actualPrivacy !== "public") {
    if (Number.isFinite(scheduledAtMs) && Date.now() < scheduledAtMs) {
      await save({
        status: "SCHEDULED_REMOTE",
        videoId,
        remoteMediaId: videoId,
        uploadComplete: true,
        actionAt: new Date(scheduledAtMs).toISOString(),
        remotePrivacyStatus: actualPrivacy,
        uploadStatus,
        processingStatus
      });
      return null;
    }
    const graceDeadline = Number.isFinite(scheduledAtMs) ? scheduledAtMs + 15 * 60_000 : 0;
    if (Date.now() <= graceDeadline) {
      const nextPollAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await save({ status: "PROCESSING", videoId, remoteMediaId: videoId, uploadComplete: true, actionAt: nextPollAt, remotePrivacyStatus: actualPrivacy, uploadStatus, processingStatus });
      const error = new QaBlockedError("YouTube wartet noch auf die geplante oeffentliche Sichtbarkeit.", { code: "YOUTUBE_PROCESSING", remotePrivacyStatus: actualPrivacy });
      error.retryable = true;
      throw error;
    }
    throw new QaBlockedError("YouTube blieb nach dem geplanten Termin privat.", { code: "YOUTUBE_SCHEDULE_NOT_PUBLISHED", remotePrivacyStatus: actualPrivacy });
  }
  if (metadata.desiredPrivacy !== "public" && actualPrivacy && actualPrivacy !== metadata.desiredPrivacy) {
    throw new QaBlockedError("YouTube-Sichtbarkeit stimmt nicht mit dem geplanten Ziel ueberein.", { code: "YOUTUBE_PRIVACY_MISMATCH", desiredPrivacy: metadata.desiredPrivacy, remotePrivacyStatus: actualPrivacy });
  }
  await save({ status: "PUBLISHED", videoId, remoteMediaId: videoId, publishedAt: new Date().toISOString(), uploadComplete: true, remotePrivacyStatus: actualPrivacy, uploadStatus, processingStatus });
  return true;
}

function parseOffset(response, fallback) {
  const range = response.headers.get("range") ?? "";
  const match = /bytes=0-(\d+)/i.exec(range);
  if (match) return Number(match[1]) + 1;
  if (!range) return fallback;
  throw new AmbiguousMutationError("YouTube resumable 308 enthielt einen ungueltigen Range-Header.");
}

function validateSessionUri(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AmbiguousMutationError("YouTube resumable Session-URL ist ungueltig.");
  }
  if (url.protocol !== "https:" || !(url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com"))) {
    throw new AmbiguousMutationError("YouTube resumable Session-URL hat einen unerwarteten Host.");
  }
  return url.toString();
}

async function querySession(sessionUri, accessToken, totalBytes) {
  const response = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-length": "0",
      "content-range": `bytes */${totalBytes}`
    },
    body: Buffer.alloc(0),
    signal: AbortSignal.timeout(30000)
  });
  if (response.status === 308) return { offset: parseOffset(response, 0) };
  if (response.ok) return { complete: true, data: await responseJson(response) };
  throw new AmbiguousMutationError("YouTube-Uploadsession liess sich nicht eindeutig rekonstruieren.", { httpStatus: response.status });
}

async function downloadChunk(r2Credentials, media, start, end) {
  const response = await fetch(presignGet(r2Credentials, media.objectKey, 3600), {
    headers: { range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok || (![200, 206].includes(response.status))) throw new QaBlockedError("R2-Medium konnte fuer YouTube nicht gelesen werden.", { httpStatus: response.status, code: "R2_MEDIA_READ_FAILED" });
  const body = Buffer.from(await response.arrayBuffer());
  const expected = end - start + 1;
  if (body.byteLength !== expected) throw new QaBlockedError("R2 lieferte einen unvollstaendigen YouTube-Uploadblock.", { expected, actual: body.byteLength });
  return body;
}

export async function publishYouTube({ r2Credentials, item, target, state, credentials, checkpoint }) {
  if (item.account?.youtube?.enabled === false) {
    const error = new QaBlockedError("YouTube ist fuer diesen Account noch nicht aktiviert.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
  if (!["reel", "video"].includes(item.kind)) throw new QaBlockedError("YouTube akzeptiert in diesem Planer nur Video/Reel-Pakete.", { code: "YOUTUBE_KIND_UNSUPPORTED" });
  const media = item.media?.slides ? null : item.media;
  if (!media?.objectKey || !Number.isSafeInteger(Number(media.bytes)) || Number(media.bytes) < 1) throw new QaBlockedError("YouTube-Mediendaten in der Queue sind unvollstaendig.", { code: "YOUTUBE_MEDIA_INVALID" });
  let current = { status: "PENDING", ...state };
  const save = async (patch) => {
    current = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await checkpoint(current);
  };
  if (current.status === "PUBLISHED") return current;
  const expectedChannelId = String(item.account?.youtube?.channelId ?? target.channelId ?? "");
  if (!expectedChannelId) {
    const error = new QaBlockedError("YouTube channelId fehlt.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
  const expectedThumbnail = thumbnailExpectation(item, target, expectedChannelId);
  const metadata = youtubeMetadata(item, target);
  const expectedVisibility = visibilityExpectation(metadata);
  if (current.thumbnailPhase === "REQUESTING") {
    throw new AmbiguousMutationError("YouTube-Thumbnail besitzt eine unaufgeloeste REQUESTING-Transition; kein automatischer Replay.", {
      videoId: current.videoId ?? current.remoteMediaId ?? null,
      thumbnailSha256: current.thumbnailSha256 ?? null
    });
  }
  isThumbnailConfirmed(current, expectedThumbnail);
  if (current.visibilityPhase === "REQUESTING") {
    throw new AmbiguousMutationError("YouTube-Sichtbarkeit besitzt eine unaufgeloeste REQUESTING-Transition; kein automatischer Replay.", {
      videoId: current.videoId ?? current.remoteMediaId ?? null,
      visibilitySha256: current.visibilitySha256 ?? null
    });
  }
  isVisibilityConfirmed(current, expectedVisibility);
  if (current.status === "AMBIGUOUS" || (current.publishPhase === "REQUESTING" && !current.resumableSessionUri)) {
    throw new AmbiguousMutationError("YouTube-Sessionerzeugung ist uneindeutig; kein automatischer Replay.");
  }
  const accessToken = await authorizeYouTube(credentials, expectedChannelId);
  const knownVideoId = String(current.videoId ?? current.remoteMediaId ?? "");
  if (knownVideoId && current.uploadComplete === true) {
    await reconcileVideo(accessToken, knownVideoId, item, target, metadata, r2Credentials, current, expectedThumbnail, expectedVisibility, save);
    return current;
  }
  let sessionUri = current.resumableSessionUri ? validateSessionUri(current.resumableSessionUri) : "";
  if (!sessionUri) {
    await save({ status: "SUBMITTING", publishPhase: "REQUESTING", publishRequestedAt: new Date().toISOString() });
    let response;
    try {
      const query = new URLSearchParams({ uploadType: "resumable", part: "snippet,status", notifySubscribers: String(metadata.notifySubscribers) });
      response = await fetch(`${UPLOAD_ROOT}/videos?${query}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-length": String(media.bytes),
          "x-upload-content-type": media.contentType
        },
        body: JSON.stringify({ snippet: metadata.snippet, status: metadata.status }),
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      throw new AmbiguousMutationError("YouTube-Sessionerzeugung brach auf Netzwerkebene ab.", { cause: error.message });
    }
    if (!response.ok) {
      const details = await responseJson(response);
      if (response.status === 429 || response.status >= 500) throw new AmbiguousMutationError("YouTube-Sessionerzeugung lieferte ein uneindeutiges Ergebnis.", { httpStatus: response.status });
      throw new QaBlockedError("YouTube lehnte die Uploadsession ab.", { httpStatus: response.status, reason: details.error?.errors?.[0]?.reason ?? null });
    }
    sessionUri = validateSessionUri(response.headers.get("location"));
    await save({ status: "UPLOAD_SESSION", publishPhase: "CONFIRMED", resumableSessionUri: sessionUri, nextByte: 0 });
  }

  let offset = Number(current.nextByte ?? 0);
  if (offset > 0 || current.status === "UPLOAD_SESSION") {
    const snapshot = await querySession(sessionUri, accessToken, Number(media.bytes));
    if (snapshot.complete) {
      const videoId = String(snapshot.data?.id ?? current.remoteMediaId ?? "");
      if (!videoId) throw new AmbiguousMutationError("YouTube meldete Uploadabschluss ohne Video-ID.");
      await save({ status: "UPLOADED", videoId, remoteMediaId: videoId, uploadComplete: true, nextByte: Number(media.bytes) });
      await reconcileVideo(accessToken, videoId, item, target, metadata, r2Credentials, current, expectedThumbnail, expectedVisibility, save);
      return current;
    }
    offset = snapshot.offset;
    await save({ status: "UPLOADING", nextByte: offset });
  }
  while (offset < Number(media.bytes)) {
    const end = Math.min(offset + CHUNK_BYTES - 1, Number(media.bytes) - 1);
    const chunk = await downloadChunk(r2Credentials, media, offset, end);
    let response;
    try {
      response = await fetch(sessionUri, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-length": String(chunk.byteLength),
          "content-type": media.contentType,
          "content-range": `bytes ${offset}-${end}/${media.bytes}`
        },
        body: chunk,
        signal: AbortSignal.timeout(180000)
      });
    } catch {
      const snapshot = await querySession(sessionUri, accessToken, Number(media.bytes));
      if (snapshot.complete) {
        const videoId = String(snapshot.data?.id ?? "");
        if (!videoId) throw new AmbiguousMutationError("YouTube-Upload endete uneindeutig ohne Video-ID.");
        await save({ status: "UPLOADED", videoId, remoteMediaId: videoId, uploadComplete: true, nextByte: Number(media.bytes) });
        await reconcileVideo(accessToken, videoId, item, target, metadata, r2Credentials, current, expectedThumbnail, expectedVisibility, save);
        return current;
      }
      offset = snapshot.offset;
      await save({ status: "UPLOADING", nextByte: offset, recoveredAt: new Date().toISOString() });
      continue;
    }
    if (response.status === 308) {
      const confirmedOffset = parseOffset(response, null);
      await response.body?.cancel().catch(() => {});
      if (confirmedOffset === null) {
        throw new AmbiguousMutationError("YouTube resumable 308 bestaetigte keinen Upload-Offset; kein automatisches Fortschreiben.");
      }
      offset = confirmedOffset;
      await save({ status: "UPLOADING", nextByte: offset });
      continue;
    }
    const data = await responseJson(response);
    if (response.ok) {
      let videoId = String(data.id ?? "");
      if (!videoId) {
        const snapshot = await querySession(sessionUri, accessToken, Number(media.bytes));
        videoId = snapshot.complete ? String(snapshot.data?.id ?? "") : "";
      }
      if (!videoId) throw new AmbiguousMutationError("YouTube bestaetigte den finalen Uploadblock ohne rekonstruierbare Video-ID.");
      await save({ status: "UPLOADED", videoId, remoteMediaId: videoId, uploadComplete: true, nextByte: Number(media.bytes) });
      await reconcileVideo(accessToken, videoId, item, target, metadata, r2Credentials, current, expectedThumbnail, expectedVisibility, save);
      return current;
    }
    if (response.status === 429 || response.status >= 500) {
      const snapshot = await querySession(sessionUri, accessToken, Number(media.bytes));
      if (snapshot.complete && snapshot.data?.id) {
        const videoId = String(snapshot.data.id);
        await save({ status: "UPLOADED", videoId, remoteMediaId: videoId, uploadComplete: true, nextByte: Number(media.bytes) });
        await reconcileVideo(accessToken, videoId, item, target, metadata, r2Credentials, current, expectedThumbnail, expectedVisibility, save);
        return current;
      }
      offset = snapshot.offset;
      await save({ status: "UPLOADING", nextByte: offset });
      await sleep(1000);
      continue;
    }
    throw new QaBlockedError("YouTube lehnte einen Uploadblock ab.", { httpStatus: response.status, reason: data.error?.errors?.[0]?.reason ?? null });
  }
  throw new AmbiguousMutationError("YouTube-Upload endete ohne bestaetigte Video-ID.");
}
