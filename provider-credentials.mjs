"use strict";

import { QaBlockedError } from "./cloud-lib.mjs";

let cachedJson;

function credentialsJson() {
  if (cachedJson !== undefined) return cachedJson;
  const raw = process.env.SOCIAL_PROVIDER_CREDENTIALS_JSON;
  if (!raw?.trim()) return (cachedJson = {});
  try {
    cachedJson = JSON.parse(raw);
  } catch {
    throw new QaBlockedError("SOCIAL_PROVIDER_CREDENTIALS_JSON ist kein gueltiges JSON.", { code: "PROVIDER_CREDENTIALS_INVALID" });
  }
  return cachedJson;
}

function fromEnvironment(name) {
  if (!name || !/^[A-Z][A-Z0-9_]{2,127}$/.test(String(name))) return undefined;
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerEntry(accountId, platform) {
  const root = credentialsJson();
  return root.accounts?.[accountId]?.[platform] ?? root[accountId]?.[platform] ?? {};
}

function required(value, label, accountId) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const error = new QaBlockedError(`${label} fuer Account ${accountId} fehlt.`, { code: "WAITING_CONFIGURATION", accountId });
  error.configuration = true;
  throw error;
}

export function metaCredentials(item) {
  const accountId = item.accountId ?? item.brand;
  const account = item.account ?? {};
  const entry = providerEntry(accountId, "meta");
  const legacy = {
    werkstern: "META_WERKSTERN_PAGE_ACCESS_TOKEN",
    "massage-zuhause": "META_MASSAGE_ZUHAUSE_PAGE_ACCESS_TOKEN"
  }[accountId];
  return {
    accessToken: required(entry.accessToken ?? fromEnvironment(account.meta?.accessTokenEnv ?? account.pageAccessTokenEnv ?? legacy), "Meta Access-Token", accountId)
  };
}

export function youtubeCredentials(item) {
  const accountId = item.accountId ?? item.brand;
  const config = item.account?.youtube ?? {};
  const direct = {
    clientId: fromEnvironment(config.clientIdEnv),
    clientSecret: fromEnvironment(config.clientSecretEnv),
    refreshToken: fromEnvironment(config.refreshTokenEnv)
  };
  const entry = direct.clientId && direct.clientSecret && direct.refreshToken
    ? {}
    : providerEntry(accountId, "youtube");
  return {
    clientId: required(direct.clientId ?? entry.clientId, "YouTube OAuth Client-ID", accountId),
    clientSecret: required(direct.clientSecret ?? entry.clientSecret, "YouTube OAuth Client-Secret", accountId),
    refreshToken: required(direct.refreshToken ?? entry.refreshToken, "YouTube OAuth Refresh-Token", accountId)
  };
}

export function youtubeCheckProfiles() {
  const raw = process.env.SOCIAL_YOUTUBE_CHECKS_JSON;
  if (!raw?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new QaBlockedError("SOCIAL_YOUTUBE_CHECKS_JSON ist kein gueltiges JSON.", { code: "YOUTUBE_CHECKS_INVALID" });
  }
  if (!Array.isArray(parsed)) throw new QaBlockedError("SOCIAL_YOUTUBE_CHECKS_JSON muss eine Liste sein.", { code: "YOUTUBE_CHECKS_INVALID" });
  const seenAccounts = new Set();
  return parsed.map((profile, index) => {
    const accountId = String(profile?.accountId ?? "").trim();
    const channelId = String(profile?.channelId ?? "").trim();
    const clientIdEnv = String(profile?.clientIdEnv ?? "").trim();
    const clientSecretEnv = String(profile?.clientSecretEnv ?? "").trim();
    const refreshTokenEnv = String(profile?.refreshTokenEnv ?? "").trim();
    const validEnv = (name) => /^[A-Z][A-Z0-9_]{2,127}$/.test(name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(accountId)
      || !channelId
      || !validEnv(clientIdEnv)
      || !validEnv(clientSecretEnv)
      || !validEnv(refreshTokenEnv)) {
      throw new QaBlockedError(`YouTube-Pruefprofil ${index + 1} ist unvollstaendig.`, { code: "YOUTUBE_CHECKS_INVALID", index });
    }
    if (seenAccounts.has(accountId)) {
      throw new QaBlockedError(`YouTube-Pruefprofil fuer ${accountId} ist doppelt vorhanden.`, { code: "YOUTUBE_CHECKS_INVALID", index, accountId });
    }
    seenAccounts.add(accountId);
    return { accountId, channelId, clientIdEnv, clientSecretEnv, refreshTokenEnv };
  });
}

export function tiktokCredentials(item) {
  const accountId = item.accountId ?? item.brand;
  const config = item.account?.tiktok ?? {};
  const entry = providerEntry(accountId, "tiktok");
  return {
    accessToken: required(entry.accessToken ?? fromEnvironment(config.accessTokenEnv), "TikTok Access-Token", accountId),
    mediaUrlTemplate: entry.mediaUrlTemplate ?? fromEnvironment(config.mediaUrlTemplateEnv) ?? process.env.SOCIAL_TIKTOK_MEDIA_URL_TEMPLATE ?? "",
    mediaBaseUrl: entry.mediaBaseUrl ?? fromEnvironment(config.mediaBaseUrlEnv) ?? process.env.SOCIAL_R2_PUBLIC_BASE_URL ?? "",
    mediaSigningSecret: entry.mediaSigningSecret ?? fromEnvironment(config.mediaSigningSecretEnv) ?? process.env.SOCIAL_R2_PUBLIC_SIGNING_SECRET ?? ""
  };
}

export function resetCredentialCacheForTests() {
  cachedJson = undefined;
}
