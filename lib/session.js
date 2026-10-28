import crypto from "node:crypto";

const WEEK = 30 * 24 * 60 * 60;

function mac(body) {
  const secret = process.env.SESSION_SECRET || "";
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

export function issue(houseId) {
  const exp = Date.now() + WEEK * 1000;
  const body = `${houseId}.${exp}`;
  return `${body}.${mac(body)}`;
}

export function valid(token) {
  const secret = process.env.SESSION_SECRET || "";
  if (!token || !secret) return "";
  const parts = String(token).split(".");
  if (parts.length !== 3) return "";
  const [house, exp, signature] = parts;
  if (!/^[A-Z0-9]{8}$/.test(house)) return "";
  const body = `${house}.${exp}`;
  const expected = mac(body);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return "";
  if (!crypto.timingSafeEqual(left, right)) return "";
  return Number(exp) > Date.now() ? house : "";
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
