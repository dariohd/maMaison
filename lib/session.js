import crypto from "node:crypto";

const WEEK = 30 * 24 * 60 * 60;

function mac(body) {
  const secret = process.env.SESSION_SECRET || "";
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

export function issue(houseId, epoch = 0) {
  const exp = Date.now() + WEEK * 1000;
  const step = Number(epoch) || 0;
  const body = `${houseId}.${exp}.${step}`;
  return `${body}.${mac(body)}`;
}

export function valid(token) {
  const secret = process.env.SESSION_SECRET || "";
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 4) return null;
  const [house, exp, epoch, signature] = parts;
  if (!/^[A-Z0-9]{8}$/.test(house) || !/^\d+$/.test(epoch)) return null;
  const body = `${house}.${exp}.${epoch}`;
  const expected = mac(body);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return null;
  if (!crypto.timingSafeEqual(left, right)) return null;
  if (Number(exp) <= Date.now()) return null;
  return { house, epoch: Number(epoch) };
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
