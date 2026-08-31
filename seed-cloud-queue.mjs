#!/usr/bin/env node
// Lokaler Seeder: validiert geplante Upload-Skill-Items erneut, legt Medien
// inhaltadressiert in R2 ab und fuehrt Queue-Aenderungen per ETag/CAS zusammen.
"use strict";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { contentTypeFor, headObject, putObjectFile, r2Credentials, sha256File } from "./cloud-lib.mjs";
import { accountRegistryFromConfig, mergeSeedItem, mutateQueueWithCas, normalizeTargets, SUPPORTED_PLATFORMS } from "./queue-store.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_STATE = "D:\\Kreativ\\Social Media\\.upload-state";
const DEFAULT_CONFIG = "D:\\Kreativ\\Social Media\\upload-config.json";
const DEFAULT_VALIDATOR = "C:\\Users\\aaron\\.codex\\skills\\upload\\scripts\\validate-package.mjs";
const SUPPORTED_KINDS = new Set(["post", "story", "reel", "video", "carousel"]);
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;
const CLOUD_CLAIMABLE_STATUSES = new Set(["SCHEDULED", "WAITING_APPROVAL", "PARTIAL", "NEEDS_CONFIGURATION", "CLOUD_SYNC_PENDING", "CLOUD_SCHEDULED"]);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestedFingerprints() {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--fingerprint") values.push(...String(process.argv[index + 1] ?? "").split(","));
  }
  const normalized = values.map((value) => value.trim().toLowerCase()).filter(Boolean);
  for (const fingerprint of normalized) if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`Ungueltiger --fingerprint: ${fingerprint}`);
  return new Set(normalized);
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
      await fs.copyFile(temporary, file);
      await fs.unlink(temporary).catch(() => {});
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function withLocalItemLock(stateDir, fingerprint, lockStaleMinutes, operation) {
  const lockPath = path.join(stateDir, "locks", `${fingerprint}.lock`);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(lockPath).catch(() => null);
    const staleMs = Number(lockStaleMinutes ?? 120) * 60_000;
    if (stat && Number.isFinite(staleMs) && staleMs > 0 && Date.now() - stat.mtimeMs > staleMs) {
      await fs.unlink(lockPath).catch(() => {});
      handle = await fs.open(lockPath, "wx").catch(() => null);
    }
    if (!handle) throw new Error("Ein lokaler Publisher besitzt bereits den Item-Lock; Cloud-Uebergabe bleibt unveraendert.");
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), owner: "cloud-seeder" }));
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function updateLocalCloudState(file, fingerprint, patch) {
  const latest = JSON.parse(await fs.readFile(file, "utf8"));
  if (String(latest.fingerprint ?? "").toLowerCase() !== fingerprint) throw new Error(`Lokales Item ${path.basename(file)} wechselte waehrend des Cloud-Syncs den Fingerprint.`);
  Object.assign(latest, patch, { updatedAt: new Date().toISOString() });
  await writeJsonAtomic(file, latest);
  return latest;
}

async function claimLocalForCloud(file, local) {
  const fingerprint = String(local.fingerprint ?? "").toLowerCase();
  if (!CLOUD_CLAIMABLE_STATUSES.has(String(local.status))) throw new Error(`Lokaler Status ${local.status} kann nicht an die Cloud uebergeben werden.`);
  const previousStatus = local.preCloudStatus ?? (String(local.status).startsWith("CLOUD_") ? null : local.status);
  const claimed = await updateLocalCloudState(file, fingerprint, {
    status: "CLOUD_SYNC_PENDING",
    cloudAuthority: true,
    preCloudStatus: previousStatus,
    cloudSyncStartedAt: new Date().toISOString(),
    cloudSyncAttempts: Number(local.cloudSyncAttempts ?? 0) + 1,
    cloudSyncError: null
  });
  process.stdout.write(`CLOUD_SYNC_PENDING ${fingerprint.slice(0, 8)} ${claimed.accountId ?? claimed.brand}\n`);
  return claimed;
}

