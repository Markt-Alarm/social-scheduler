#!/usr/bin/env node
// Seeder (lokal auf dem PC ausfuehren): uebertraegt den geplanten Redaktionskalender
// in die Cloud-Queue, damit das Publishing PC-unabhaengig laeuft.
// 1. Liest .upload-state/items/*.json (Status SCHEDULED, liveIntent true).
// 2. Laedt die Medien nach R2: media/<brand>/<fingerprint>[-slide-N]<ext>.
// 3. Aktualisiert scheduler/queue.json im Bucket (Upsert je Fingerprint,
//    vorhandene PUBLISHED/AMBIGUOUS/FAILED-Status bleiben unberuehrt).
// Nicht unterstuetzte oder unlesbare Pakete werden uebersprungen und gemeldet.
// Aufruf: node seed-cloud-queue.mjs [--state "D:\\Kreativ\\Social Media\\.upload-state"]
"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import {contentTypeFor, fail, getObjectText, headObject, putObjectFile, putObjectText, r2Credentials, sha256File} from "./cloud-lib.mjs";

const QUEUE_KEY = "scheduler/queue.json";
const DEFAULT_STATE = "D:\\Kreativ\\Social Media\\.upload-state";
const UPLOAD_CONFIG = "D:\\Kreativ\\Social Media\\upload-config.json";
const SUPPORTED_KINDS = new Set(["post", "story", "reel", "video", "carousel"]);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readPackageMedia(packageRoot, manifest, fingerprint, credentials) {
  const mediaFiles = [];
  if (manifest.kind === "carousel") {
    const slides = (manifest.media ?? []).filter((item) => item?.role === "slide");
    if (slides.length < 2) throw new Error("Carousel-Manifest hat weniger als 2 Slides.");
    slides.forEach((slide, index) => mediaFiles.push({ file: path.resolve(packageRoot, slide.path), label: `slide-${index + 1}`, original: slide.path }));
  } else {
    mediaFiles.push({ file: path.resolve(packageRoot, manifest.mediaPath), label: "", original: manifest.mediaPath });
  }
  const media = [];
  for (const entry of mediaFiles) {
    const stat = await fs.stat(entry.file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Mediendatei fehlt: ${entry.file}`);
    if (stat.size < 1 || stat.size > 1024 * 1024 * 1024) throw new Error(`Mediengroesse ungueltig: ${entry.file}`);
    const extension = path.extname(entry.file).toLowerCase();
    const contentType = contentTypeFor(extension);
    if (!contentType) throw new Error(`Nicht unterstuetzte Medienerweiterung: ${extension}`);
    const sha256 = await sha256File(entry.file);
    const suffix = entry.label ? `-${entry.label}` : "";
    const objectKey = `media/${manifest.brand}/${fingerprint}${suffix}${extension}`;
    const existing = await headObject(credentials, objectKey);
    if (!existing.exists || existing.sha256 !== sha256 || existing.bytes !== stat.size) {
      await putObjectFile(credentials, { file: entry.file, objectKey, contentType, bytes: stat.size, sha256 });
    }
    media.push({ objectKey, path: entry.original, contentType, bytes: stat.size, sha256 });
  }
  return media;
}

async function main() {
  const stateDir = path.resolve(arg("state") ?? DEFAULT_STATE);
  const itemsDir = path.join(stateDir, "items");
  const uploadConfig = JSON.parse(await fs.readFile(UPLOAD_CONFIG, "utf8"));
  const credentials = r2Credentials();

  const queueText = await getObjectText(credentials, QUEUE_KEY);
  const queue = queueText === null ? { schemaVersion: 1, items: [] } : JSON.parse(queueText);
  if (!Array.isArray(queue.items)) fail("queue.json im Bucket hat kein items-Array.");

  const names = (await fs.readdir(itemsDir)).filter((name) => name.endsWith(".json")).sort();
  let seeded = 0;
  let skipped = 0;
  const problems = [];
  for (const name of names) {
    const local = JSON.parse(await fs.readFile(path.join(itemsDir, name), "utf8"));
    if (local.status !== "SCHEDULED" || local.liveIntent !== true) {
      skipped += 1;
      continue;
    }
    const fingerprint = String(local.fingerprint).toLowerCase();
    try {
      if (!SUPPORTED_KINDS.has(local.kind)) throw new Error(`Kind "${local.kind}" wird in der Cloud unterstuetzt: ${[...SUPPORTED_KINDS].join(", ")}`);
      const packageRoot = String(local.packageRoot ?? "").trim();
      if (!packageRoot) throw new Error("packageRoot fehlt im lokalen Item.");
      const manifestRaw = JSON.parse(await fs.readFile(path.join(packageRoot, "manifest.json"), "utf8"));
      let manifest;
      if (manifestRaw.schemaVersion === 1 && Array.isArray(manifestRaw.media)) {
        manifest = { kind: manifestRaw.kind, platforms: manifestRaw.platforms ?? ["instagram", "facebook"], media: manifestRaw.media, mediaPath: (manifestRaw.media.find((item) => item?.role === "primary") ?? {}).path, instagram: manifestRaw.instagram ?? {}, facebook: manifestRaw.facebook ?? {} };
      } else if (manifestRaw.schema_version === 1 && manifestRaw.files && manifestRaw.status === "ready") {
        manifest = { kind: manifestRaw.media_type, platforms: manifestRaw.platforms ?? ["instagram", "facebook"], media: [{ role: "primary", path: manifestRaw.files.media }], mediaPath: manifestRaw.files.media, instagram: {}, facebook: { title: manifestRaw.title ?? "" } };
      } else {
        throw new Error("manifest.json entspricht keinem unterstuetzten Schema.");
      }
      if (manifest.kind !== local.kind) throw new Error(`Kind-Widerspruch (Manifest ${manifest.kind} vs. Item ${local.kind}).`);
      if (manifest.kind === "carousel" && manifest.kind === local.kind && !(manifest.media ?? []).some((item) => item?.role === "slide")) {
        throw new Error("Carousel ohne Slide-Medien.");
      }

      const caption = (await fs.readFile(path.join(packageRoot, "description.txt"), "utf8")).trim();
      if (!caption || caption.length > 2200) throw new Error("Caption fehlt oder ueberschreitet 2200 Zeichen.");
      if (caption.includes("\uFFFD")) throw new Error("Caption enthaelt defekte UTF-8-Zeichen.");

      const media = await readPackageMedia(packageRoot, manifest, fingerprint, credentials);
      const account = uploadConfig.accounts[manifestRaw.brand ?? local.brand] ?? {};

      const cloudItem = {
        schemaVersion: 1,
        fingerprint,
        brand: manifestRaw.brand ?? local.brand,
        kind: manifest.kind,
        platforms: [...manifest.platforms],
        scheduledAt: local.scheduledAt,
        scheduledLocal: local.scheduledLocal ?? null,
        timeZone: local.timeZone ?? uploadConfig.timeZone ?? "Europe/Berlin",
        caption,
        media: manifest.kind === "carousel" ? { slides: media } : { ...media[0], slides: undefined },
        account: { pageId: account.pageId ?? "", instagramAccountId: account.instagramAccountId ?? "" },
        options: {
          instagram: { shareToFeed: manifest.instagram.shareToFeed !== false },
          facebook: { title: manifest.facebook.title ?? "" }
        },
        source: packageRoot
      };
      cloudItem.media = manifest.kind === "carousel" ? { slides: media } : media[0];

      const previous = queue.items.find((item) => item.fingerprint === fingerprint);
      if (previous && previous.status && previous.status !== "SCHEDULED") {
        Object.assign(previous, { ...cloudItem, status: previous.status, platformStates: previous.platformStates, publishedAt: previous.publishedAt, blockedReason: previous.blockedReason, attempts: previous.attempts });
      } else if (previous) {
        queue.items.splice(queue.items.indexOf(previous), 1, { ...previous, ...cloudItem, status: "SCHEDULED", attempts: previous.attempts ?? 0, platformStates: previous.platformStates ?? {} });
      } else {
        queue.items.push({ ...cloudItem, status: "SCHEDULED", attempts: 0, platformStates: {} });
      }
      seeded += 1;
      process.stdout.write(`geplant: ${cloudItem.brand} ${cloudItem.kind} ${fingerprint.slice(0, 8)} fuer ${cloudItem.scheduledAt}\n`);
    } catch (error) {
      skipped += 1;
      problems.push({ fingerprint: fingerprint.slice(0, 8), brand: local.brand, kind: local.kind, package: path.basename(String(local.packageRoot ?? "?")), grund: error.message });
      process.stderr.write(`UEBERSPRUNGEN ${fingerprint.slice(0, 8)}: ${error.message}\n`);
    }
  }

  queue.updatedAt = new Date().toISOString();
  await putObjectText(credentials, QUEUE_KEY, JSON.stringify(queue, null, 1));
  process.stdout.write(`\nFertig. ${seeded} Items in der Cloud-Queue, ${skipped} uebersprungen, Queue gesamt: ${queue.items.length}.\n`);
  if (problems.length) {
    process.stdout.write(`\nUebersprungene Items (Details):\n${JSON.stringify(problems, null, 1)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
