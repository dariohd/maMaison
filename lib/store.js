import crypto from "node:crypto";
import { get, put } from "@vercel/blob";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeHouse(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatHouse(id) {
  const clean = normalizeHouse(id);
  if (clean.length !== 8) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

export function newHouseId() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function pathOf(id) {
  return `houses/${normalizeHouse(id)}.json`;
}

function livePath(id) {
  return `houses/${normalizeHouse(id)}.live.json`;
}

function queuePath(id) {
  return `houses/${normalizeHouse(id)}.queue.json`;
}

function missing(error) {
  const message = String(error && error.message ? error.message : error);
  return /404|not found|NotFound|BlobNotFound/i.test(message);
}

async function textOf(result) {
  if (!result || result.statusCode === 404) return null;
  if (result.stream) return new Response(result.stream).text();
  if (result.blob && typeof result.blob.text === "function") return result.blob.text();
  if (typeof result.text === "function") return result.text();
  return null;
}

export async function load(id) {
  const house = normalizeHouse(id);
  if (house.length !== 8) return null;
  try {
    const result = await get(pathOf(house), { access: "private", useCache: false });
    const text = await textOf(result);
    if (!text) return null;
    const data = JSON.parse(text);
    if (!Array.isArray(data.queue)) data.queue = [];
    data.id = house;
    return data;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function save(state) {
  const house = normalizeHouse(state.id);
  state.id = house;
  await put(pathOf(house), JSON.stringify(state), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });
}

async function readBlob(path) {
  try {
    const result = await get(path, { access: "private", useCache: false });
    const text = await textOf(result);
    if (!text) return null;
    return JSON.parse(text);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function loadLive(id) {
  const house = normalizeHouse(id);
  if (house.length !== 8) return null;
  const data = await readBlob(livePath(house));
  if (!data || typeof data !== "object") return null;
  return { seenAt: Number(data.seenAt) || 0, snapshot: data.snapshot || null };
}

export async function saveLive(id, snapshot) {
  const house = normalizeHouse(id);
  await put(livePath(house), JSON.stringify({ seenAt: Date.now(), snapshot }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });
}

export async function loadQueue(id) {
  const house = normalizeHouse(id);
  if (house.length !== 8) return null;
  const data = await readBlob(queuePath(house));
  if (!data || !Array.isArray(data.queue)) return null;
  return data.queue;
}

export async function saveQueue(id, queue) {
  const house = normalizeHouse(id);
  await put(queuePath(house), JSON.stringify({ queue }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

export async function update(id, change) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await load(id);
    if (!state) return { ok: false, missing: true };
    const snapshot = JSON.stringify(state);
    const result = change(state) || {};
    if (result.abort) return { ok: false, abort: result.abort, state };
    const touched = changedKeys(JSON.parse(snapshot), state);
    const latest = await load(id);
    if (!latest) return { ok: false, missing: true };
    if (JSON.stringify(latest) !== snapshot) continue;
    for (const key of touched) latest[key] = state[key];
    await save(latest);
    const fresh = await load(id);
    if (!fresh) continue;
    const stuck = touched.every((key) => JSON.stringify(fresh[key]) === JSON.stringify(state[key]));
    if (stuck && (!result.expect || result.expect(fresh))) return { ok: true, state: fresh };
  }
  return { ok: false, abort: "retry" };
}

export async function allowHouseCreate(ip) {
  const path = "meta/create-rate.json";
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const mark = crypto.createHash("sha256").update(String(ip || "0")).digest("hex").slice(0, 16);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const data = (await readBlob(path)) || { hits: [] };
    const snapshot = JSON.stringify(data);
    const hits = (Array.isArray(data.hits) ? data.hits : []).filter((item) => now - Number(item.at || 0) < hour);
    if (hits.length >= 40 || hits.filter((item) => item.ip === mark).length >= 5) return false;
    hits.push({ ip: mark, at: now });
    const latest = await readBlob(path);
    if (latest && JSON.stringify(latest) !== snapshot) continue;
    await put(path, JSON.stringify({ hits }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 0,
    });
    return true;
  }
  return false;
}

export async function updateQueue(id, change) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const auth = await load(id);
    const stored = await loadQueue(id);
    const queue = stored || (Array.isArray(auth && auth.queue) ? auth.queue.map((item) => ({ ...item })) : []);
    const snapshot = JSON.stringify(queue);
    const result = change(queue) || {};
    if (result.abort) return { ok: false, abort: result.abort, queue };
    if (result.skip) return { ok: true, queue, skipped: true };
    const latest = await loadQueue(id);
    if (latest && JSON.stringify(latest) !== snapshot) continue;
    await saveQueue(id, queue);
    const fresh = await loadQueue(id);
    if (fresh && (!result.expect || result.expect(fresh))) return { ok: true, queue: fresh };
  }
  return { ok: false, abort: "retry" };
}
