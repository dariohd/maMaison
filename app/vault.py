import base64
import os
import secrets
import sys


def _key_path():
    from app.paths import home_root

    return home_root() / "data" / "coffre.key"


def _xor_key() -> bytes:
    path = _key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(secrets.token_bytes(32))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return path.read_bytes()


def _dpapi_protect(data: bytes) -> str:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    buffer = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptProtectData")
    try:
        out = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return base64.urlsafe_b64encode(out).decode("ascii")


def _dpapi_unprotect(token: str) -> bytes:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    raw = base64.urlsafe_b64decode(token.encode("ascii"))
    buffer = ctypes.create_string_buffer(raw, len(raw))
    blob_in = DATA_BLOB(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptUnprotectData")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def lock(text: str) -> str:
    raw = (text or "").encode("utf-8")
    if not raw:
        return ""
    if sys.platform == "win32":
        try:
            return "dpapi:" + _dpapi_protect(raw)
        except Exception:
            pass
    key = _xor_key()
    out = bytes(byte ^ key[index % len(key)] for index, byte in enumerate(raw))
    return "xor:" + base64.urlsafe_b64encode(out).decode("ascii")


def open_field(text: str) -> str:
    raw = text or ""
    if raw.startswith("dpapi:") or raw.startswith("xor:"):
        return unlock(raw)
    return raw


def unlock(text: str) -> str:
    value = text or ""
    try:
        if value.startswith("dpapi:"):
            return _dpapi_unprotect(value[6:]).decode("utf-8")
        if value.startswith("xor:"):
            key = _xor_key()
            raw = base64.urlsafe_b64decode(value[4:].encode("ascii"))
            return bytes(byte ^ key[index % len(key)] for index, byte in enumerate(raw)).decode("utf-8")
    except Exception:
        return ""
    return value