function normalizeManifest(raw) {
  if (raw.schemaVersion === 1 && Array.isArray(raw.media)) {
    return {
      brand: raw.brand,
      kind: raw.kind,
      platforms: raw.platforms,
      media: raw.media,
      mediaPath: (raw.media.find((item) => item?.role === "primary") ?? {}).path,
      options: {
        instagram: { shareToFeed: raw.instagram?.shareToFeed !== false },
        facebook: { title: raw.facebook?.title ?? "" },
        youtube: raw.youtube ?? {},
        tiktok: raw.tiktok ?? {}
      }
    };
  }
  if (raw.schema_version === 1 && raw.files && raw.status === "ready") {
    return {
      brand: raw.account,
      kind: raw.media_type,
      platforms: raw.platforms,
      media: [{ role: "primary", path: raw.files.media }],
      mediaPath: raw.files.media,
      options: { instagram: { shareToFeed: true }, facebook: { title: raw.title ?? "" }, youtube: raw.youtube ?? {}, tiktok: raw.tiktok ?? {} }
    };
  }
  throw new Error("manifest.json entspricht keinem unterstuetzten Schema.");
}

function accountSnapshot(config, accountId) {
  const raw = config.accounts?.[accountId];
  if (!raw) throw new Error(`Account ${accountId} fehlt in upload-config.json.`);
  return {
    purpose: raw.purpose ?? "organic",
    pageId: raw.pageId ?? raw.meta?.pageId ?? "",
    instagramAccountId: raw.instagramAccountId ?? raw.meta?.instagramAccountId ?? "",
    pageAccessTokenEnv: raw.pageAccessTokenEnv ?? raw.meta?.accessTokenEnv ?? "",
    meta: {
      pageId: raw.pageId ?? raw.meta?.pageId ?? "",
      instagramAccountId: raw.instagramAccountId ?? raw.meta?.instagramAccountId ?? "",
      accessTokenEnv: raw.pageAccessTokenEnv ?? raw.meta?.accessTokenEnv ?? ""
    },
    youtube: raw.youtube ? {
      enabled: raw.youtube.enabled !== false,
      channelId: raw.youtube.channelId ?? "",
      clientIdEnv: raw.youtube.clientIdEnv ?? "",
      clientSecretEnv: raw.youtube.clientSecretEnv ?? "",
      refreshTokenEnv: raw.youtube.refreshTokenEnv ?? "",
      auditApproved: raw.youtube.auditApproved === true
    } : undefined,
    tiktok: raw.tiktok ? {
      enabled: raw.tiktok.enabled !== false,
      openId: raw.tiktok.openId ?? "",
      mode: raw.tiktok.mode ?? "inbox",
      accessTokenEnv: raw.tiktok.accessTokenEnv ?? "",
      mediaUrlTemplateEnv: raw.tiktok.mediaUrlTemplateEnv ?? "",
      verifiedUrlPrefix: raw.tiktok.verifiedUrlPrefix ?? "",
      auditApproved: raw.tiktok.directPostAuditApproved === true || raw.tiktok.auditApproved === true,
      approvalTtlMinutes: raw.tiktok.approvalTtlMinutes ?? 24 * 60
    } : undefined
  };
}

async function validateFresh({ validator, configPath, packageRoot, local, platforms }) {
  const args = [validator, "--config", configPath, "--package", packageRoot, "--brand", String(local.accountId ?? local.brand), "--platforms", platforms.join(","), "--identity-version", String(local.identityVersion ?? 1)];
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    stdout = String(error.stdout ?? "");
    let message = "Upload-Skill-QA ist fehlgeschlagen.";
    try {
      const payload = JSON.parse(stdout);
      message = payload.message ?? payload.error ?? message;
    } catch {}
    throw new Error(message);
  }
  const payload = JSON.parse(stdout);
  if (payload.ok !== true || payload.report?.fingerprint !== local.fingerprint) {
    throw new Error(`Frische QA stimmt nicht mit dem geplanten Fingerprint ueberein (${payload.report?.fingerprint ?? "kein Fingerprint"}).`);
  }
  const validatedPackage = payload.validatedPackage;
  if (!validatedPackage || validatedPackage.fingerprint !== local.fingerprint || validatedPackage.contentId !== payload.report?.contentId) {
    throw new Error("Validator lieferte keinen fingerprint- und contentId-gebundenen Paket-Snapshot.");
  }
  return { report: payload.report, validatedPackage };
}

