import { checkToken } from "../lib/secrets.js";
import { load, normalizeHouse, saveLive, updateQueue } from "../lib/store.js";

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch (_err) {
      body = {};
    }
  }
  return body;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { detail: "Méthode refusée" });
    return;
  }
  const body = readBody(req);
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const house = normalizeHouse(req.headers["x-house"] || body.house);
  const state = house ? await load(house) : null;
  if (!state || !checkToken(token, state.agentTokenHash)) {
    send(res, 401, { detail: "Jeton refusé" });
    return;
  }
  if (body.snapshot) await saveLive(house, body.snapshot);
  const results = new Map((body.results || []).map((item) => [item.id, item.result]));
  const taken = [];
  const written = await updateQueue(house, (queue) => {
    taken.length = 0;
    const now = Date.now();
    let changed = false;
    for (const job of queue) {
      if (results.has(job.id)) {
        job.status = "done";
        job.result = results.get(job.id);
        job.doneAt = now;
        changed = true;
      } else if (job.status === "sent" && now - (job.sentAt || 0) > 30000) {
        job.status = "pending";
        changed = true;
      }
    }
    const kept = queue.filter((job) => job.status !== "done" || now - (job.doneAt || 0) < 120000);
    if (kept.length !== queue.length) changed = true;
    queue.splice(0, queue.length, ...kept);
    const commands = queue.filter((job) => job.status === "pending").slice(0, 4);
    for (const job of commands) {
      job.status = "sent";
      job.sentAt = now;
      taken.push({ id: job.id, method: job.method, path: job.path });
      changed = true;
    }
    if (!changed) return { skip: true };
    const ids = taken.map((item) => item.id);
    return {
      expect: (fresh) => ids.every((id) => fresh.some((job) => job.id === id && job.status === "sent")),
    };
  });
  if (!written.ok) {
    send(res, 503, { detail: "Réessaie." });
    return;
  }
  send(res, 200, { commands: taken });
}
