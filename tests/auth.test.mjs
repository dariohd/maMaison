import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { noteFailure, locked } from "../lib/guard.js";
import { hide, reveal } from "../lib/box.js";
import { backupCodes, checkBackup, checkPassword, hashPassword } from "../lib/secrets.js";
import { issue, valid } from "../lib/session.js";
import { matchTotp, saneLastTotpStep } from "../lib/totp.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32encode(raw) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  return String(bin % 1000000).padStart(6, "0");
}

test("le mot de passe se vérifie et un mot trop long est refusé", () => {
  const stored = hashPassword("maison-bleue");
  assert.equal(checkPassword("maison-bleue", stored), true);
  assert.equal(checkPassword("maison-verte", stored), false);
  assert.equal(checkPassword("", stored), false);
  assert.equal(checkPassword("x".repeat(81), stored), false);
  assert.equal(checkPassword("maison-bleue", "scrypt$court$hash"), false);
});

test("le code a 6 chiffres suit le standard et ne se rejoue pas", () => {
  const key = Buffer.from("12345678901234567890");
  const secret = base32encode(key);
  assert.equal(hotp(key, 0), "755224");
  assert.equal(matchTotp(secret, "755224", 15000, -1), 0);
  assert.equal(matchTotp(secret, "755224", 15000, 0), 0);
  assert.equal(matchTotp(secret, "000000", 15000, -1), 0);
  assert.equal(matchTotp(secret, "75522", 15000, -1), 0);
  assert.equal(matchTotp("", "755224", 15000, -1), 0);
  const later = hotp(key, 2);
  assert.equal(matchTotp(secret, later, 75000, 0), 2);
  assert.equal(saneLastTotpStep(Date.now()), 0);
  assert.equal(saneLastTotpStep(2), 2);
  assert.equal(matchTotp(secret, later, 75000, Date.now()), 2);
});

test("une session périmée ou modifiée est refusée", () => {
  process.env.SESSION_SECRET = "test-secret";
  const token = issue("AB12CD34", 0);
  assert.equal(valid(token).epoch, 0);
  assert.equal(Boolean(valid(token).sessionId), true);
  const parts = token.split(".");
  parts[0] = "ZZZZZZZZ";
  assert.equal(valid(parts.join(".")), null);
  const exp = Date.now() - 1000;
  const body = `AB12CD34.${exp}.1`;
  const signature = crypto.createHmac("sha256", "test-secret").update(body).digest("base64url");
  assert.equal(valid(`${body}.${signature}`), null);
});

test("les codes de secours sont hachés et distincts", () => {
  const codes = backupCodes();
  assert.equal(codes.raw.length, 8);
  assert.equal(codes.hashes.length, 8);
  assert.equal(codes.raw[0].length, 16);
  assert.equal(checkBackup(codes.raw[0], codes.hashes[0]), true);
  assert.equal(checkBackup(codes.raw[0], codes.hashes[1]), false);
  const old = hashPassword("abcd1234");
  assert.equal(checkBackup("abcd1234", old), true);
});

test("le secret TOTP se range et se relit", () => {
  process.env.SESSION_SECRET = "test-secret";
  const stored = hide("JBSWY3DPEHPK3PXP");
  assert.equal(stored.startsWith("box:"), true);
  assert.equal(reveal(stored), "JBSWY3DPEHPK3PXP");
  assert.equal(reveal("JBSWY3DPEHPK3PXP"), "JBSWY3DPEHPK3PXP");
});

test("cinq erreurs ferment l'entrée sans perdre les essais parallèles", () => {
  const state = { loginFailures: 0, loginFailureMarks: [], loginLockedUntil: 0 };
  const now = 1_700_000_000_000;
  for (let index = 0; index < 4; index += 1) {
    const noted = noteFailure(state, now + index, `${now + index}-a`);
    assert.equal(noted.changed, true);
    assert.equal(noted.until, 0);
  }
  const closing = noteFailure(state, now + 4, `${now + 4}-b`);
  assert.equal(closing.until > now, true);
  assert.equal(locked(state, now + 4), true);
  assert.deepEqual(state.loginFailureMarks, []);
  const during = noteFailure(state, now + 5, `${now + 5}-c`);
  assert.equal(during.changed, false);
});
