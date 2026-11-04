import json
import re

from app import commands, db


def parse_reading(kind: str, text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""
    data = None
    if raw.startswith("{") or raw.startswith("["):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = None
    if kind == "temperature":
        if isinstance(data, dict):
            for key in ("temperature", "temp", "t", "value"):
                if key in data:
                    return f"{data[key]} °C"
        match = re.search(r"(-?\d+(?:[.,]\d+)?)\s*°?C?", raw)
        return f"{match.group(1).replace(',', '.')} °C" if match else raw[:40]
    if kind == "position":
        if isinstance(data, dict):
            for key in ("position", "current", "pct", "value"):
                if key in data:
                    return f"{data[key]} %"
        match = re.search(r"(\d{1,3})\s*%", raw)
        return f"{match.group(1)} %" if match else raw[:40]
    if kind == "on":
        blob = json.dumps(data, separators=(",", ":")).lower() if data is not None else raw.lower()
        if any(word in blob for word in ("\"ison\":true", "\"on\":true", "\"power\":\"on\"", " on")):
            return "Marche"
        if any(word in blob for word in ("\"ison\":false", "\"on\":false", "\"power\":\"off\"", " off")):
            return "Arrêt"
        return raw[:40]
    return raw[:40]


def refresh_device(device: dict) -> str:
    path = device.get("reading_path") or ""
    kind = device.get("reading_kind") or ""
    if not path or not kind:
        return device.get("reading") or ""
    result = commands.run_http(
        device,
        {"kind": "http", "method": "GET", "path": path, "body": "", "auth_user": "", "auth_pass": ""},
    )
    text = str(result.get("detail") or "")
    if "." in text:
        text = text.split(".", 1)[1].strip()
    value = parse_reading(kind, text)
    if value:
        db.save_reading(device["id"], value)
    return value
