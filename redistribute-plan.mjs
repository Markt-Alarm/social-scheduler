#!/usr/bin/env node
// Verteilt die Cloud-Queue schön um den v3-Redaktionsplan:
// - Die 46 Ankerposts aus v3-upload-plan.json behalten ihre geplanten Zeiten.
// - Alle uebrigen Items (Story-Serien, Carousels, MZM-Beitraege) werden konfliktfrei
//   in die freien Slots eingewebt: Werkstern nur Mo-Fr (09:30/17:30), MZM täglich (10:00/19:00).
// - Serien (frame-01..05, story-1..6) bleiben als Block zusammen, 1 Minute Abstand, in Reihenfolge.
// Aufruf: node redistribute-plan.mjs [--apply]  (ohne --apply nur Vorschau)
"use strict";

import fs from "node:fs/promises";
import {fail, getObjectText, putObjectText, r2Credentials} from "./cloud-lib.mjs";

const QUEUE_KEY = "scheduler/queue.json";
const PLAN_FILE = "D:\\Kreativ\\Social Media\\v3-upload-plan.json";
const SLOT_WERKSTERN = ["09:30", "17:30"];
const SLOT_MZM = ["10:00", "19:00"];
const SERIES_SUFFIX = /-(?:frame-\d+|\d{1,2})$/;

function seriesKey(source) {
  const base = String(source ?? "").split(/[\\/]/).pop() ?? "";
  return SERIES_SUFFIX.test(base) ? base.replace(SERIES_SUFFIX, "") : null;
}

// Lokale Wanduhrzeit (Europe/Berlin) -> UTC-ISO. Prueft beide moeglichen Offsets.
function berlinToUtcIso(day, hhmm) {
  const wall = `${day}T${hhmm}`;
  for (const offsetMinutes of [120, 60]) {
    const candidate = new Date(`${wall}:00Z`);
    candidate.setUTCMinutes(candidate.getUTCMinutes() - offsetMinutes);
    const parts = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(candidate);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
    if (`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}` === wall) return candidate.toISOString();
  }
  fail(`Zeit nicht auflösbar: ${day} ${hhmm}`);
}

function nextWerksternDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while ([0, 6].includes(date.getUTCDay()));
  return date.toISOString().slice(0, 10);
}

function nextMzmDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const plan = JSON.parse(await fs.readFile(PLAN_FILE, "utf8"));
  const anchorFolders = new Set(plan.items.map((item) => item.folder));
  const credentials = r2Credentials();
  const queue = JSON.parse(await getObjectText(credentials, QUEUE_KEY));
  if (!Array.isArray(queue.items)) fail("Queue ohne items-Array.");

  const anchors = queue.items.filter((item) => {
    const base = String(item.source ?? "").split(/[\\/]/).pop() ?? "";
    return item.brand === "werkstern" && anchorFolders.has(base);
  });
  const extras = queue.items.filter((item) => !anchors.includes(item));
  if (anchors.length !== plan.items.length) {
    process.stdout.write(`Hinweis: ${anchors.length} von ${plan.items.length} Plan-Ankern in der Queue gefunden.\n`);
  }

  // Anker belegen ihre Slots; Vormerkung Tag -> Slot -> Blockname
  const used = new Map();
  const slotKey = (brand, day, hhmm) => `${brand}|${day}|${hhmm}`;
  for (const item of anchors) {
    const day = item.scheduledLocal?.slice(0, 10) ?? item.scheduledAt.slice(0, 10);
    const hhmm = item.scheduledLocal?.slice(11, 16) ?? item.scheduledAt.slice(11, 16);
    used.set(slotKey(item.brand, day, hhmm), "ANKER");
  }

  // Extras nach Originalzeit sortieren; Serien per Schluessel zu Bloecken gruppiieren.
  const orderOf = new Map(queue.items.map((item, index) => [item, index]));
  extras.sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)) || orderOf.get(left) - orderOf.get(right));
  const blockByKey = new Map();
  const blocks = [];
  for (const item of extras) {
    const base = item.brand === "werkstern" || item.brand === "massage-zuhause" ? seriesKey(item.source) : null;
    const key = base ? `${item.brand}|${base}` : `single-${orderOf.get(item)}`;
    let block = blockByKey.get(key);
    if (!block) {
      block = { key, brand: item.brand, items: [] };
      blockByKey.set(key, block);
      blocks.push(block);
    }
    block.items.push(item);
  }
  blocks.forEach((block) => block.items.sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)) || orderOf.get(left) - orderOf.get(right)));

  const changes = [];
  for (const block of blocks) {
    const slots = block.brand === "werkstern" ? SLOT_WERKSTERN : SLOT_MZM;
    const first = block.items[0];
    let day = first.scheduledLocal?.slice(0, 10) ?? first.scheduledAt.slice(0, 10);
    const preferEvening = Number((first.scheduledLocal ?? first.scheduledAt).slice(11, 13)) >= 15;
    for (;;) {
      const order = preferEvening ? [slots[1], slots[0]] : slots;
      const free = order.find((hhmm) => !used.has(slotKey(block.brand, day, hhmm)));
      if (free) {
        block.items.forEach((item, index) => {
          const minutes = String(Number(free.slice(3)) + index).padStart(2, "0");
          const hhmm = `${free.slice(0, 3)}${minutes}`;
          const newUtc = berlinToUtcIso(day, hhmm);
          if (item.scheduledAt !== newUtc) {
            changes.push({ fingerprint: item.fingerprint.slice(0, 8), brand: item.brand, kind: item.kind, alt: `${item.scheduledLocal ?? item.scheduledAt}`, neu: `${day}T${hhmm}` });
          }
          item.scheduledAt = newUtc;
          item.scheduledLocal = `${day}T${hhmm}`;
        });
        used.set(slotKey(block.brand, day, free), block.key);
        break;
      }
      day = block.brand === "werkstern" ? nextWerksternDay(day) : nextMzmDay(day);
    }
  }

  queue.items.sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)));
  queue.updatedAt = new Date().toISOString();

  process.stdout.write(`Bloecke: ${blocks.length} | Anker unverändert: ${anchors.length} | Zeit-Änderungen: ${changes.length}\n`);
  for (const change of changes) process.stdout.write(`  ${change.fingerprint} ${change.brand}/${change.kind}: ${change.alt} -> ${change.neu}\n`);
  if (apply) {
    await putObjectText(credentials, QUEUE_KEY, JSON.stringify(queue, null, 1));
    process.stdout.write("Queue gespeichert.\n");
  } else {
    process.stdout.write("(Vorschau — mit --apply speichern)\n");
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
