import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from app import commands, db, scanner
from app.vault import lock, open_field

log = logging.getLogger("maison.distant")
PUBLIC_URL = "https://mamaisonconnectee.vercel.app"
_stop = threading.Event()
_wake = threading.Event()
_thread: threading.Thread | None = None
_network = {"at": 0.0, "value": None}
_RUN = re.compile(r"^/api/devices/(\d+)/actions/(\d+)/run$")
_PICTURE = re.compile(r"^/api/devices/(\d+)/actions/(\d+)/picture$")
_RENAME = re.compile(r"^/api/devices/(\d+)$")
_SCENE = re.compile(r"^/api/scenes/(\d+)/run$")


def config_path():
    from app.paths import home_root

    return home_root() / "data" / "distant.json"


def load_config() -> dict | None:
    path = config_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.exception("lecture du lien distant")
        return None
    return parse_config(data)


def parse_config(data: dict) -> dict | None:
    url = str(data.get("url") or "").rstrip("/")
    token = str(data.get("token") or "")
    house = re.sub(r"[^A-Za-z0-9]", "", str(data.get("house") or "")).upper()
    token = open_field(token)
    secret = open_field(str(data.get("secret") or ""))
    if not url.startswith("https://") or not token or len(house) != 8:
        return None
    try:
        step = int(data.get("totp_step") or 0)
    except (TypeError, ValueError):
        step = 0
    return {
        "url": url,
        "token": token,
        "house": house,
        "secret": secret,
        "totp_step": step,
    }


def format_house(house: str) -> str:
    if len(house) == 8:
        return f"{house[:4]}-{house[4:]}"
    return house


def _house_id(house: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9]", "", house).upper()
    if len(clean) != 8:
        raise ValueError("Code de maison invalide.")
    return clean


def entry_url(house: str) -> str:
    return f"{PUBLIC_URL}/?maison={format_house(_house_id(house))}"


def entry_svg(house: str) -> str:
    import io

    import segno

    buffer = io.BytesIO()
    segno.make(entry_url(house), error="m").save(buffer, kind="svg", scale=4, xmldecl=False)
    return buffer.getvalue().decode("utf-8")


def public_url(url: str | None = None) -> str:
    target = (url or PUBLIC_URL).strip()
    parsed = urllib.parse.urlparse(target)
    if parsed.scheme != "https" or parsed.hostname != "mamaisonconnectee.vercel.app":
        raise ValueError("Adresse refusée")
    if parsed.path not in ("", "/"):
        raise ValueError("Adresse refusée")
    return f"https://{parsed.hostname}"


def _write_config(data: dict) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "url": data.get("url") or "",
        "house": data.get("house") or "",
        "token": lock(open_field(str(data.get("token") or ""))),
        "secret": lock(open_field(str(data.get("secret") or ""))),
        "totp_step": int(data.get("totp_step") or 0),
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    wake()


def save_link(url: str, house: str, token: str, secret: str | None = None) -> None:
    current = {}
    path = config_path()
    if path.exists():
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            current = {}
    payload = {
        "url": url,
        "house": house,
        "token": token,
        "secret": secret if secret is not None else str(current.get("secret") or ""),
        "totp_step": int(current.get("totp_step") or 0),
    }
    _write_config(payload)


def save_totp_step(step: int) -> None:
    cfg = load_config()
    if cfg is None:
        return
    _write_config({**cfg, "totp_step": int(step)})


def save_secret(secret: str) -> None:
    cfg = load_config()
    if cfg is None:
        return
    _write_config({**cfg, "secret": secret, "totp_step": 0})


def _password_ok(password: str) -> None:
    if len(password) < 8:
        raise ValueError("Le mot de passe doit contenir au moins 8 caractères.")
    if len(password) > 80:
        raise ValueError("Le mot de passe est trop long.")


def change_password(current: str, new: str) -> None:
    _password_ok(new)
    _agent_json("/api/account", {"password": current, "next": new})


