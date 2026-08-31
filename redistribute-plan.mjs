#!/usr/bin/env node
// Verteilt die Cloud-Queue schön um den v3-Redaktionsplan:
// - Die 46 Ankerposts aus v3-upload-plan.json behalten ihre geplanten Zeiten.
// - Alle uebrigen Items (Story-Serien, Carousels, MZM-Beitraege) werden konfliktfrei
//   in die je Account konfigurierten freien Slots eingewebt.
// - Serien (frame-01..05, story-1..6) bleiben als Block zusammen, 1 Minute Abstand, in Reihenfolge.
// Aufruf: node redistribute-plan.mjs [--apply]  (ohne --apply nur Vorschau)
"use strict";

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {fail, getObjectText, r2Credentials} from "./cloud-lib.mjs";
import {mutateQueueWithCas, nextActionAt, normalizeQueue} from "./queue-store.mjs";

const QUEUE_KEY = "scheduler/queue.json";
const PLAN_FILE = "D:\\Kreativ\\Social Media\\v3-upload-plan.json";
const UPLOAD_CONFIG = "D:\\Kreativ\\Social Media\\upload-config.json";
const SERIES_SUFFIX = /-(?:frame-\d+|\d{1,2})$/;
const MOVABLE_TARGET_STATUSES = new Set(["PENDING", "SCHEDULED", "RETRY_SCHEDULED", "WAITING_APPROVAL", "WAITING_CONFIGURATION"]);
const TERMINAL_TARGET_STATUSES = new Set(["PUBLISHED", "FAILED", "AMBIGUOUS", "ACTION_REQUIRED", "CANCELLED"]);

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

