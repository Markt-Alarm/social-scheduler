#!/usr/bin/env node
// Upload-Planer: lokales Dashboard fuer die Cloud-Queue.
//   http://127.0.0.1:8791
// - GET  /                Dashboard (dashboard.html)
// - GET  /api/health      Erreichbarkeit
// - GET  /api/queue       Live-Queue aus R2 (Cache 3 s, bei Fehler letzte bekannte Fassung)
// - GET  /api/media?fp=&slide=   Medium aus dem lokalen Paket, sonst 302 auf R2-Presigned-URL
// - POST /api/open        { fp, slide?, target: "file"|"folder" } -> Explorer/Standardprogramm
// Bindet ausschliesslich auf 127.0.0.1; keine Tokens im Frontend.
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getObjectText, headObject, presignGet, r2Credentials } from "./cloud-lib.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve("D:\\Kreativ\\Social Media");
const PORT = 8791;
const QUEUE_KEY = "scheduler/queue.json";
const CACHE_TTL_MS = 3000;

const credentials = r2Credentials();

let cache = { at: 0, queue: null };

async function loadQueue() {
  if (Date.now() - cache.at < CACHE_TTL_MS && cache.queue) return cache.queue;
  try {
    const text = await getObjectText(credentials, QUEUE_KEY);
    if (text !== null) {
      cache = { at: Date.now(), queue: JSON.parse(text) };
    }
  } catch (error) {
    if (!cache.queue) throw error;
  }
  return cache.queue;
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".mov": "video/quicktime" }[ext] ?? "application/octet-stream";
}

async function resolveMedia(fingerprint, slideParam) {
  const queue = await loadQueue();
  const item = queue.items.find((candidate) => candidate.fingerprint.startsWith(fingerprint.toLowerCase()));
  if (!item) return { error: "fingerprint unbekannt", status: 404 };
  const slide = Number(slideParam ?? "0") || 0;
  const entries = item.media.slides ?? [item.media];
  const media = entries[slide];
  if (!media) return { error: "slide unbekannt", status: 404 };
  const localPath = item.source ? path.resolve(item.source, media.path) : null;
  if (localPath && localPath.startsWith(SOURCE_ROOT)) {
    const stat = await fsp.stat(localPath).catch(() => null);
    if (stat?.isFile()) return { localPath, size: stat.size };
  }
  const remote = await headObject(credentials, media.objectKey);
  if (remote.exists) return { redirect: presignGet(credentials, media.objectKey, 3600) };
  return { error: "Medium weder lokal noch in R2 gefunden", status: 404 };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

async function sendMedia(request, response, resolved) {
  if (resolved.redirect) {
    response.writeHead(302, { location: resolved.redirect });
    response.end();
    return;
  }
  const type = contentTypeFor(resolved.localPath);
  const range = request.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), resolved.size - 1) : resolved.size - 1;
    if (start >= resolved.size || start > end) {
      response.writeHead(416, { "content-range": `bytes */${resolved.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${resolved.size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store"
    });
    fs.createReadStream(resolved.localPath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { "content-type": type, "content-length": resolved.size, "accept-ranges": "bytes", "cache-control": "no-store" });
  fs.createReadStream(resolved.localPath).pipe(response);
}

function openInExplorer(targetPath, mode) {
  if (mode === "folder") spawn("explorer.exe", ["/select,", targetPath], { detached: true, stdio: "ignore" }).unref();
  else spawn("explorer.exe", [targetPath], { detached: true, stdio: "ignore" }).unref();
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await fsp.readFile(path.join(ROOT, "dashboard.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, queue: cache.queue ? cache.queue.items.length : null });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/queue") {
      const queue = await loadQueue();
      sendJson(response, 200, queue);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/media") {
      const resolved = await resolveMedia(url.searchParams.get("fp") ?? "", url.searchParams.get("slide"));
      if (resolved.error) sendJson(response, resolved.status, { error: resolved.error });
      else await sendMedia(request, response, resolved);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/open") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body || "{}");
      const resolved = await resolveMedia(String(payload.fp ?? ""), payload.slide);
      if (resolved.error) {
        sendJson(response, resolved.status, { error: resolved.error });
        return;
      }
      if (resolved.redirect) {
        sendJson(response, 409, { error: "Lokale Datei fehlt — Medium existiert nur noch in R2." });
        return;
      }
      openInExplorer(resolved.localPath, payload.target === "folder" ? "folder" : "file");
      sendJson(response, 200, { ok: true, path: resolved.localPath });
      return;
    }
    sendJson(response, 404, { error: "unbekannter Endpunkt" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Upload-Planer laeuft: http://127.0.0.1:${PORT}\n`);
});