async function readPackageMedia(packageRoot, validatedPackage, credentials) {
  const mediaFiles = [];
  if (validatedPackage.kind === "carousel") {
    const slides = Array.isArray(validatedPackage.slides) ? validatedPackage.slides : [];
    if (slides.length < 2) throw new Error("Carousel-Manifest hat weniger als 2 Slides.");
    slides.forEach((slide, index) => mediaFiles.push({ file: path.resolve(slide.path), label: `slide-${index + 1}`, expected: slide }));
  } else {
    mediaFiles.push({ file: path.resolve(validatedPackage.media?.path ?? ""), label: "", expected: validatedPackage.media });
  }
  const media = [];
  for (const entry of mediaFiles) {
    const stat = await fs.stat(entry.file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Mediendatei fehlt: ${entry.file}`);
    if (stat.size < 1 || stat.size > MAX_SINGLE_PUT_BYTES) throw new Error(`Medium ueberschreitet das 5-GiB-Limit des aktuell implementierten R2-Single-PUT: ${entry.file}`);
    const extension = path.extname(entry.file).toLowerCase();
    const contentType = contentTypeFor(extension);
    if (!contentType) throw new Error(`Nicht unterstuetzte Medienerweiterung: ${extension}`);
    const sha256 = await sha256File(entry.file);
    if (entry.expected?.sha256 !== sha256 || Number(entry.expected?.bytes) !== stat.size || (entry.expected?.extension && entry.expected.extension !== extension)) {
      throw new Error(`Medium aenderte sich nach der frischen Upload-Skill-QA: ${entry.file}`);
    }
    const objectKey = `assets/${sha256.slice(0, 2)}/${sha256}${extension}`;
    const existing = await headObject(credentials, objectKey);
    if (existing.exists && (existing.sha256 !== sha256 || existing.bytes !== stat.size)) {
      throw new Error(`Inhaltsadressiertes R2-Objekt ${objectKey} hat widerspruechliche Hash-/Groessenmetadaten.`);
    }
    if (!existing.exists) {
      await putObjectFile(credentials, { file: entry.file, objectKey, contentType, bytes: stat.size, sha256 });
    }
    media.push({ objectKey, path: path.relative(packageRoot, entry.file), contentType, bytes: stat.size, sha256, role: entry.label || "primary" });
  }
  return media;
}

function buildCloudItem({ local, validatedPackage, media, uploadConfig, packageRoot, tiktokApproval }) {
  const accountId = String(local.accountId ?? validatedPackage.brand ?? local.brand);
  if (accountId !== validatedPackage.brand || String(local.brand ?? accountId) !== accountId) throw new Error("Lokales Item und frische QA binden unterschiedliche Accounts.");
  const platforms = [...new Set((validatedPackage.platforms ?? []).map((value) => String(value).toLowerCase()))];
  if (!platforms.length || platforms.some((platform) => !SUPPORTED_PLATFORMS.includes(platform))) throw new Error("Item enthaelt eine nicht unterstuetzte Plattform.");
  const localTargets = Array.isArray(local.targets) ? local.targets : [];
  for (const target of localTargets) {
    if (String(target?.accountId ?? accountId) !== accountId) throw new Error("Lokales Target verweist auf einen fremden Account.");
    if (!platforms.includes(String(target?.platform ?? "").toLowerCase())) throw new Error("Lokales Target ist nicht durch den frischen QA-Plattform-Snapshot gebunden.");
  }
  const localPlatformSet = new Set((local.platforms ?? localTargets.map((target) => target.platform)).map((value) => String(value).toLowerCase()));
  if (localPlatformSet.size !== platforms.length || platforms.some((platform) => !localPlatformSet.has(platform))) {
    throw new Error("Lokale Zielplattformen stimmen nicht mit der frischen QA ueberein.");
  }
  const options = structuredClone(validatedPackage.options ?? {});
  const rawTargets = platforms.map((platform) => {
    const localTarget = localTargets.find((target) => String(target?.platform).toLowerCase() === platform);
    const canonicalId = `${platform}:${accountId}`;
    return {
      id: canonicalId,
      platform,
      accountId,
      options: structuredClone(options[platform] ?? {}),
      actionAt: localTarget?.actionAt ?? local.targetStates?.[canonicalId]?.actionAt ?? local.platformStates?.[platform]?.actionAt ?? local.scheduledAt
    };
  });
  const targetCarrier = { ...local, brand: accountId, accountId, platforms, targets: rawTargets, options };
  const targets = normalizeTargets(targetCarrier).map((target) => ({
    ...target,
    options: structuredClone(options[target.platform] ?? {}),
    ...(target.platform === "tiktok" && tiktokApproval ? { approval: tiktokApproval } : {})
  }));
  return {
    schemaVersion: 2,
    identityVersion: Number(local.identityVersion ?? 1),
    fingerprint: String(local.fingerprint).toLowerCase(),
    contentId: local.contentId ?? null,
    brand: accountId,
    accountId,
    kind: validatedPackage.kind,
    platforms,
    targets,
    targetStates: local.targetStates ?? {},
    platformStates: local.platformStates ?? {},
    scheduledAt: local.scheduledAt,
    nextActionAt: local.nextActionAt ?? null,
    scheduledLocal: local.scheduledLocal ?? null,
    timeZone: local.timeZone ?? uploadConfig.timeZone ?? "Europe/Berlin",
    caption: validatedPackage.caption,
    media: validatedPackage.kind === "carousel" ? { slides: media } : media[0],
    account: accountSnapshot(uploadConfig, accountId),
    options,
    source: packageRoot,
    qaVerifiedAt: new Date().toISOString()
  };
}

async function readTikTokApproval(stateDir, fingerprint) {
  const file = path.join(stateDir, "approvals", `${fingerprint}.tiktok.json`);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`TikTok-Freigabe ist nicht lesbar: ${error.message}`);
  }
  const fields = [
    "schemaVersion", "fingerprint", "contentId", "brand", "creatorOpenId", "creatorNickname",
    "title", "privacyLevel", "allowComment", "allowDuet", "allowStitch", "brandContent",
    "brandOrganic", "videoCoverTimestampMs", "previewConfirmed", "musicUsageConfirmed",
    "expressConsent", "isAigc", "consentVersion", "settingsHash", "approvedAt", "expiresAt"
  ];
  return Object.fromEntries(fields.filter((field) => raw[field] !== undefined).map((field) => [field, raw[field]]));
}

async function main() {
  const stateDir = path.resolve(arg("state") ?? DEFAULT_STATE);
  const configPath = path.resolve(arg("config") ?? DEFAULT_CONFIG);
  const validator = path.resolve(arg("validator") ?? DEFAULT_VALIDATOR);
  const fingerprints = requestedFingerprints();
  if (!fingerprints.size && !process.argv.includes("--all")) throw new Error("Fail-closed: --fingerprint <64-hex> ist Pflicht (oder --all fuer eine bewusste Migration). ");
  const itemsDir = path.join(stateDir, "items");
  const uploadConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  const names = (await fs.readdir(itemsDir)).filter((name) => name.endsWith(".json")).sort();
  const cloudItems = [];
  const problems = [];
  const selected = [];
  const localFileByFingerprint = new Map();
  const matchedFingerprints = new Set();
  const candidates = [];
  for (const name of names) {
    const itemFile = path.join(itemsDir, name);
    const local = JSON.parse(await fs.readFile(itemFile, "utf8"));
    const fingerprint = String(local.fingerprint ?? "").toLowerCase();
    if (fingerprints.size && !fingerprints.has(fingerprint)) continue;
    matchedFingerprints.add(fingerprint);
    candidates.push({ name, itemFile, local, fingerprint });
  }
  const seenFingerprints = new Set();
  for (const candidate of candidates) {
    const rawFingerprint = String(candidate.local.fingerprint ?? "");
    if (!/^[a-f0-9]{64}$/.test(candidate.fingerprint) || rawFingerprint !== candidate.fingerprint) {
      problems.push({ fingerprint: candidate.fingerprint.slice(0, 8), grund: `Lokaler Fingerprint in ${candidate.name} ist ungueltig.` });
      continue;
    }
    if (candidate.name !== `${candidate.fingerprint}.json`) {
      problems.push({ fingerprint: candidate.fingerprint.slice(0, 8), grund: `Item-Dateiname ${candidate.name} stimmt nicht exakt mit dem Fingerprint ueberein.` });
      continue;
    }
    if (seenFingerprints.has(candidate.fingerprint)) {
      problems.push({ fingerprint: candidate.fingerprint.slice(0, 8), grund: `Fingerprint ${candidate.fingerprint.slice(0, 8)} ist mehrfach im lokalen State vorhanden.` });
      continue;
    }
    seenFingerprints.add(candidate.fingerprint);
  }
  if (fingerprints.size && matchedFingerprints.size !== fingerprints.size) problems.push({ grund: "Mindestens ein angeforderter Fingerprint wurde nicht gefunden." });
  if (problems.length) throw new Error(`Cloud-Sync vor dem lokalen Claim blockiert. ${problems.map((problem) => problem.grund).join(" | ")}`);
  for (const candidate of candidates) {
    const { itemFile, fingerprint } = candidate;
    let { local } = candidate;
    try {
      local = await withLocalItemLock(stateDir, fingerprint, uploadConfig.publishing?.lockStaleMinutes, async () => {
        const latest = JSON.parse(await fs.readFile(itemFile, "utf8"));
        if (String(latest.fingerprint ?? "").toLowerCase() !== fingerprint) {
          throw new Error("Lokaler Fingerprint ist ungueltig oder wechselte vor dem Cloud-Claim.");
        }
        if (!latest.liveIntent) throw new Error("liveIntent ist nicht gesetzt.");
        return claimLocalForCloud(itemFile, latest);
      });
      selected.push({ itemFile, local, fingerprint });
      localFileByFingerprint.set(fingerprint, itemFile);
    } catch (error) {
      problems.push({ fingerprint: fingerprint.slice(0, 8), account: local.accountId ?? local.brand, kind: local.kind, package: path.basename(String(local.packageRoot ?? "?")), grund: error.message });
    }
  }
  if (!selected.length) throw new Error(`Kein Item fuer Cloud-Sync beansprucht. ${problems.map((problem) => problem.grund).join(" | ")}`);

  // Erst nach dem lokalen CLOUD_SYNC_PENDING-Claim werden R2-Zugang und Netzwerk benutzt.
  // Damit kann der lokale Publisher bei jedem folgenden Fehler nicht parallel publizieren.
  const credentials = r2Credentials();
  for (const selectedItem of selected) {
    const { itemFile, fingerprint } = selectedItem;
    const local = selectedItem.local;
    try {
      if (!SUPPORTED_KINDS.has(local.kind)) throw new Error(`Kind ${local.kind} wird nicht unterstuetzt.`);
      const packageRoot = String(local.packageRoot ?? "").trim();
      if (!packageRoot) throw new Error("packageRoot fehlt im lokalen Item.");
      const platforms = Array.isArray(local.targets) && local.targets.length ? local.targets.map((target) => target.platform) : (local.platforms ?? uploadConfig.publishing?.defaultPlatforms);
      const fresh = await validateFresh({ validator, configPath, packageRoot, local, platforms });
      const validatedPackage = fresh.validatedPackage;
      if (validatedPackage.kind !== local.kind) throw new Error(`Kind-Widerspruch (QA ${validatedPackage.kind} vs. Item ${local.kind}).`);
      if (validatedPackage.packageRoot !== packageRoot || validatedPackage.brand !== (local.accountId ?? local.brand)) {
        throw new Error("Frischer QA-Paket-Snapshot passt nicht zum lokalen Scheduler-Item.");
      }
      const media = await readPackageMedia(packageRoot, validatedPackage, credentials);
      const tiktokTarget = (local.targets ?? []).find((target) => String(target?.platform).toLowerCase() === "tiktok");
      const configuredTikTokMode = String(tiktokTarget?.options?.mode ?? uploadConfig.accounts?.[local.accountId ?? local.brand]?.tiktok?.mode ?? "inbox").toLowerCase();
      const tiktokApproval = ["direct", "direct-post"].includes(configuredTikTokMode) ? await readTikTokApproval(stateDir, fingerprint) : null;
      cloudItems.push(buildCloudItem({ local, validatedPackage, media, uploadConfig, packageRoot, tiktokApproval }));
    } catch (error) {
      problems.push({ fingerprint: fingerprint.slice(0, 8), account: local.accountId ?? local.brand, kind: local.kind, package: path.basename(String(local.packageRoot ?? "?")), grund: error.message });
      await updateLocalCloudState(itemFile, fingerprint, {
        status: "CLOUD_SYNC_PENDING",
        cloudAuthority: true,
        cloudSyncFailedAt: new Date().toISOString(),
        cloudSyncError: error.message
      }).catch(() => {});
      process.stderr.write(`CLOUD_SYNC_PENDING ${fingerprint.slice(0, 8)}: ${error.message}\n`);
    }
  }
  if (!cloudItems.length) throw new Error(`Kein Item seedbar. ${problems.map((problem) => problem.grund).join(" | ")}`);

  let outcome;
  try {
    outcome = await mutateQueueWithCas(credentials, (queue) => {
      queue.accounts = { ...queue.accounts, ...accountRegistryFromConfig(uploadConfig) };
      for (const incoming of cloudItems) {
        const index = queue.items.findIndex((item) => item.fingerprint === incoming.fingerprint);
        const merged = mergeSeedItem(index >= 0 ? queue.items[index] : null, incoming);
        if (index >= 0) queue.items[index] = merged;
        else queue.items.push(merged);
      }
      queue.items.sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)));
      return { value: { count: queue.items.length } };
    });
  } catch (error) {
    for (const item of cloudItems) {
      const file = localFileByFingerprint.get(item.fingerprint);
      if (file) await updateLocalCloudState(file, item.fingerprint, { status: "CLOUD_SYNC_PENDING", cloudAuthority: true, cloudSyncFailedAt: new Date().toISOString(), cloudSyncError: error.message }).catch(() => {});
    }
    throw error;
  }
  for (const item of cloudItems) {
    const file = localFileByFingerprint.get(item.fingerprint);
    try {
      await updateLocalCloudState(file, item.fingerprint, {
        status: "CLOUD_SCHEDULED",
        cloudAuthority: true,
        cloudQueueKey: "scheduler/queue.json",
        cloudSyncedAt: new Date().toISOString(),
        cloudSyncError: null
      });
      process.stdout.write(`CLOUD_SCHEDULED ${item.fingerprint.slice(0, 8)} ${item.accountId} ${item.kind} fuer ${item.scheduledAt}\n`);
    } catch (error) {
      problems.push({ fingerprint: item.fingerprint.slice(0, 8), account: item.accountId, kind: item.kind, grund: `Cloud-Upsert erfolgreich, lokale Bestaetigung fehlgeschlagen: ${error.message}` });
      process.stderr.write(`CLOUD_SYNC_PENDING ${item.fingerprint.slice(0, 8)}: lokale Bestaetigung fehlgeschlagen\n`);
    }
  }
  process.stdout.write(`\nFertig. ${cloudItems.length} Item(s) per ETag/CAS aktualisiert, Queue gesamt: ${outcome.result.count}.\n`);
  if (problems.length) process.stdout.write(`Uebersprungen: ${JSON.stringify(problems, null, 1)}\n`);
  if (problems.length) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
