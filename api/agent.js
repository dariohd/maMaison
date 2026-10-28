import crypto from "node:crypto";
import { load, save } from "../lib/store.js";

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const token = process.env.AGENT_TOKEN || "";
  if (!token) return false;
  const header = String(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { detail: "Méthode refusée" });
    return;
  }
  if (!authorized(req)) {
    send(res, 401, { detail: "Jeton refusé" });
    return;
  }
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch (_err) {
      body = {};
    }
  }
  const state = await load();
  const now = Date.now();
  const results = new Map((body.results || []).map((item) => [item.id, item.result]));
  for (const job of state.queue) {
    if (results.has(job.id)) {
      job.status = "done";
      job.result = results.get(job.id);
      job.doneAt = now;
    } else if (job.status === "sent" && now - (job.sentAt || 0) > 30000) {
      job.status = "pending";
    }
  }
  state.queue = state.queue.filter((job) => job.status !== "done" || now - (job.doneAt || 0) < 120000);
  if (body.snapshot) {
    state.snapshot = body.snapshot;
    state.seenAt = now;
  }
  const commands = state.queue.filter((job) => job.status === "pending").slice(0, 4);
  for (const job of commands) {
    job.status = "sent";
    job.sentAt = now;
  }
  await save(state);
  send(res, 200, {
    commands: commands.map((job) => ({ id: job.id, method: job.method, path: job.path })),
  });
}
