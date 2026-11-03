import { checkPassword, checkToken, hashPassword } from "../lib/secrets.js";
import { load, normalizeHouse, save } from "../lib/store.js";
import { matchTotp } from "../lib/totp.js";

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { detail: "Méthode refusée" });
    return;
  }
  const body = readBody(req);
  const house = normalizeHouse(req.headers["x-house"] || body.house);
  const state = house ? await load(house) : null;
  if (!state || !checkToken(bearer(req), state.agentTokenHash)) {
    send(res, 401, { detail: "Jeton refusé" });
    return;
  }
  if (body.disconnect) {
    state.sessionEpoch = (Number(state.sessionEpoch) || 0) + 1;
    await save(state);
    send(res, 200, { ok: true });
    return;
  }
  const next = String(body.next || "");
  const problem = acceptable(next);
  if (problem) {
    send(res, 400, { detail: problem });
    return;
  }
  if (body.reset) {
    const step = matchTotp(state.totpSecret, body.otp, Date.now(), state.lastTotpStep || 0);
    if (!step) {
      send(res, 400, { detail: "Code incorrect. Regarde les 6 chiffres de l'application." });
      return;
    }
    state.lastTotpStep = step;
  } else if (!checkPassword(body.password, state.passwordHash)) {
    send(res, 401, { detail: "Le mot de passe actuel est incorrect." });
    return;
  }
  state.passwordHash = hashPassword(next);
  state.sessionEpoch = (Number(state.sessionEpoch) || 0) + 1;
  state.loginFailures = 0;
  state.loginLockedUntil = 0;
  await save(state);
  send(res, 200, { ok: true });
}
