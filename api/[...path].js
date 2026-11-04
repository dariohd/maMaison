import crypto from "node:crypto";
import { personRole, phoneWriteAllowed } from "../lib/phone.js";
import { readCookie, valid } from "../lib/session.js";
import { reveal } from "../lib/box.js";
import { formatHouse, load, loadLive, loadQueue, update, updateQueue } from "../lib/store.js";
import { matchTotp, saneLastTotpStep } from "../lib/totp.js";

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

function online(seenAt) {
  return Boolean(seenAt && Date.now() - seenAt < 25000);
}

async function consumeTotp(res, state, session, otp) {
  let secret = reveal(state.totpSecret);
  const personId = session.person && session.person !== "owner" ? session.person : "";
  if (personId) {
    const person = (state.people || []).find((item) => item.id === personId);
    secret = person ? reveal(person.totpSecret) : "";
  }
  const last = saneLastTotpStep(
    personId
      ? ((state.people || []).find((item) => item.id === personId) || {}).lastTotpStep
      : state.lastTotpStep,
  );
  const step = matchTotp(secret, otp, Date.now(), last);
  if (!step) {
    send(res, 400, { detail: "Les 6 chiffres sont incorrects." });
    return false;
  }
  const outcome = await update(state.id, (current) => {
    if (personId) {
      const person = (current.people || []).find((item) => item.id === personId);
      if (!person || Number(person.lastTotpStep || 0) >= step) return { abort: "otp" };
      person.lastTotpStep = step;
      return {
        expect: (fresh) => Number(((fresh.people || []).find((item) => item.id === personId) || {}).lastTotpStep || 0) === step,
      };
    }
    if (Number(current.lastTotpStep || 0) >= step) return { abort: "otp" };
    current.lastTotpStep = step;
    return { expect: (fresh) => Number(fresh.lastTotpStep || 0) === step };
  });
  if (!outcome.ok) {
    send(res, 400, { detail: "Les 6 chiffres sont incorrects." });
    return false;
  }
  return true;
}

async function enqueue(res, houseId, method, path, body) {
  const id = crypto.randomUUID();
  const written = await updateQueue(houseId, (queue) => {
    const pending = queue.filter((job) => job.status !== "done");
    if (pending.length >= 20) return { abort: "full" };
    queue.push({
      id,
      method,
      path,
      body: body || null,
      status: "pending",
      createdAt: Date.now(),
    });
    return { expect: (fresh) => fresh.some((job) => job.id === id) };
  });
  if (written.abort === "full") {
    send(res, 429, { detail: "Trop de commandes en attente." });
    return;
  }
  if (!written.ok) {
    send(res, 503, { detail: "Réessaie." });
    return;
  }
  send(res, 200, { queued: true, id, detail: "Commande envoyée à la maison." });
}

export default async function handler(req, res) {
  const session = valid(readCookie(req));
  if (!session) {
    send(res, 401, { detail: "Connexion requise" });
    return;
  }
  const state = await load(session.house);
  if (!state || (Number(state.sessionEpoch) || 0) !== session.epoch) {
    send(res, 401, { detail: "Connexion requise" });
    return;
  }
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  if (sessions.length && session.sessionId && !sessions.some((item) => item.id === session.sessionId)) {
    send(res, 401, { detail: "Connexion requise" });
    return;
  }
  const parts = partsOf(req);
  const method = req.method || "GET";
  const live = await loadLive(session.house);
  const snap = (live && live.snapshot) || state.snapshot || BLANK;
  const seenAt = (live && live.seenAt) || state.seenAt || 0;
  const role = personRole(state, session);

  if (method === "GET" && parts.length === 1 && parts[0] === "dashboard") {
    send(res, 200, { ...(snap.dashboard || BLANK.dashboard), house: { online: online(seenAt), at: snap.at || null, code: formatHouse(state.id), role } });
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
    const device = (snap.devices || []).find((item) => String(item.id) === parts[1]);
    send(res, 200, (device && device.history) || []);
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
    const queue = (await loadQueue(state.id)) || state.queue || [];
    const job = queue.find((item) => item.id === parts[1]);
    if (!job) {
      send(res, 404, { detail: "Commande introuvable" });
      return;
    }
    send(res, 200, { done: job.status === "done", result: job.result || null });
    return;
  }
  if (method !== "GET" && !phoneWriteAllowed(role, method, parts)) {
    send(res, 403, { detail: "Cette action n'est pas permise pour ce téléphone." });
    return;
  }
  if (method === "POST" && parts.length === 1 && parts[0] === "check") {
    await enqueue(res, state.id, "POST", "/api/check");
    return;
  }
  if (method === "POST" && parts.length === 2 && parts[0] === "alerts" && parts[1] === "read") {
    await enqueue(res, state.id, "POST", "/api/alerts/read");
    return;
  }
  if (method === "POST" && parts[0] === "scenes" && parts[2] === "run" && /^\d+$/.test(parts[1] || "")) {
    const scene = (snap.scenes || []).find((item) => String(item.id) === parts[1]);
    const sensitive = ((scene && scene.steps) || []).some((item) => item.confirm === "totp" || item.confirm === "tap");
    const payload = req.body || {};
    if (sensitive && !(await consumeTotp(res, state, session, payload.otp))) return;
    await enqueue(res, state.id, "POST", `/api/scenes/${parts[1]}/run`, payload);
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
    const payload = req.body || {};
    const device = (snap.devices || []).find((item) => String(item.id) === parts[1]);
    const action = ((device && device.actions) || []).find((item) => String(item.id) === parts[3]);
    if (action && action.confirm === "totp" && !(await consumeTotp(res, state, session, payload.otp))) return;
    await enqueue(res, state.id, "POST", `/api/devices/${parts[1]}/actions/${parts[3]}/run`, payload);
    return;
  }
  if (
    method === "POST"
    && parts[0] === "devices"
    && parts[2] === "actions"
    && parts[4] === "picture"
    && /^\d+$/.test(parts[1] || "")
    && /^\d+$/.test(parts[3] || "")
  ) {
    await enqueue(res, state.id, "POST", `/api/devices/${parts[1]}/actions/${parts[3]}/picture`);
    return;
  }
  if (method === "PUT" && parts[0] === "devices" && parts.length === 2 && /^\d+$/.test(parts[1] || "")) {
    const payload = req.body || {};
    await enqueue(res, state.id, "PUT", `/api/devices/${parts[1]}`, {
      name: String(payload.name || "").slice(0, 80),
      room_id: payload.room_id || null,
    });
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "scenes") {
    send(res, 200, snap.scenes || []);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "schedules") {
    send(res, 200, snap.schedules || []);
    return;
  }
  if (method === "GET" && parts.length === 1 && parts[0] === "alerts") {
    send(res, 200, snap.alerts || []);
    return;
  }
  if (method !== "GET") {
    send(res, 400, { detail: "Cette modification se fait sur l'ordinateur de la maison." });
    return;
  }
  send(res, 404, { detail: "Introuvable" });
}
