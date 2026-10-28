import { hashPassword, hashToken, newToken } from "../lib/secrets.js";
import { formatHouse, load, newHouseId, save } from "../lib/store.js";

const PUBLIC_URL = "https://mamaison-dariohprojects.vercel.app";

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
  const password = String(readBody(req).password || "");
  if (password.length < 6) {
    send(res, 400, { detail: "Le mot de passe doit contenir au moins 6 caractères." });
    return;
  }
  let id = newHouseId();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await load(id))) break;
    id = newHouseId();
  }
  const token = newToken();
  await save({
    id,
    passwordHash: hashPassword(password),
    agentTokenHash: hashToken(token),
    snapshot: null,
    seenAt: 0,
    queue: [],
  });
  send(res, 200, { id, code: formatHouse(id), token, url: PUBLIC_URL });
}