function nextAllowedDay(day, weekdays) {
  const date = new Date(`${day}T12:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (!weekdays.includes(date.getUTCDay() === 0 ? 7 : date.getUTCDay()));
  return date.toISOString().slice(0, 10);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const plan = JSON.parse(await fs.readFile(PLAN_FILE, "utf8"));
  const uploadConfig = JSON.parse(await fs.readFile(UPLOAD_CONFIG, "utf8"));
  const anchorFolders = new Set(plan.items.map((item) => item.folder));
  const credentials = r2Credentials();
  const queue = normalizeQueue(JSON.parse(await getObjectText(credentials, QUEUE_KEY)));
  if (!Array.isArray(queue.items)) fail("Queue ohne items-Array.");
  const planningBasis = queueScheduleBasis(queue);

  const anchors = queue.items.filter((item) => {
    const base = String(item.source ?? "").split(/[\\/]/).pop() ?? "";
    return item.brand === "werkstern" && anchorFolders.has(base);
  });
  const extras = queue.items.filter((item) => !anchors.includes(item) && hasMovableTarget(item));
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
    const base = seriesKey(item.source);
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
    const accountSlots = uploadConfig.accounts?.[block.brand]?.slots ?? {};
    const slots = Array.isArray(accountSlots.times) ? accountSlots.times : [];
    const weekdays = Array.isArray(accountSlots.weekdays) ? accountSlots.weekdays.map(Number) : [];
    if (!slots.length || !weekdays.length) fail(`Keine Redaktionsslots fuer Account ${block.brand} konfiguriert.`);
    const first = block.items[0];
    let day = first.scheduledLocal?.slice(0, 10) ?? first.scheduledAt.slice(0, 10);
    const preferEvening = Number((first.scheduledLocal ?? first.scheduledAt).slice(11, 13)) >= 15;
    for (;;) {
      const order = preferEvening && slots.length > 1 ? [slots[slots.length - 1], ...slots.slice(0, -1)] : slots;
      const free = order.find((hhmm) => !used.has(slotKey(block.brand, day, hhmm)));
      if (free) {
        block.items.forEach((item, index) => {
          const minutes = String(Number(free.slice(3)) + index).padStart(2, "0");
          const hhmm = `${free.slice(0, 3)}${minutes}`;
          const newUtc = berlinToUtcIso(day, hhmm);
          if (item.scheduledAt !== newUtc) {
            changes.push({ fingerprint: item.fingerprint.slice(0, 8), brand: item.brand, kind: item.kind, alt: `${item.scheduledLocal ?? item.scheduledAt}`, neu: `${day}T${hhmm}` });
          }
          shiftItemSchedule(item, newUtc, `${day}T${hhmm}`);
        });
        used.set(slotKey(block.brand, day, free), block.key);
        break;
      }
      day = nextAllowedDay(day, weekdays);
    }
  }

  queue.items.sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)));
  queue.updatedAt = new Date().toISOString();

  process.stdout.write(`Bloecke: ${blocks.length} | Anker unverändert: ${anchors.length} | Zeit-Änderungen: ${changes.length}\n`);
  for (const change of changes) process.stdout.write(`  ${change.fingerprint} ${change.brand}/${change.kind}: ${change.alt} -> ${change.neu}\n`);
  if (apply) {
    const scheduleByFingerprint = new Map(extras.map((item) => [item.fingerprint, { scheduledAt: item.scheduledAt, scheduledLocal: item.scheduledLocal }]));
    await mutateQueueWithCas(credentials, (latest) => {
      if (queueScheduleBasis(latest) !== planningBasis) {
        throw new Error("Queue aenderte sich seit der Vorschau; Umverteilung wurde ohne Schreibzugriff abgebrochen. Befehl erneut starten.");
      }
      for (const item of latest.items) {
        const schedule = scheduleByFingerprint.get(item.fingerprint);
        if (schedule && hasMovableTarget(item)) shiftItemSchedule(item, schedule.scheduledAt, schedule.scheduledLocal);
      }
      latest.items.sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)));
      return { value: latest.items.length };
    });
    process.stdout.write("Queue per ETag/CAS gespeichert.\n");
  } else {
    process.stdout.write("(Vorschau — mit --apply speichern)\n");
  }
}

function queueScheduleBasis(queue) {
  return JSON.stringify((queue.items ?? [])
    .map((item) => ({
      fingerprint: item.fingerprint,
      scheduledAt: item.scheduledAt,
      targets: (item.targets ?? []).map((target) => ({
        id: target.id,
        actionAt: target.actionAt,
        status: item.targetStates?.[target.id]?.status,
        stateActionAt: item.targetStates?.[target.id]?.actionAt
      })).sort((left, right) => String(left.id).localeCompare(String(right.id)))
    }))
    .sort((left, right) => String(left.fingerprint).localeCompare(String(right.fingerprint))));
}

function hasMovableTarget(item) {
  const statuses = (item.targets ?? []).map((target) => String(item.targetStates?.[target.id]?.status ?? "PENDING").toUpperCase());
  return statuses.some((status) => MOVABLE_TARGET_STATUSES.has(status))
    && statuses.every((status) => MOVABLE_TARGET_STATUSES.has(status) || TERMINAL_TARGET_STATUSES.has(status));
}

export function shiftItemSchedule(item, scheduledAt, scheduledLocal) {
  const oldScheduledMs = Date.parse(item.scheduledAt);
  const newScheduledMs = Date.parse(scheduledAt);
  if (!Number.isFinite(oldScheduledMs) || !Number.isFinite(newScheduledMs)) fail("Item enthaelt eine ungueltige Planzeit.");
  const deltaMs = newScheduledMs - oldScheduledMs;
  item.targetStates = { ...(item.targetStates ?? {}) };
  item.platformStates = { ...(item.platformStates ?? {}) };
  item.targets = (item.targets ?? []).map((target) => {
    const state = item.targetStates[target.id] ?? item.platformStates[target.platform] ?? { status: "PENDING" };
    if (!MOVABLE_TARGET_STATUSES.has(String(state.status ?? "PENDING").toUpperCase())) return target;
    const previousActionMs = Date.parse(target.actionAt ?? state.actionAt ?? item.scheduledAt);
    if (!Number.isFinite(previousActionMs)) fail(`Ziel ${target.id} enthaelt eine ungueltige Aktionszeit.`);
    const actionAt = new Date(previousActionMs + deltaMs).toISOString();
    const nextState = { ...state, actionAt };
    item.targetStates[target.id] = nextState;
    item.platformStates[target.platform] = nextState;
    return { ...target, actionAt };
  });
  item.scheduledAt = new Date(newScheduledMs).toISOString();
  item.scheduledLocal = scheduledLocal;
  item.nextActionAt = nextActionAt(item);
  item.updatedAt = new Date().toISOString();
  return item;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
