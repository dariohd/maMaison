import crypto from "node:crypto";
import { readCookie, valid } from "../lib/session.js";
import { load, save } from "../lib/store.js";

const BLANK = {
  at: null,
  dashboard: {
    counts: { total: 0, online: 0, offline: 0, degraded: 0, unknown: 0 },
    by_type: [],
    by_room: [],
    devices: [],
    attention: [],
    last_scan: null,
  },
  devices: [],
  types: [],
  rooms: [],
  settings: { subnet: "", ping_timeout_ms: 400, poll_interval_s: 30, http_timeout_s: 2 },
  network: { hostname: "", local_ip: "", gateway: "", suggested_subnet: "", adapter_name: "", adapters: [] },
  presets: [],
  scan: { state: "idle" },
};

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function partsOf(req) {
  const query = req.query || {};
  if (Array.isArray(query.path)) return query.path.map(String);
  if (typeof query.path === "string" && query.path) return [query.path];
  const raw = (req.url || "").split("?")[0];
  return raw.replace(/^\/api\/?/, "").split("/").filter(Boolean);
}

function house(state) {
  return Boolean(state.seenAt && Date.now() - state.seenAt < 25000);
}

async function enqueue(res, method, path) {
  const state = await load();
  const pending = state.queue.filter((job) => job.status !== "done");
  if (pending.length >= 20) {
    send(res, 429, { detail: "Trop de commandes en attente." });
    return;
  }
  const id = crypto.randomUUID();
  state.queue.push({
    id,
    method,
    path,
    status: "pending",
    createdAt: Date.now(),
  });
  await save(state);
  send(res, 200, { queued: true, id, detail: "Commande envoyée à la maison." });
}

export default async function handler(req, res) {
  if (!valid(readCookie(req))) {
    send(res, 401, { detail: "Connexion requise" });
    return;
  }
  const parts = partsOf(req);
  const method = req.method || "GET";
  const state = await load();
  const snap = state.snapshot || BLANK;

  if (method === "GET" && parts.length === 1 && parts[0] === "dashboard") {
    send(res, 200, { ...(snap.dashboard || BLANK.dashboard), house: { online: house(state), at: snap.at || null } });
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "devices") {
    send(res, 200, snap.devices || []);
    return;
  }
  if (method === "GET" && parts[0] === "devices" && parts.length === 2) {
    const device = (snap.devices || []).find((item) => String(item.id) === parts[1]);
    if (!device) {
      send(res, 404, { detail: "Appareil introuvable" });
      return;
    }
    send(res, 200, device);
    return;
  }
  if (method === "GET" && parts[0] === "devices" && parts[2] === "history") {
    send(res, 200, []);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "types") {
    send(res, 200, snap.types || []);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "rooms") {
    send(res, 200, snap.rooms || []);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "settings") {
    send(res, 200, snap.settings || BLANK.settings);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "network") {
    send(res, 200, snap.network || BLANK.network);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "presets") {
    send(res, 200, snap.presets || []);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "scan") {
    send(res, 200, snap.scan || { state: "idle" });
    return;
  }
  if (method === "GET" && parts[0] === "jobs" && parts[1]) {
    const job = state.queue.find((item) => item.id === parts[1]);
    if (!job) {
      send(res, 404, { detail: "Commande introuvable" });
      return;
    }
    send(res, 200, { done: job.status === "done", result: job.result || null });
    return;
  }
  if (method === "POST" && parts.length === 1 && parts[0] === "check") {
    await enqueue(res, "POST", "/api/check");
    return;
  }
  if (
    method === "POST"
    && parts[0] === "devices"
    && parts[2] === "actions"
    && parts[4] === "run"
    && /^\d+$/.test(parts[1] || "")
    && /^\d+$/.test(parts[3] || "")
  ) {
    await enqueue(res, "POST", `/api/devices/${parts[1]}/actions/${parts[3]}/run`);
    return;
  }
  if (method !== "GET") {
    send(res, 400, { detail: "Cette modification se fait sur l'ordinateur de la maison." });
    return;
  }
  send(res, 404, { detail: "Introuvable" });
}
