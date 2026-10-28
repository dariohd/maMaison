import crypto from "node:crypto";

const WEEK = 30 * 24 * 60 * 60;

export function issue() {
  const secret = process.env.SESSION_SECRET || "";
  const exp = Date.now() + WEEK * 1000;
  const body = `ok.${exp}`;
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function valid(token) {
  const secret = process.env.SESSION_SECRET || "";
  if (!token || !secret) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [mark, exp, mac] = parts;
  if (mark !== "ok") return false;
  const body = `${mark}.${exp}`;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  if (!crypto.timingSafeEqual(left, right)) return false;
  return Number(exp) > Date.now();
}

export function readCookie(req) {
  const raw = req.headers.cookie || "";
  const part = raw.split(";").map((item) => item.trim()).find((item) => item.startsWith("maison="));
  if (!part) return "";
  try {
    return decodeURIComponent(part.slice("maison=".length));
  } catch (_err) {
    return "";
  }
}

export function cookieHeader(token) {
  return `maison=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${WEEK}`;
}

export function sameSecret(given, expected) {
  const left = Buffer.from(String(given || ""));
  const right = Buffer.from(String(expected || ""));
  if (!right.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
