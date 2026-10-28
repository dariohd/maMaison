import { cookieHeader, issue } from "../lib/session.js";
import { checkPassword } from "../lib/secrets.js";
import { formatHouse, load, normalizeHouse } from "../lib/store.js";

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
  const house = normalizeHouse(body.house);
  const state = house ? await load(house) : null;
  if (!state || !checkPassword(body.password, state.passwordHash)) {
    send(res, 401, { detail: "Code ou mot de passe incorrect." });
    return;
  }
  res.setHeader("Set-Cookie", cookieHeader(issue(state.id)));
  send(res, 200, { ok: true, house: formatHouse(state.id) });
}
