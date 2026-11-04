import { hide, reveal } from "../lib/box.js";
import { backupCodes, checkPassword, checkToken, hashPassword } from "../lib/secrets.js";
import { load, normalizeHouse, update } from "../lib/store.js";
import { generateSecret, matchTotp, otpauth } from "../lib/totp.js";
import QRCode from "qrcode";

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
  if (body.codes === true) {
    const fresh = backupCodes();
    const outcome = await update(house, (state) => {
      state.backupCodes = fresh.hashes;
      return { expect: (item) => Array.isArray(item.backupCodes) && item.backupCodes.length === 8 };
    });
    if (!outcome.ok) {
      send(res, 503, { detail: "Réessaie." });
      return;
    }
    send(res, 200, { codes: fresh.raw });
    return;
  }
  if (body.codesLeft === true) {
    const state = await load(house);
    send(res, 200, { left: (state.backupCodes || []).length });
    return;
  }
  if (body.people === true) {
    const state = await load(house);
    send(res, 200, {
      people: (state.people || []).map((item) => ({ id: item.id, name: item.name, role: item.role })),
      codesLeft: (state.backupCodes || []).length,
    });
    return;
  }
  if (body.addPerson === true) {
    if (!process.env.SESSION_SECRET) {
      send(res, 503, { detail: "La page publique n'est pas prête." });
      return;
    }
    const problem = acceptable(body.password);
    if (problem) {
      send(res, 400, { detail: problem });
      return;
    }
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) {
      send(res, 400, { detail: "Indique un prénom." });
      return;
    }
    const id = `p${Date.now().toString(36)}`;
    const secret = generateSecret();
    const outcome = await update(house, (state) => {
      state.people = [...(state.people || []), {
        id,
        name,
        role: body.role === "setup" ? "setup" : "use",
        passwordHash: hashPassword(body.password),
        totpSecret: hide(secret),
        lastTotpStep: 0,
      }].slice(0, 8);
      return { expect: (item) => (item.people || []).some((person) => person.id === id) };
    });
    if (!outcome.ok) {
      send(res, 503, { detail: "Réessaie." });
      return;
    }
    const { formatHouse } = await import("../lib/store.js");
    const qr = await QRCode.toString(otpauth(secret, `${formatHouse(house)} ${name}`), { type: "svg", margin: 1, width: 220 });
    send(res, 200, { id, name, secret, qr });
    return;
  }
  if (body.sessions === true) {
    const state = await load(house);
    send(res, 200, { sessions: state.sessions || [] });
    return;
  }
  if (body.dropSession) {
    const sid = String(body.dropSession);
    const outcome = await update(house, (state) => {
      state.sessions = (state.sessions || []).filter((item) => item.id !== sid);
      return { expect: (item) => !(item.sessions || []).some((row) => row.id === sid) };
    });
    if (!outcome.ok) {
      send(res, 503, { detail: "Réessaie." });
      return;
    }
    send(res, 200, { ok: true });
    return;
  }
  if (body.disconnect === true) {
    const outcome = await update(house, (state) => {
      const epoch = (Number(state.sessionEpoch) || 0) + 1;
      state.sessionEpoch = epoch;
      state.sessions = [];
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
      step = matchTotp(reveal(state.totpSecret), body.otp, Date.now(), state.lastTotpStep || 0);
      if (!step) return { abort: "otp" };
      state.lastTotpStep = step;
    } else if (!checkPassword(body.password, state.passwordHash)) {
      return { abort: "password" };
    }
    const epoch = (Number(state.sessionEpoch) || 0) + 1;
    state.passwordHash = hash;
    state.sessionEpoch = epoch;
    state.sessions = [];
    state.loginFailures = 0;
    state.loginFailureMarks = [];
    state.loginLockedUntil = 0;
    return {
      expect: (fresh) => fresh.passwordHash === hash && (Number(fresh.sessionEpoch) || 0) >= epoch,
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
