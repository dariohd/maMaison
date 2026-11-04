import QRCode from "qrcode";
import { hide, reveal } from "../lib/box.js";
import { checkToken } from "../lib/secrets.js";
import { formatHouse, load, normalizeHouse, update } from "../lib/store.js";
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
  if (body.sync === true) {
    send(res, 200, { secret: reveal(state.totpSecret) });
    return;
  }
  if (body.rotate === true) {
    if (!process.env.SESSION_SECRET) {
      send(res, 503, { detail: "La page publique n'est pas prête." });
      return;
    }
    const secret = generateSecret();
    const outcome = await update(house, (current) => {
      const epoch = (Number(current.sessionEpoch) || 0) + 1;
      current.totpSecret = hide(secret);
      current.lastTotpStep = 0;
      current.totpReady = false;
      current.sessionEpoch = epoch;
      return {
        expect: (fresh) => reveal(fresh.totpSecret) === secret && (Number(fresh.sessionEpoch) || 0) >= epoch,
      };
    });
    if (!outcome.ok) {
      send(res, 503, { detail: "Réessaie." });
      return;
    }
    const code = formatHouse(house);
    send(res, 200, { secret, qr: await qrFor(secret, code), house: code });
    return;
  }
  const outcome = await update(house, (current) => {
    const step = matchTotp(reveal(current.totpSecret), body.code, Date.now(), current.lastTotpStep || 0);
    if (!step) return { abort: "otp" };
    current.lastTotpStep = step;
    current.totpReady = true;
    const secret = current.totpSecret;
    return { expect: (fresh) => fresh.lastTotpStep === step && fresh.totpSecret === secret };
  });
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
