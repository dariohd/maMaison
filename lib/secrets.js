import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function checkPassword(password, stored) {
  const value = String(password ?? "");
  if (value.length < 1 || value.length > 80) return false;
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  if (parts[1].length < 8 || parts[1].length > 64 || parts[2].length < 16 || parts[2].length > 128) return false;
  let got;
  try {
    got = crypto.scryptSync(value, parts[1], 32, SCRYPT);
  } catch (_err) {
    return false;
  }
  const expected = Buffer.from(parts[2], "base64url");
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

export function hashBackup(code) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.createHmac("sha256", salt).update(String(code)).digest("base64url");
  return `b256$${salt}$${hash}`;
}

export function checkBackup(code, stored) {
  const value = String(code || "");
  if (value.length < 8 || value.length > 40) return false;
  const parts = String(stored || "").split("$");
  if (parts[0] === "scrypt") return checkPassword(value, stored);
  if (parts[0] !== "b256" || parts.length !== 3) return false;
  if (parts[1].length < 8 || parts[1].length > 64 || parts[2].length < 16 || parts[2].length > 128) return false;
  const got = crypto.createHmac("sha256", parts[1]).update(value).digest();
  let expected;
  try {
    expected = Buffer.from(parts[2], "base64url");
  } catch (_err) {
    return false;
  }
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

export function backupCodes() {
  const raw = Array.from({ length: 8 }, () => crypto.randomBytes(8).toString("hex"));
  return { raw, hashes: raw.map((item) => hashBackup(item)) };
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
