#!/usr/bin/env node
// Seeder (lokal auf dem PC ausfuehren): uebertraegt geplante Pakete in die Cloud-Queue.
// 1. Liest .upload-state/items/*.json (Status SCHEDULED, liveIntent true).
// 2. Laedt die Mediendatei jedes Pakets nach R2: media/<brand>/<fingerprint><ext>.
// 3. Aktualisiert scheduler/queue.json im Bucket (Upsert je Fingerprint, vorhandene
//    PUBLISHED/AMBIGUOUS-Status bleiben unberuehrt).
// Aufruf: node seed-cloud-queue.mjs [--state "D:\\Kreativ\\Social Media\\.upload-state"]
"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import {contentTypeFor, fail, getObjectText, headObject, putObjectFile, putObjectText, r2Credentials, sha256File} from "./cloud-lib.mjs";

const QUEUE_KEY = "scheduler/queue.json";
const DEFAULT_STATE = "D:\\Kreativ\\Social Media\\.upload-state";
const UPLOAD_CONFIG = "D:\\Kreativ\\Social Media\\upload-config.json";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readManifest(raw) {
  if (raw.schemaVersion === 1 && Array.isArray(raw.media)) {
    const primary = raw.media.find((item) => item?.role === "primary");
    if (!primary) fail("Manifest hat keinen primary-Media-Eintrag.");
    return { brand: raw.brand, kind: raw.kind, platforms: raw.platforms ?? ["instagram", "facebook"], mediaPath: primary.path, instagram: raw.instagram ?? {}, facebook: raw.facebook ?? {} };
  }
  if (raw.schema_version === 1 && raw.files && raw.status === "ready") {
    return { brand: raw.account, kind: raw.media_type, platforms: raw.platforms ?? ["instagram", "facebook"], mediaPath: raw.files.media, instagram: {}, facebook: { title: raw.title ?? "" } };
  }
  fail("manifest.json entspricht keinem unterstuetzten Schema.");
}

async function main() {
  const stateDir = path.resolve(arg("state") ?? DEFAULT_STATE);
  const itemsDir = path.join(stateDir, "items");
  const uploadConfig = JSON.parse(await fs.readFile(UPLOAD_CONFIG, "utf8"));
  const credentials = r2Credentials();

  const queueText = await getObjectText(credentials, QUEUE_KEY);
  const queue = queueText === null ? { schemaVersion: 1, items: [] } : JSON.parse(queueText);
  if (!Array.isArray(queue.items)) fail("queue.json im Bucket hat kein items-Array.");

  const names = (await fs.readdir(itemsDir)).filter((name) => name.endsWith(".json"));
  let seeded = 0;
  let skipped = 0;
  for (const name of names) {
    const local = JSON.parse(await fs.readFile(path.join(itemsDir, name), "utf8"));
    if (local.status !== "SCHEDULED" || local.liveIntent !== true) {
      skipped += 1;
      continue;
    }
    const fingerprint = String(local.fingerprint).toLowerCase();
    const packageRoot = local.packageRoot;
    const manifest = readManifest(JSON.parse(await fs.readFile(path.join(packageRoot, "manifest.json"), "utf8")));
    if (manifest.brand !== local.brand || manifest.kind !== local.kind) fail(`Brand/Kind widersprechen sich in ${packageRoot}`);
    const caption = (await fs.readFile(path.join(packageRoot, "description.txt"), "utf8")).trim();
    if (!caption || caption.length > 2200) fail(`Caption ungueltig in ${packageRoot}`);
    if (caption.includes("\uFFFD")) fail(`Caption mit defektem UTF-8 in ${packageRoot}`);

    const mediaFile = path.resolve(packageRoot, manifest.mediaPath);
    const stat = await fs.stat(mediaFile);
    if (!stat.isFile() || stat.size < 1) fail(`Mediendatei fehlt: ${mediaFile}`);
    const extension = path.extname(mediaFile).toLowerCase();
    const contentType = contentTypeFor(extension);
    if (!contentType) fail(`Nicht unterstuetzte Medienerweiterung: ${extension}`);
    const sha256 = await sha256File(mediaFile);
    const objectKey = `media/${manifest.brand}/${fingerprint}${extension}`;
    const existing = await headObject(credentials, objectKey);
    if (!existing.exists || existing.sha256 !== sha256 || existing.bytes !== stat.size) {
      await putObjectFile(credentials, { file: mediaFile, objectKey, contentType, bytes: stat.size, sha256 });
    }

    const account = uploadConfig.accounts[manifest.brand] ?? {};
    const cloudItem = {
      schemaVersion: 1,
      fingerprint,
      brand: manifest.brand,
      kind: manifest.kind,
      platforms: [...manifest.platforms],
      scheduledAt: local.scheduledAt,
      scheduledLocal: local.scheduledLocal ?? null,
      timeZone: local.timeZone ?? uploadConfig.timeZone ?? "Europe/Berlin",
      caption,
      media: { objectKey, path: manifest.mediaPath, contentType, bytes: stat.size, sha256 },
      account: { pageId: account.pageId ?? "", instagramAccountId: account.instagramAccountId ?? "" },
      options: {
        instagram: { shareToFeed: manifest.instagram.shareToFeed !== false },
        facebook: { title: manifest.facebook.title ?? "" }
      },
      source: packageRoot
    };
    const previous = queue.items.find((item) => item.fingerprint === fingerprint);
    if (previous && previous.status && previous.status !== "SCHEDULED") {
      // Bereits in Bearbeitung oder abgeschlossen: Medien auffrischen, Status behalten.
      Object.assign(previous, { ...cloudItem, status: previous.status, platformStates: previous.platformStates, publishedAt: previous.publishedAt, blockedReason: previous.blockedReason, attempts: previous.attempts });
    } else if (previous) {
      queue.items.splice(queue.items.indexOf(previous), 1, { ...previous, ...cloudItem, status: "SCHEDULED", attempts: previous.attempts ?? 0, platformStates: previous.platformStates ?? {} });
    } else {
      queue.items.push({ ...cloudItem, status: "SCHEDULED", attempts: 0, platformStates: {} });
    }
    seeded += 1;
    process.stdout.write(`geplant: ${manifest.brand} ${manifest.kind} ${fingerprint.slice(0, 8)} fuer ${cloudItem.scheduledAt}\n`);
  }

  queue.updatedAt = new Date().toISOString();
  await putObjectText(credentials, QUEUE_KEY, JSON.stringify(queue, null, 1));
  process.stdout.write(`Fertig. ${seeded} Items gesendet, ${skipped} uebersprungen, Queue gesamt: ${queue.items.length}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
