import crypto from "node:crypto";
import { locked, noteFailure } from "../lib/guard.js";
import { checkPassword, hashPassword } from "../lib/secrets.js";
import { cookieHeader, issue } from "../lib/session.js";
import { formatHouse, load, normalizeHouse, update } from "../lib/store.js";
import { matchTotp } from "../lib/totp.js";

const DUMMY = hashPassword("maison-absente-00");

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

function refuse(res) {
  send(res, 401, { detail: "Code, mot de passe ou code de l'application incorrect." });
}

async function recordFailure(house) {
  const mark = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  await update(house, (state) => {
    const noted = noteFailure(state, Date.now(), mark);
    if (!noted.changed) return { abort: "locked" };
    return {
      expect: (fresh) => (noted.until
        ? (fresh.loginLockedUntil || 0) >= noted.until
        : (fresh.loginFailureMarks || []).includes(mark)),
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { detail: "Méthode refusée" });
    return;
  }
  const body = readBody(req);
  const house = normalizeHouse(body.house);
  const password = String(body.password ?? "");
  if (house.length !== 8) {
    checkPassword(password, DUMMY);
    refuse(res);
    return;
  }
  const present = await load(house);
  if (!present) {
    checkPassword(password, DUMMY);
    refuse(res);
    return;
  }
  if (locked(present)) {
    send(res, 429, { detail: "Trop d'essais. Réessaie dans 15 minutes." });
    return;
  }
  const outcome = await update(house, (state) => {
    if (locked(state)) return { abort: "locked" };
    const ok = checkPassword(password, state.passwordHash);
    const step = ok ? matchTotp(state.totpSecret, body.otp, Date.now(), state.lastTotpStep || 0) : 0;
    if (!ok || !step) return { abort: "bad" };
    state.lastTotpStep = step;
    state.loginFailures = 0;
    state.loginFailureMarks = [];
    state.loginLockedUntil = 0;
    state.totpReady = true;
    const epoch = Number(state.sessionEpoch) || 0;
    const hash = state.passwordHash;
    return {
      expect: (fresh) => fresh.lastTotpStep === step
        && fresh.passwordHash === hash
        && (Number(fresh.sessionEpoch) || 0) === epoch
        && fresh.totpSecret === state.totpSecret,
    };
  });
  if (outcome.missing) {
    checkPassword(password, DUMMY);
    refuse(res);
    return;
  }
  if (outcome.abort === "locked" || (outcome.state && locked(outcome.state))) {
    send(res, 429, { detail: "Trop d'essais. Réessaie dans 15 minutes." });
    return;
  }
  if (!outcome.ok) {
    if (outcome.abort === "bad") await recordFailure(house);
    if (outcome.abort === "retry") {
      send(res, 503, { detail: "Réessaie." });
      return;
    }
    refuse(res);
    return;
  }
  const saved = outcome.state;
  res.setHeader("Set-Cookie", cookieHeader(issue(saved.id, Number(saved.sessionEpoch) || 0)));
  send(res, 200, { ok: true, house: formatHouse(saved.id) });
}
