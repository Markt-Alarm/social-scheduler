"use strict";

import { createHash, createHmac } from "node:crypto";
import { AmbiguousMutationError, QaBlockedError, sleep } from "./cloud-lib.mjs";

const API_ROOT = "https://open.tiktokapis.com/v2/post/publish";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name";

function apiError(data) {
  const error = data?.error ?? {};
  return { code: String(error.code ?? "unknown"), message: String(error.message ?? "TikTok request failed") };
}

function mediaUrl(credentials, objectKey, verifiedPrefix) {
  const encodedKey = String(objectKey).split("/").map(encodeURIComponent).join("/");
  let value;
  if (credentials.mediaBaseUrl && credentials.mediaSigningSecret) {
    if (String(credentials.mediaSigningSecret).length < 32) throw new QaBlockedError("TikTok Media-Signatursecret ist zu kurz.", { code: "WAITING_CONFIGURATION" });
    let signed;
    try {
      signed = new URL(encodedKey, ensureOrigin(credentials.mediaBaseUrl));
    } catch {
      throw new QaBlockedError("TikTok Media-Basis-URL ist ungueltig.", { code: "WAITING_CONFIGURATION" });
    }
    const expires = String(Math.floor(Date.now() / 1000) + 3 * 60 * 60);
    const signature = createHmac("sha256", credentials.mediaSigningSecret).update(`${signed.pathname}\n${expires}`).digest("base64url");
    signed.searchParams.set("expires", expires);
    signed.searchParams.set("sig", signature);
    value = signed.toString();
  } else {
    const template = String(credentials.mediaUrlTemplate ?? "");
    if (!template.includes("{objectKey}")) throw new QaBlockedError("TikTok benoetigt Media-Basis-URL plus Signatursecret oder ein URL-Template mit {objectKey}.", { code: "WAITING_CONFIGURATION" });
    value = template.replaceAll("{objectKey}", encodedKey);
  }
  let parsed;
  let prefix;
  try {
    parsed = new URL(value);
    prefix = new URL(verifiedPrefix);
  } catch {
    throw new QaBlockedError("TikTok Media-URL-Template erzeugt keine gueltige URL.", { code: "WAITING_CONFIGURATION" });
  }
  const prefixPath = prefix.pathname.endsWith("/") ? prefix.pathname : `${prefix.pathname}/`;
  const pathMatches = prefix.pathname === "/" || parsed.pathname === prefix.pathname || parsed.pathname.startsWith(prefixPath);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443") || prefix.protocol !== "https:" || prefix.username || prefix.password || prefix.search || prefix.hash || (prefix.port && prefix.port !== "443") || parsed.origin !== prefix.origin || !pathMatches) {
    throw new QaBlockedError("TikTok PULL_FROM_URL muss unter dem verifizierten HTTPS-Prefix liegen.", { code: "WAITING_CONFIGURATION" });
  }
  return value;
}

async function verifyPullUrl(url, expectedBytes) {
  let response;
  try {
    response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(30000) });
  } catch {
    const error = new QaBlockedError("TikTok-Medienroute konnte vor dem Init nicht erreicht werden.", { code: "TIKTOK_MEDIA_RETRY" });
    error.retryable = true;
    throw error;
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw new QaBlockedError("TikTok-Medienroute darf nicht weiterleiten.", { code: "WAITING_CONFIGURATION", httpStatus: response.status });
  }
  if (!response.ok) {
    const error = new QaBlockedError("TikTok-Medienroute ist vor dem Init nicht abrufbar.", { code: response.status === 429 || response.status >= 500 ? "TIKTOK_MEDIA_RETRY" : "WAITING_CONFIGURATION", httpStatus: response.status });
    error.retryable = response.status === 429 || response.status >= 500;
    error.configuration = !error.retryable;
    throw error;
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(length) && Number.isSafeInteger(Number(expectedBytes)) && length !== Number(expectedBytes)) {
    throw new QaBlockedError("TikTok-Medienroute liefert nicht die QA-gebundene Dateigroesse.", { code: "TIKTOK_MEDIA_MISMATCH", expectedBytes: Number(expectedBytes), actualBytes: length });
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/^video\//i.test(contentType)) throw new QaBlockedError("TikTok-Medienroute liefert keinen Video-Content-Type.", { code: "TIKTOK_MEDIA_MISMATCH", contentType });
  await response.body?.cancel().catch(() => {});
}

function ensureOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid origin");
  return url;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function postJson(path, accessToken, body, { mutation = false } = {}) {
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    if (mutation) throw new AmbiguousMutationError("TikTok-Mutation brach auf Netzwerkebene ab.", { cause: error.message });
    const failure = new QaBlockedError("TikTok-Anfrage scheiterte auf Netzwerkebene.", { code: "TIKTOK_NETWORK" });
    failure.retryable = true;
    throw failure;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.error?.code && data.error.code !== "ok")) {
    const details = apiError(data);
    if (mutation && (response.status === 429 || response.status >= 500)) throw new AmbiguousMutationError("TikTok-Mutation lieferte ein uneindeutiges Ergebnis.", { httpStatus: response.status, code: details.code });
    const failure = new QaBlockedError("TikTok lehnte die Anfrage ab.", { httpStatus: response.status, code: details.code, apiMessage: details.message });
    if (response.status === 401 || /access.?token|scope|unauthorized/i.test(details.code)) {
      failure.configuration = true;
      failure.details.code = "WAITING_CONFIGURATION";
    }
    failure.retryable = response.status === 429 || response.status >= 500;
    throw failure;
  }
  return data.data ?? {};
}

async function verifyTikTokIdentity(accessToken, expectedOpenId) {
  if (!expectedOpenId) {
    const error = new QaBlockedError("TikTok openId fehlt fuer die Kanalbindung.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
  let response;
  try {
    response = await fetch(USER_INFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    const error = new QaBlockedError("TikTok-Identitaetspruefung scheiterte auf Netzwerkebene.", { code: "TIKTOK_NETWORK" });
    error.retryable = true;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  const details = apiError(payload);
  const actualOpenId = String(payload.data?.user?.open_id ?? "");
  if (!response.ok || (payload.error?.code && payload.error.code !== "ok") || !actualOpenId) {
    if (response.status === 429 || response.status >= 500) {
      const error = new QaBlockedError("TikTok-Identitaetspruefung ist voruebergehend nicht verfuegbar.", {
        httpStatus: response.status,
        code: "TIKTOK_IDENTITY_RETRY",
        apiCode: details.code
      });
      error.retryable = true;
      throw error;
    }
    const error = new QaBlockedError("TikTok-OAuth-Identitaet konnte nicht geprueft werden; user.info.basic fehlt oder der Token ist ungueltig.", {
      httpStatus: response.status,
      code: "WAITING_CONFIGURATION",
      apiCode: details.code
    });
    error.configuration = true;
    throw error;
  }
  if (actualOpenId !== expectedOpenId) {
    const error = new QaBlockedError("TikTok Access-Token gehoert zu einem anderen Account.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
}

function validateApproval(item, target, creator = null) {
  const approval = target.approval ?? target.options?.approval;
  if (!approval || approval.schemaVersion !== 1 || approval.fingerprint !== item.fingerprint || approval.contentId !== item.contentId || approval.brand !== item.accountId || Date.parse(approval.expiresAt ?? 0) <= Date.now()) {
    const error = new QaBlockedError("TikTok Direct Post benoetigt eine aktuelle Freigabe fuer genau dieses Paket.", { code: "WAITING_APPROVAL" });
    error.approval = true;
    throw error;
  }
  if (approval.previewConfirmed !== true || approval.musicUsageConfirmed !== true || approval.expressConsent !== true) {
    const error = new QaBlockedError("TikTok-Freigabe ist unvollstaendig.", { code: "WAITING_APPROVAL" });
    error.approval = true;
    throw error;
  }
  const expectedOpenId = String(item.account?.tiktok?.openId ?? "");
  if (!expectedOpenId || approval.creatorOpenId !== expectedOpenId) throw new QaBlockedError("TikTok-Freigabe gehoert nicht exakt zum konfigurierten Creator.", { code: "TIKTOK_CREATOR_STALE" });
  if (approval.consentVersion !== "tiktok-content-posting-v1") throw new QaBlockedError("TikTok-Freigabe verwendet keine unterstuetzte Consent-Version.", { code: "WAITING_APPROVAL" });
  const approvedAtMs = Date.parse(approval.approvedAt ?? 0);
  const expiresAtMs = Date.parse(approval.expiresAt ?? 0);
  const maximumTtlMinutes = Number(item.account?.tiktok?.approvalTtlMinutes ?? 24 * 60);
  if (!Number.isFinite(approvedAtMs) || approvedAtMs > Date.now() || !Number.isFinite(expiresAtMs) || expiresAtMs > approvedAtMs + maximumTtlMinutes * 60_000) {
    throw new QaBlockedError("TikTok-Freigabezeitraum ist ungueltig oder ueberschreitet die konfigurierte TTL.", { code: "WAITING_APPROVAL" });
  }
  if (creator) {
    const privacy = String(approval.privacyLevel ?? "");
    const allowed = new Set(creator.privacy_level_options ?? []);
    if (!privacy || !allowed.size || !allowed.has(privacy)) throw new QaBlockedError("Freigegebene TikTok-Sichtbarkeit ist fuer den Creator nicht mehr verfuegbar.", { code: "TIKTOK_PRIVACY_STALE" });
    if (creator.comment_disabled && approval.allowComment === true) throw new QaBlockedError("TikTok-Kommentare sind fuer diesen Creator deaktiviert.", { code: "TIKTOK_INTERACTION_STALE" });
    if (creator.duet_disabled && approval.allowDuet === true) throw new QaBlockedError("TikTok-Duett ist fuer diesen Creator deaktiviert.", { code: "TIKTOK_INTERACTION_STALE" });
    if (creator.stitch_disabled && approval.allowStitch === true) throw new QaBlockedError("TikTok-Stitch ist fuer diesen Creator deaktiviert.", { code: "TIKTOK_INTERACTION_STALE" });
  }
  const settings = {
    fingerprint: approval.fingerprint,
    contentId: approval.contentId,
    brand: approval.brand,
    creatorOpenId: approval.creatorOpenId,
    consentVersion: approval.consentVersion,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
    title: approval.title,
    privacyLevel: approval.privacyLevel,
    allowComment: approval.allowComment,
    allowDuet: approval.allowDuet,
    allowStitch: approval.allowStitch,
    brandContent: approval.brandContent,
    brandOrganic: approval.brandOrganic,
    videoCoverTimestampMs: approval.videoCoverTimestampMs,
    previewConfirmed: approval.previewConfirmed,
    musicUsageConfirmed: approval.musicUsageConfirmed,
    expressConsent: approval.expressConsent,
    isAigc: approval.isAigc
  };
  const expectedHash = createHash("sha256").update(canonicalJson(settings)).digest("hex");
  if (approval.settingsHash !== expectedHash) throw new QaBlockedError("TikTok-Freigabe wurde nachtraeglich veraendert.", { code: "WAITING_APPROVAL" });
  return approval;
}

async function pollStatus(accessToken, publishId, checkpoint, { inbox = false } = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const data = await postJson("/status/fetch/", accessToken, { publish_id: publishId });
    const status = String(data.status ?? "UNKNOWN").toUpperCase();
    await checkpoint({ lastRemoteStatus: status, lastStatusAt: new Date().toISOString() });
    if (status === "PUBLISH_COMPLETE" || (inbox && status === "SEND_TO_USER_INBOX")) return { status, postIds: data.publicaly_available_post_id ?? [] };
    if (status === "FAILED") throw new QaBlockedError("TikTok-Verarbeitung ist fehlgeschlagen.", { code: data.fail_reason ?? "TIKTOK_FAILED" });
    await sleep(15000);
  }
  const error = new QaBlockedError("TikTok verarbeitet den Upload noch; der Status wird spaeter erneut geprueft.", { code: "TIKTOK_PROCESSING" });
  error.retryable = true;
  throw error;
}

export async function publishTikTok({ item, target, state, credentials, checkpoint }) {
  if (item.account?.purpose === "paid") {
    const error = new QaBlockedError("Der reine Werbekanal muss ueber die TikTok Marketing API statt Content Posting veroeffentlichen.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
  if (item.account?.tiktok?.enabled === false) {
    const error = new QaBlockedError("TikTok ist fuer diesen Account noch nicht aktiviert.", { code: "WAITING_CONFIGURATION" });
    error.configuration = true;
    throw error;
  }
  if (!["reel", "video"].includes(item.kind)) throw new QaBlockedError("TikTok akzeptiert in diesem Planer nur Video/Reel-Pakete.", { code: "TIKTOK_KIND_UNSUPPORTED" });
  const objectKey = item.media?.slides ? null : item.media?.objectKey;
  if (!objectKey) throw new QaBlockedError("TikTok-Mediendaten in der Queue sind unvollstaendig.", { code: "TIKTOK_MEDIA_INVALID" });
  let current = { status: "PENDING", ...state };
  const save = async (patch) => {
    current = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await checkpoint(current);
  };
  if (["PUBLISHED", "ACTION_REQUIRED"].includes(current.status)) return current;
  if (current.status === "AMBIGUOUS" || (current.publishPhase === "REQUESTING" && !current.publishId)) throw new AmbiguousMutationError("TikTok-Erstellung ist uneindeutig; kein automatischer Replay.");
  const configuredMode = String(target.options?.mode ?? item.account?.tiktok?.mode ?? "inbox").toLowerCase();
  const mode = configuredMode === "direct-post" ? "direct" : configuredMode;
  if (!["inbox", "direct"].includes(mode)) throw new QaBlockedError("Unbekannter TikTok-Publishingmodus.", { code: "TIKTOK_MODE_INVALID" });
  const verifiedPrefix = String(item.account?.tiktok?.verifiedUrlPrefix ?? target.verifiedUrlPrefix ?? "");

  if (current.publishId) {
    if (mode === "inbox") {
      await pollStatus(credentials.accessToken, current.publishId, save, { inbox: true });
      await save({ status: "ACTION_REQUIRED", action: "TIKTOK_COMPLETE_IN_APP", transferredAt: new Date().toISOString() });
      return current;
    }
    const outcome = await pollStatus(credentials.accessToken, current.publishId, save);
    await save({ status: "PUBLISHED", remoteMediaIds: outcome.postIds, publishedAt: new Date().toISOString() });
    return current;
  }

  let directApproval = null;
  if (mode === "direct") {
    const auditApproved = target.options?.auditApproved === true || item.account?.tiktok?.auditApproved === true;
    if (!auditApproved) {
      const error = new QaBlockedError("TikTok Direct Post bleibt bis zur App-Auditfreigabe gesperrt; Inbox-Upload verwenden.", { code: "WAITING_CONFIGURATION" });
      error.configuration = true;
      throw error;
    }
    directApproval = validateApproval(item, target);
  }

  await verifyTikTokIdentity(credentials.accessToken, String(item.account?.tiktok?.openId ?? ""));
  const pullUrl = mediaUrl(credentials, objectKey, verifiedPrefix);
  await verifyPullUrl(pullUrl, item.media?.bytes);

  let endpoint = "/inbox/video/init/";
  let body = { source_info: { source: "PULL_FROM_URL", video_url: pullUrl } };
  if (mode === "direct") {
    const creator = await postJson("/creator_info/query/", credentials.accessToken, {});
    const approval = validateApproval(item, target, creator);
    if (approval.settingsHash !== directApproval.settingsHash) throw new QaBlockedError("TikTok-Freigabe hat sich waehrend der Pruefung geaendert.", { code: "WAITING_APPROVAL" });
    endpoint = "/video/init/";
    body = {
      post_info: {
        title: String(approval.title ?? ""),
        privacy_level: approval.privacyLevel,
        disable_duet: approval.allowDuet !== true,
        disable_comment: approval.allowComment !== true,
        disable_stitch: approval.allowStitch !== true,
        video_cover_timestamp_ms: Number(approval.videoCoverTimestampMs ?? 1000),
        brand_content_toggle: approval.brandContent === true,
        brand_organic_toggle: approval.brandOrganic === true,
        is_aigc: approval.isAigc === true
      },
      source_info: { source: "PULL_FROM_URL", video_url: pullUrl }
    };
  }
  await save({ status: "SUBMITTING", publishPhase: "REQUESTING", publishRequestedAt: new Date().toISOString(), mode });
  const data = await postJson(endpoint, credentials.accessToken, body, { mutation: true });
  const publishId = String(data.publish_id ?? "");
  if (!publishId) throw new AmbiguousMutationError("TikTok bestaetigte die Erstellung ohne publish_id.");
  await save({ status: "PROCESSING", publishPhase: "CONFIRMED", publishId });
  const outcome = await pollStatus(credentials.accessToken, publishId, save, { inbox: mode === "inbox" });
  if (mode === "inbox") {
    await save({ status: "ACTION_REQUIRED", action: "TIKTOK_COMPLETE_IN_APP", transferredAt: new Date().toISOString() });
    return current;
  }
  await save({ status: "PUBLISHED", remoteMediaIds: outcome.postIds, publishedAt: new Date().toISOString() });
  return current;
}
