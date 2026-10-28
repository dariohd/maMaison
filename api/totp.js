import QRCode from "qrcode";
import { checkToken } from "../lib/secrets.js";
import { formatHouse, load, normalizeHouse, save } from "../lib/store.js";
import { generateSecret, matchTotp, otpauth } from "../lib/totp.js";

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

async function qrFor(secret, code) {
  return QRCode.toString(otpauth(secret, code), { type: "svg", margin: 1, width: 220 });
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
  if (body.rotate) {
    const secret = generateSecret();
    state.totpSecret = secret;
    state.lastTotpStep = 0;
    await save(state);
    const code = formatHouse(state.id);
    send(res, 200, { secret, qr: await qrFor(secret, code), house: code });
    return;
  }
  const step = matchTotp(state.totpSecret, body.code, Date.now(), state.lastTotpStep || 0);
  if (!step) {
    send(res, 400, { detail: "Code incorrect. Regarde les 6 chiffres de l'application." });
    return;
  }
  state.lastTotpStep = step;
  state.totpReady = true;
  await save(state);
  send(res, 200, { ok: true });
}
