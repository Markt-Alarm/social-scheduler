#!/usr/bin/env node
// Kalender-Verifikation: Tagesübersicht + Kollisionsprüfung der Cloud-Queue.
import { getObjectText, r2Credentials } from "./cloud-lib.mjs";
import { normalizeQueue } from "./queue-store.mjs";

const credentials = r2Credentials();
const queue = normalizeQueue(JSON.parse(await getObjectText(credentials, "scheduler/queue.json")));
const items = queue.items.slice().sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
const fmt = (item) => `${(item.scheduledLocal ?? item.scheduledAt).slice(11, 16)} ${queue.accounts[item.accountId]?.shortName ?? item.accountId} ${item.kind} [${item.platforms.join("+")}]`;
console.log("Items gesamt:", items.length);
const byDay = {};
for (const item of items) {
  const day = (item.scheduledLocal ?? item.scheduledAt).slice(0, 10);
  (byDay[day] = byDay[day] || []).push(item);
}
for (const [day, list] of Object.entries(byDay).slice(0, 14)) {
  console.log(`${day}: ${list.map(fmt).join(" | ")}`);
}
let conflicts = 0;
const seen = new Set();
for (const item of items) {
  const key = `${item.scheduledAt}|${item.accountId}`;
  if (seen.has(key)) {
    conflicts += 1;
    console.log("KOLLISION:", key, item.fingerprint.slice(0, 8));
  }
  seen.add(key);
}
const weekends = items.filter((item) => item.brand === "werkstern" && [0, 6].includes(new Date(item.scheduledAt).getUTCDay()));
console.log("Kollisionen:", conflicts, "| Werkstern am Wochenende:", weekends.length);
