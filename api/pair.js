import { sameSecret } from "../lib/session.js";

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
  const body = readBody(req);
  const expected = process.env.ACCESS_CODE || "";
  if (!sameSecret(body.password, expected)) {
    send(res, 401, { detail: "Mot de passe incorrect." });
    return;
  }
  const token = process.env.AGENT_TOKEN || "";
  if (!token) {
    send(res, 500, { detail: "Le lien de la maison n'est pas prêt." });
    return;
  }
  send(res, 200, { token, url: PUBLIC_URL });
}
