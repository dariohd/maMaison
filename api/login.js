import crypto from "node:crypto";
import { locked, noteFailure } from "../lib/guard.js";
import { reveal, sealState } from "../lib/box.js";
import { checkBackup, checkPassword, hashPassword } from "../lib/secrets.js";
import { cookieHeader, issue, newSessionId } from "../lib/session.js";
import { formatHouse, load, normalizeHouse, update } from "../lib/store.js";
import { matchTotp, saneLastTotpStep } from "../lib/totp.js";

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
    checkPassword(password, DUMMY);
    refuse(res);
    return;
  }
  const outcome = await update(house, (state) => {
    if (locked(state)) return { abort: "locked" };
    const otp = String(body.otp || "").replace(/\s/g, "");
    let person = "owner";
    let step = 0;
    let usedBackup = false;
    const ownerOk = checkPassword(password, state.passwordHash);
    const ownerLast = saneLastTotpStep(state.lastTotpStep);
    if (ownerOk) step = matchTotp(reveal(state.totpSecret), otp, Date.now(), ownerLast);
    if (!step && ownerOk && Array.isArray(state.backupCodes)) {
      const index = state.backupCodes.findIndex((stored) => checkBackup(otp, stored));
      if (index >= 0) {
        usedBackup = true;
        step = 1;
        state.backupCodes = state.backupCodes.filter((_, current) => current !== index);
      }
    }
    if (!step) {
      for (const item of state.people || []) {
        if (!checkPassword(password, item.passwordHash)) continue;
        const personStep = matchTotp(reveal(item.totpSecret), otp, Date.now(), saneLastTotpStep(item.lastTotpStep));
        if (!personStep) continue;
        item.lastTotpStep = personStep;
        person = item.id;
        step = personStep;
        break;
      }
    }
    if (!ownerOk && person === "owner" && !step) return { abort: "bad" };
    if (!step) return { abort: "bad" };
    if (person === "owner") state.lastTotpStep = usedBackup ? ownerLast : step;
    state.loginFailures = 0;
    state.loginFailureMarks = [];
    state.loginLockedUntil = 0;
    state.totpReady = true;
    sealState(state);
    const sid = newSessionId();
    state.sessions = [...(state.sessions || []), { id: sid, person, at: Date.now() }].slice(-20);
    state.lastLoginSid = sid;
    const epoch = Number(state.sessionEpoch) || 0;
    const hash = state.passwordHash;
    return {
      expect: (fresh) => (fresh.sessions || []).some((item) => item.id === sid)
        && fresh.passwordHash === hash
        && (Number(fresh.sessionEpoch) || 0) === epoch
        && fresh.lastLoginSid === sid,
    };
  });
  if (outcome.missing) {
    checkPassword(password, DUMMY);
    refuse(res);
    return;
  }
  if (outcome.abort === "locked" || (outcome.state && locked(outcome.state))) {
    checkPassword(password, DUMMY);
    refuse(res);
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
  const sid = saved.lastLoginSid || "";
  const opened = (saved.sessions || []).find((item) => item.id === sid) || {};
  res.setHeader("Set-Cookie", cookieHeader(issue(saved.id, Number(saved.sessionEpoch) || 0, sid || newSessionId(), opened.person || "owner")));
  send(res, 200, { ok: true, house: formatHouse(saved.id) });
}
