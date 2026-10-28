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

log = logging.getLogger("maison.distant")
PUBLIC_URL = "https://mamaison-dariohprojects.vercel.app"
_stop = threading.Event()
_wake = threading.Event()
_thread: threading.Thread | None = None
_done: dict[str, dict] = {}
_network = {"at": 0.0, "value": None}
_RUN = re.compile(r"^/api/devices/(\d+)/actions/(\d+)/run$")


def config_path():
    return db.ROOT / "data" / "distant.json"


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
    if not url.startswith("https://") or not token or len(house) != 8:
        return None
    return {"url": url, "token": token, "house": house}


def format_house(house: str) -> str:
    if len(house) == 8:
        return f"{house[:4]}-{house[4:]}"
    return house


def public_url(url: str | None = None) -> str:
    target = (url or PUBLIC_URL).strip()
    parsed = urllib.parse.urlparse(target)
    if parsed.scheme != "https" or parsed.hostname != "mamaison-dariohprojects.vercel.app":
        raise ValueError("Adresse refusée")
    if parsed.path not in ("", "/"):
        raise ValueError("Adresse refusée")
    return f"https://{parsed.hostname}"


def save_link(url: str, house: str, token: str) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"url": url, "house": house, "token": token}, indent=2),
        encoding="utf-8",
    )
    wake()


def create_house(password: str, url: str | None = None) -> dict:
    if len(password) < 6:
        raise ValueError("Le mot de passe doit contenir au moins 6 caractères.")
    target = public_url(url)
    req = urllib.request.Request(
        target + "/api/houses",
        data=json.dumps({"password": password}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "maMaison/1.0",
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
    save_link(target, house, token)
    return {"url": target, "house": house, "code": format_house(house)}


def allowed(method: str, path: str) -> bool:
    if method == "POST" and path == "/api/check":
        return True
    return method == "POST" and _RUN.match(path) is not None


def execute(command: dict) -> dict:
    method = str(command.get("method") or "POST")
    path = str(command.get("path") or "")
    if not allowed(method, path):
        return {"ok": False, "detail": "Cette action se fait sur l'ordinateur de la maison."}
    if path == "/api/check":
        from app import monitor
        monitor.kick()
        return {"ok": True, "detail": "Contrôle lancé."}
    match = _RUN.match(path)
    device_id = int(match.group(1))
    action_id = int(match.group(2))
    device = db.get_device(device_id)
    action = db.get_action(device_id, action_id)
    if not device or not action:
        return {"ok": False, "detail": "Commande introuvable"}
    if action["kind"] != "http":
        return {"ok": False, "detail": "L'image se regarde sur le Wi-Fi de la maison."}
    return commands.run_http(device, action)


def execute_once(command: dict) -> dict:
    command_id = str(command.get("id") or "")
    if command_id and command_id in _done:
        return _done[command_id]
    result = execute(command)
    if command_id:
        _done[command_id] = result
        if len(_done) > 80:
            _done.pop(next(iter(_done)))
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
    return {
        "at": db.now(),
        "dashboard": db.dashboard(),
        "devices": db.list_devices(),
        "types": db.list_types(),
        "rooms": db.list_rooms(),
        "settings": {
            "subnet": db.get_settings().get("subnet") or "",
            "ping_timeout_ms": db.get_int_setting("ping_timeout_ms", 400),
            "poll_interval_s": db.get_int_setting("poll_interval_s", 30),
            "http_timeout_s": db.get_int_setting("http_timeout_s", 2),
        },
        "network": _network["value"],
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
            "User-Agent": "maMaison/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _cycle(cfg: dict, results: list[dict]) -> None:
    data = _post(cfg, {"snapshot": snapshot(), "results": results})
    commands = data.get("commands") or []
    if not commands:
        return
    finished = [{"id": item.get("id"), "result": execute_once(item)} for item in commands]
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
        _pause(8)


def start() -> None:
    global _thread
    if os.environ.get("MAISON_DISTANT", "1") == "0":
        return
    if _thread and _thread.is_alive():
        return
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
