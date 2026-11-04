import crypto from "node:crypto";

function key() {
  const secret = process.env.SESSION_SECRET || "";
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret).digest();
}

export function hide(plain) {
  const text = String(plain || "");
  if (!text) return "";
  const material = key();
  if (!material) throw new Error("SESSION_SECRET");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `box:${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function reveal(stored) {
  const value = String(stored || "");
  if (!value) return "";
  if (!value.startsWith("box:")) return value;
  const material = key();
  if (!material) return "";
  const parts = value.slice(4).split(".");
  if (parts.length !== 3) return "";
  try {
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const enc = Buffer.from(parts[2], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", material, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (_err) {
    return "";
  }
}

export function sealState(state) {
  if (!state || typeof state !== "object") return state;
  if (state.totpSecret && !String(state.totpSecret).startsWith("box:")) {
    state.totpSecret = hide(state.totpSecret);
  }
  for (const person of state.people || []) {
    if (person.totpSecret && !String(person.totpSecret).startsWith("box:")) {
      person.totpSecret = hide(person.totpSecret);
    }
  }
  return state;
}
