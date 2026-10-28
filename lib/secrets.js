import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function checkPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let got;
  try {
    got = crypto.scryptSync(String(password), parts[1], 32, SCRYPT);
  } catch (_err) {
    return false;
  }
  const expected = Buffer.from(parts[2], "base64url");
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
}

export function checkToken(token, stored) {
  const expected = Buffer.from(String(stored || ""));
  const got = Buffer.from(hashToken(token));
  if (!stored || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}