def reset_password(code: str, new: str) -> None:
    _password_ok(new)
    _agent_json("/api/account", {"reset": True, "otp": code, "next": new})


def disconnect_phones() -> None:
    _agent_json("/api/account", {"disconnect": True})


def create_house(password: str, url: str | None = None) -> dict:
    _password_ok(password)
    target = public_url(url)
    req = urllib.request.Request(
        target + "/api/houses",
        data=json.dumps({"password": password}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "maMaisonConnectee/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = str(payload.get("detail") or "")
        except (OSError, json.JSONDecodeError, UnicodeError):
            detail = ""
        raise ValueError(detail or "La page publique n'a pas répondu.") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise ValueError("La page publique n'a pas répondu.") from exc
    house = re.sub(r"[^A-Za-z0-9]", "", str(data.get("id") or "")).upper()
    token = str(data.get("token") or "")
    if len(house) != 8 or not token:
        raise ValueError("La page publique n'a pas créé la maison.")
    save_link(target, house, token, str(data.get("secret") or ""))
    return {
        "url": target,
        "house": house,
        "code": format_house(house),
        "secret": str(data.get("secret") or ""),
        "qr": str(data.get("qr") or ""),
        "codes": data.get("codes") or [],
    }


def _agent_json(path: str, payload: dict) -> dict:
    cfg = load_config()
    if cfg is None:
        raise ValueError("Cette maison n'est pas reliée.")
    req = urllib.request.Request(
        cfg["url"] + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + cfg["token"],
            "X-House": cfg["house"],
            "Content-Type": "application/json",
            "User-Agent": "maMaisonConnectee/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = str(payload.get("detail") or "")
        except (OSError, json.JSONDecodeError, UnicodeError):
            detail = ""
        raise ValueError(detail or "La page publique n'a pas répondu.") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise ValueError("La page publique n'a pas répondu.") from exc


def verify_action_totp(otp: str) -> None:
    cfg = load_config()
    secret = (cfg or {}).get("secret") or ""
    if not secret:
        raise ValueError("Régénère le carré des 6 chiffres dans Réglages, puis réessaie.")
    from app.otp import match_totp

    step = match_totp(secret, otp, last_step=int((cfg or {}).get("totp_step") or 0))
    if not step:
        raise ValueError("Les 6 chiffres sont incorrects.")
    save_totp_step(step)


def confirm_totp(code: str) -> None:
    _agent_json("/api/totp", {"code": code})


def rotate_totp() -> dict:
    data = _agent_json("/api/totp", {"rotate": True})
    secret = str(data.get("secret") or "")
    if secret:
        save_secret(secret)
    return {
        "house": format_house(load_config()["house"]),
        "secret": secret,
        "qr": str(data.get("qr") or ""),
    }


def backup_codes() -> dict:
    return _agent_json("/api/account", {"codes": True})


def list_people() -> dict:
    return _agent_json("/api/account", {"people": True})


def add_person(name: str, password: str, role: str) -> dict:
    return _agent_json("/api/account", {"addPerson": True, "name": name, "password": password, "role": role})


def list_sessions() -> dict:
    return _agent_json("/api/account", {"sessions": True})


def drop_session(session_id: str) -> dict:
    return _agent_json("/api/account", {"dropSession": session_id})


def allowed(method: str, path: str) -> bool:
    if method == "POST" and path in {"/api/check", "/api/alerts/read"}:
        return True
    if method == "POST" and (_RUN.match(path) or _PICTURE.match(path) or _SCENE.match(path)):
        return True
    if method == "PUT" and _RENAME.match(path):
        return True
    return False


def execute(command: dict) -> dict:
    method = str(command.get("method") or "POST")
    path = str(command.get("path") or "")
    if not allowed(method, path):
        return {"ok": False, "detail": "Cette action se fait sur l'ordinateur de la maison."}
    if path == "/api/check":
        from app import monitor
        monitor.kick()
        return {"ok": True, "detail": "Contrôle lancé."}
    if path == "/api/alerts/read":
        db.read_alerts()
        return {"ok": True}
    scene = _SCENE.match(path)
    if scene:
        from app import scenes

        extra = command.get("body") or {}
        return scenes.run_scene(int(scene.group(1)), source="telephone", otp=str(extra.get("otp") or ""))
    picture = _PICTURE.match(path)
    if picture:
        device = db.get_device(int(picture.group(1)))
        action = db.get_action(int(picture.group(1)), int(picture.group(2)))
        if not device or not action:
            return {"ok": False, "detail": "Commande introuvable"}
        try:
            return commands.capture_jpeg(device, action)
        except commands.CommandError as exc:
            return {"ok": False, "detail": str(exc)}
    rename = _RENAME.match(path)
    if rename and method == "PUT":
        device = db.get_device(int(rename.group(1)))
        if not device:
            return {"ok": False, "detail": "Appareil introuvable"}
        payload = command.get("body") or {}
        name = " ".join(str(payload.get("name") or device["name"]).split())[:80]
        room_id = payload.get("room_id") if payload.get("room_id") not in ("", None) else None
        fields = {**device, "name": name or device["name"], "room_id": room_id}
        db.update_device(device["id"], fields, "telephone")
        return {"ok": True, "detail": "C'est enregistré."}
    match = _RUN.match(path)
    device_id = int(match.group(1))
    action_id = int(match.group(2))
    device = db.get_device(device_id)
    action = db.get_action(device_id, action_id)
    if not device or not action:
        return {"ok": False, "detail": "Commande introuvable"}
    if action["kind"] == "stream":
        return {"ok": False, "detail": "L'image se regarde sur le Wi-Fi de la maison."}
    extra = command.get("body") or {}
    if action.get("confirm") == "totp":
        try:
            verify_action_totp(str(extra.get("otp") or ""))
        except ValueError as exc:
            return {"ok": False, "detail": str(exc)}
    if action.get("confirm") == "tap":
        from app import confirm

        if not extra.get("tap"):
            return confirm.arm_tap(device_id, action_id)
        problem = confirm.take_tap(device_id, action_id)
        if problem:
            return {"ok": False, "detail": problem}
    payload = {**action, "value": extra.get("value")}
    result = commands.run_http(device, payload)
    db.log_command(device_id, action_id, action["label"], result, "telephone")
    return result


def execute_once(command: dict) -> dict:
    from app import jobs

    command_id = str(command.get("id") or "")
    if not command_id:
        return execute(command)
    remembered = jobs.recall(command_id)
    if remembered is not None:
        return remembered
    jobs.mark(command_id)
    try:
        result = execute(command)
    except Exception:
        result = {"ok": False, "detail": "La commande a échoué"}
        jobs.finish(command_id, result)
        raise
    jobs.finish(command_id, result)
    return result


def snapshot() -> dict:
    now = time.time()
    if _network["value"] is None or now - _network["at"] > 60:
        try:
            _network["value"] = scanner.network_facts()
        except Exception:
            log.exception("lecture du réseau")
            _network["value"] = {
                "hostname": "",
                "local_ip": "",
                "gateway": "",
                "suggested_subnet": "",
                "adapter_name": "",
                "adapters": [],
            }
        _network["at"] = now
    histories = db.list_recent_histories()
    devices = []
    for item in db.list_devices():
        devices.append(
            {
                "id": item["id"],
                "name": item["name"],
                "type_id": item["type_id"],
                "type_name": item.get("type_name") or "",
                "room_id": item.get("room_id"),
                "room_name": item.get("room_name") or "",
                "state": item.get("state") or "unknown",
                "reading": item.get("reading") or "",
                "pinned": item.get("pinned") or 0,
                "important": item.get("important") or 0,
                "actions": [
                    {
                        "id": action["id"],
                        "label": action["label"],
                        "kind": action["kind"],
                        "method": action["method"],
                        "confirm": action.get("confirm") or "",
                        "value_kind": action.get("value_kind") or "",
                        "value_min": action.get("value_min"),
                        "value_max": action.get("value_max"),
                        "value_step": action.get("value_step"),
                    }
                    for action in (item.get("actions") or [])
                ],
                "history": [
                    {
                        "changed_at": row.get("changed_at"),
                        "source": row.get("source") or "",
                    }
                    for row in histories.get(item["id"], [])
                ],
            }
        )
    board = db.dashboard()
    board["devices"] = [
        {
            "id": item["id"],
            "name": item["name"],
            "type_name": item.get("type_name") or "",
            "room_name": item.get("room_name") or "",
            "state": item.get("state") or "unknown",
            "reading": item.get("reading") or "",
            "pinned": item.get("pinned") or 0,
            "actions": [
                {
                    "id": action["id"],
                    "label": action["label"],
                    "kind": action["kind"],
                    "confirm": action.get("confirm") or "",
                    "value_kind": action.get("value_kind") or "",
                }
                for action in (item.get("actions") or [])
            ],
        }
        for item in board.get("devices") or []
    ]
    return {
        "at": db.now(),
        "dashboard": board,
        "devices": devices,
        "types": db.list_types(),
        "rooms": db.list_rooms(),
        "settings": {
            "ping_timeout_ms": db.get_int_setting("ping_timeout_ms", 400),
            "poll_interval_s": db.get_int_setting("poll_interval_s", 30),
            "http_timeout_s": db.get_int_setting("http_timeout_s", 2),
            "lite_ui": db.get_settings().get("lite_ui") == "1",
        },
        "scenes": db.list_scenes(),
        "schedules": db.list_schedules(),
        "alerts": db.list_alerts(unread=True),
        "network": {
            "hostname": "",
            "local_ip": "",
            "gateway": "",
            "suggested_subnet": "",
            "adapter_name": "",
            "adapters": [],
        },
        "presets": commands.catalog(),
        "scan": {"state": "idle"},
    }


def _post(cfg: dict, payload: dict) -> dict:
    req = urllib.request.Request(
        cfg["url"] + "/api/agent",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + cfg["token"],
            "X-House": cfg["house"],
            "Content-Type": "application/json",
            "User-Agent": "maMaisonConnectee/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


def _cycle(cfg: dict, results: list[dict]) -> None:
    data = _post(cfg, {"snapshot": snapshot(), "results": results, "wait": 8})
    jobs = data.get("commands") or []
    if not jobs:
        return
    finished = [{"id": item.get("id"), "result": execute_once(item)} for item in jobs]
    _post(cfg, {"snapshot": snapshot(), "results": finished})


def _loop() -> None:
    while not _stop.is_set():
        cfg = load_config()
        if cfg is None:
            _pause(15)
            continue
        try:
            _cycle(cfg, [])
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            log.exception("lien avec la page publique")
        _pause(1)


def pull_secret() -> None:
    cfg = load_config()
    if cfg is None or cfg.get("secret"):
        return
    try:
        data = _agent_json("/api/totp", {"sync": True})
    except ValueError:
        return
    secret = str(data.get("secret") or "")
    if secret:
        save_secret(secret)


def start() -> None:
    global _thread
    if os.environ.get("MAISON_DISTANT", "1") == "0":
        return
    if _thread and _thread.is_alive():
        return
    try:
        cfg = load_config()
        if cfg and not cfg.get("secret"):
            pull_secret()
            cfg = load_config()
        if cfg:
            _write_config(cfg)
    except Exception:
        log.exception("lecture du secret")
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="maison-distant", daemon=True)
    _thread.start()


def wake() -> None:
    _wake.set()


def _pause(seconds: float) -> None:
    _wake.wait(seconds)
    _wake.clear()


def stop() -> None:
    _stop.set()
    wake()
    if _thread is not None:
        _thread.join(timeout=2)
