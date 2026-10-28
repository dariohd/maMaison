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
