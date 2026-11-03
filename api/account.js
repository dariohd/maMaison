import { checkPassword, checkToken, hashPassword } from "../lib/secrets.js";
import { load, normalizeHouse, update } from "../lib/store.js";
import { matchTotp } from "../lib/totp.js";

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

function bearer(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function acceptable(password) {
  const value = String(password || "");
  if (value.length < 8) return "Le mot de passe doit contenir au moins 8 caractères.";
  if (value.length > 80) return "Le mot de passe est trop long.";
  return "";
}

async function allowed(req, body) {
  const house = normalizeHouse(req.headers["x-house"] || body.house);
  const state = house ? await load(house) : null;
  if (!state || !checkToken(bearer(req), state.agentTokenHash)) return "";
  return house;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { detail: "Méthode refusée" });
    return;
  }
  const body = readBody(req);
  const house = await allowed(req, body);
  if (!house) {
    send(res, 401, { detail: "Jeton refusé" });
    return;
  }
  if (body.disconnect === true) {
    const outcome = await update(house, (state) => {
      const epoch = (Number(state.sessionEpoch) || 0) + 1;
      state.sessionEpoch = epoch;
      return { expect: (fresh) => (Number(fresh.sessionEpoch) || 0) >= epoch };
    });
    if (!outcome.ok) {
      send(res, 503, { detail: "Réessaie." });
      return;
    }
    send(res, 200, { ok: true });
    return;
  }
  const next = String(body.next || "");
  const problem = acceptable(next);
  if (problem) {
    send(res, 400, { detail: problem });
    return;
  }
  const hash = hashPassword(next);
  const outcome = await update(house, (state) => {
    let step = state.lastTotpStep || 0;
    if (body.reset === true) {
      step = matchTotp(state.totpSecret, body.otp, Date.now(), state.lastTotpStep || 0);
      if (!step) return { abort: "otp" };
      state.lastTotpStep = step;
    } else if (!checkPassword(body.password, state.passwordHash)) {
      return { abort: "password" };
    }
    const epoch = (Number(state.sessionEpoch) || 0) + 1;
    state.passwordHash = hash;
    state.sessionEpoch = epoch;
    state.loginFailures = 0;
    state.loginFailureMarks = [];
    state.loginLockedUntil = 0;
    return {
      expect: (fresh) => fresh.passwordHash === hash
        && (Number(fresh.sessionEpoch) || 0) >= epoch
        && fresh.lastTotpStep === step,
    };
  });
  if (outcome.abort === "password") {
    send(res, 401, { detail: "Le mot de passe actuel est incorrect." });
    return;
  }
  if (outcome.abort === "otp") {
    send(res, 400, { detail: "Code incorrect. Regarde les 6 chiffres de l'application." });
    return;
  }
  if (!outcome.ok) {
    send(res, 503, { detail: "Réessaie." });
    return;
  }
  send(res, 200, { ok: true });
}
