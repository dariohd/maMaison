import hashlib
import hmac
import struct
import time

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def _b32decode(text: str) -> bytes:
    clean = "".join(char for char in str(text or "").upper() if char in ALPHABET)
    bits = 0
    value = 0
    out = bytearray()
    for char in clean:
        value = (value << 5) | ALPHABET.index(char)
        bits += 5
        if bits >= 8:
            out.append((value >> (bits - 8)) & 255)
            bits -= 8
    return bytes(out)


def _hotp(key: bytes, counter: int) -> str:
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0xF
    number = ((digest[offset] & 0x7F) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]
    return str(number % 1_000_000).zfill(6)


def sane_last_step(value: int | float | None) -> int:
    try:
        step = int(value or 0)
    except (TypeError, ValueError):
        return 0
    if step < 0 or step > 10_000_000_000:
        return 0
    return step


def match_totp(secret: str, code: str, now: float | None = None, last_step: int = 0) -> int:
    cleaned = "".join(str(code or "").split())
    if len(cleaned) != 6 or not cleaned.isdigit():
        return 0
    key = _b32decode(secret)
    if len(key) < 10:
        return 0
    floor = sane_last_step(last_step)
    step = int((now if now is not None else time.time()) // 30)
    for skew in (-1, 0, 1):
        candidate = step + skew
        if candidate <= floor:
            continue
        if hmac.compare_digest(_hotp(key, candidate), cleaned):
            return candidate
    return 0
