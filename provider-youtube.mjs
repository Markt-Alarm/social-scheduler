"use strict";

import { AmbiguousMutationError, QaBlockedError, presignGet, sleep } from "./cloud-lib.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://www.googleapis.com/youtube/v3";
const UPLOAD_ROOT = "https://www.googleapis.com/upload/youtube/v3";
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];
const CHUNK_BYTES = 8 * 1024 * 1024;

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
  const earlyUpload = Number.isFinite(actionAt)
    && Number.isFinite(scheduledAt)
    && actionAt + 60000 < scheduledAt
    && scheduledAt > Date.now() + 60000
    && desiredPrivacy === "public";
  const status = {
    privacyStatus: earlyUpload ? "private" : desiredPrivacy,
    selfDeclaredMadeForKids: options.madeForKids === true,
    containsSyntheticMedia: options.containsSyntheticMedia === true
  };
  if (earlyUpload) status.publishAt = new Date(scheduledAt).toISOString();
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
    status,
    notifySubscribers: options.notifySubscribers !== false
  };
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

async function reconcileVideo(accessToken, videoId, item, metadata, save) {
  const video = await fetchVideoState(accessToken, videoId);
  const uploadStatus = String(video.status?.uploadStatus ?? "").toLowerCase();
  const processingStatus = String(video.processingDetails?.processingStatus ?? "").toLowerCase();
  if (["failed", "rejected", "deleted"].includes(uploadStatus) || ["failed", "terminated"].includes(processingStatus)) {
    throw new QaBlockedError("YouTube-Verarbeitung ist fehlgeschlagen.", {
      code: "YOUTUBE_PROCESSING_FAILED",
      uploadStatus,
      processingStatus,
      failureReason: video.status?.failureReason ?? video.processingDetails?.processingFailureReason ?? null,
      rejectionReason: video.status?.rejectionReason ?? null
    });
  }
  const ready = uploadStatus === "processed" || processingStatus === "succeeded";
  if (!ready) {
    const nextPollAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await save({ status: "PROCESSING", videoId, remoteMediaId: videoId, uploadComplete: true, actionAt: nextPollAt, uploadStatus, processingStatus });
    const error = new QaBlockedError("YouTube verarbeitet das Video noch.", { code: "YOUTUBE_PROCESSING", uploadStatus, processingStatus });
    error.retryable = true;
    throw error;
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
  if (current.status === "AMBIGUOUS" || (current.publishPhase === "REQUESTING" && !current.resumableSessionUri)) {
    throw new AmbiguousMutationError("YouTube-Sessionerzeugung ist uneindeutig; kein automatischer Replay.");
  }
  const expectedChannelId = String(item.account?.youtube?.channelId ?? target.channelId ?? "");
  const accessToken = await authorizeYouTube(credentials, expectedChannelId);
  const metadata = youtubeMetadata(item, target);
  const knownVideoId = String(current.videoId ?? current.remoteMediaId ?? "");
  if (knownVideoId && current.uploadComplete === true) {
    await reconcileVideo(accessToken, knownVideoId, item, metadata, save);
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
      await reconcileVideo(accessToken, videoId, item, metadata, save);
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
        await reconcileVideo(accessToken, videoId, item, metadata, save);
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
      await reconcileVideo(accessToken, videoId, item, metadata, save);
      return current;
    }
    if (response.status === 429 || response.status >= 500) {
      const snapshot = await querySession(sessionUri, accessToken, Number(media.bytes));
      if (snapshot.complete && snapshot.data?.id) {
        const videoId = String(snapshot.data.id);
        await save({ status: "UPLOADED", videoId, remoteMediaId: videoId, uploadComplete: true, nextByte: Number(media.bytes) });
        await reconcileVideo(accessToken, videoId, item, metadata, save);
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
