import { cookieHeader, issue, sameSecret } from "../lib/session.js";

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { detail: "Méthode refusée" });
    return;
  }
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch (_err) {
      body = {};
    }
  }
  const expected = process.env.ACCESS_CODE || "";
  if (!sameSecret(body.password, expected)) {
    send(res, 401, { detail: "Mot de passe incorrect." });
    return;
  }
  res.setHeader("Set-Cookie", cookieHeader(issue()));
  send(res, 200, { ok: true });
}
