import { cookieHeader, issue } from "../lib/session.js";
import { checkPassword } from "../lib/secrets.js";
import { formatHouse, load, normalizeHouse, save } from "../lib/store.js";
import { matchTotp } from "../lib/totp.js";

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

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

function locked(state) {
  return Boolean(state.loginLockedUntil && Date.now() < state.loginLockedUntil);
}

async function fail(state) {
  const failures = (state.loginFailures || 0) + 1;
  state.loginFailures = failures;
  if (failures >= LOCK_AFTER) {
    state.loginLockedUntil = Date.now() + LOCK_MS;
    state.loginFailures = 0;
  }
  await save(state);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { detail: "Méthode refusée" });
    return;
  }
  const body = readBody(req);
  const house = normalizeHouse(body.house);
  const state = house ? await load(house) : null;
  if (state && locked(state)) {
    send(res, 429, { detail: "Trop d'essais. Réessaie dans 15 minutes." });
    return;
  }
  const passwordOk = Boolean(state && checkPassword(body.password, state.passwordHash));
  const step = passwordOk ? matchTotp(state.totpSecret, body.otp, Date.now(), state.lastTotpStep || 0) : 0;
  const fresh = state ? await load(house) : null;
  if (fresh && locked(fresh)) {
    send(res, 429, { detail: "Trop d'essais. Réessaie dans 15 minutes." });
    return;
  }
  const accepted = Boolean(fresh && passwordOk && step && step > (fresh.lastTotpStep || 0));
  if (!accepted) {
    if (fresh) await fail(fresh);
    send(res, 401, { detail: "Code, mot de passe ou code de l'application incorrect." });
    return;
  }
  fresh.loginFailures = 0;
  fresh.loginLockedUntil = 0;
  fresh.lastTotpStep = step;
  fresh.totpReady = true;
  await save(fresh);
  res.setHeader("Set-Cookie", cookieHeader(issue(state.id)));
  send(res, 200, { ok: true, house: formatHouse(state.id) });
}
