import ipaddress
import logging
import os
import sqlite3
import threading
import webbrowser
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import commands, db, distant, monitor, probe, scanner
from app.paths import resource_root

log = logging.getLogger("maison")
STATIC = resource_root() / "static"
PROTOCOLS = {"ping", "http", "https", "tcp", "rtsp"}
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}


class DeviceBody(BaseModel):
    name: str = ""
    type_id: int
    room_id: int | None = None
    ip: str
    mac: str | None = ""
    hostname: str | None = ""
    port: int | None = None
    protocol: str = "ping"
    http_path: str = "/"
    notes: str = ""
    force: bool = False


class ProbeBody(BaseModel):
    ip: str
    protocol: str = "ping"
    port: int | None = None
    http_path: str = "/"


class SettingsBody(BaseModel):
    subnet: str = ""
    ping_timeout_ms: int
    poll_interval_s: int
    http_timeout_s: int


class NameBody(BaseModel):
    name: str


class ScanBody(BaseModel):
    subnet: str
    deep: bool = False


class CreateItem(BaseModel):
    name: str = ""
    type_id: int
    room_id: int | None = None
    ip: str
    mac: str | None = ""
    hostname: str | None = ""
    port: int | None = None
    protocol: str = "ping"
    http_path: str = "/"
    notes: str = ""


class UpdateItem(BaseModel):
    device_id: int
    ip: str
    mac: str | None = ""
    hostname: str | None = ""


class ActionBody(BaseModel):
    label: str = ""
    kind: str = "http"
    method: str = "GET"
    path: str = "/"
    body: str = ""
    auth_user: str = ""
    auth_pass: str = ""


class PresetBody(BaseModel):
    preset: str


class ApplyBody(BaseModel):
    creates: list[CreateItem] = Field(default_factory=list)
    updates: list[UpdateItem] = Field(default_factory=list)
    force: bool = False


class LinkBody(BaseModel):
    password: str = ""


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    if os.environ.get("MAISON_MONITOR", "1") != "0":
        monitor.start()
    distant.start()
    if os.environ.get("MAISON_OPEN_BROWSER") == "1":
        threading.Timer(0.7, lambda: webbrowser.open("http://127.0.0.1:8787")).start()
    yield
    distant.stop()
    monitor.stop()


app = FastAPI(title="maMaison", lifespan=lifespan)
app.mount("/assets", StaticFiles(directory=STATIC), name="assets")


@app.middleware("http")
async def local_only(request, call_next):
    host = request.client.host if request.client else ""
    if host not in LOCAL_HOSTS:
        return JSONResponse(
            status_code=403,
            content={"detail": "La console n'accepte que cet ordinateur."},
        )
    return await call_next(request)


@app.exception_handler(Exception)
async def unexpected(_request, exc):
    log.exception("erreur: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "La console a rencontré une erreur."},
    )


def clean_ip(value: str) -> str:
    try:
        addr = ipaddress.ip_address(value.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Adresse IP invalide.") from exc
    if not isinstance(addr, ipaddress.IPv4Address) or not scanner.is_home_network(
        ipaddress.ip_network(f"{addr}/32")
    ):
        raise HTTPException(status_code=400, detail="Indiquez une adresse du réseau de la maison.")
    if addr.is_loopback or addr.is_multicast or addr.is_unspecified or addr.is_link_local:
        raise HTTPException(status_code=400, detail="Indiquez une adresse du réseau de la maison.")
    return str(addr)


def clean_mac(value: str | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    mac = scanner.norm_mac(str(value))
    if mac is None:
        raise HTTPException(status_code=400, detail="Adresse MAC invalide.")
    return mac


def clean_path(value: str | None) -> str:
    path = (value or "/").strip() or "/"
    if not path.startswith("/") or "\\" in path or "://" in path:
        raise HTTPException(
            status_code=400,
            detail="Le chemin doit commencer par /, par exemple /status.",
        )
    if len(path) > 120:
        raise HTTPException(status_code=400, detail="Le chemin est trop long.")
    return path


def clean_link(protocol: str, port: int | None, http_path: str | None) -> tuple[str, int | None, str]:
    if protocol not in PROTOCOLS:
        raise HTTPException(status_code=400, detail="Liaison inconnue.")
    path = clean_path(http_path)
    if protocol == "http" and not port:
        port = 80
    elif protocol == "https" and not port:
        port = 443
    elif protocol == "rtsp" and not port:
        port = 554
    elif protocol == "tcp" and not port:
        raise HTTPException(status_code=400, detail="Indiquez le port de la liaison TCP.")
    elif protocol == "ping":
        port = None
    if port is not None and not 1 <= int(port) <= 65535:
        raise HTTPException(status_code=400, detail="Le port doit être compris entre 1 et 65535.")
    return protocol, port, path


def clean_label(value: str, what: str, limit: int = 40) -> str:
    name = " ".join((value or "").split())
    if not name:
        raise HTTPException(status_code=400, detail=f"Indiquez un nom pour {what}.")
    if len(name) > limit:
        raise HTTPException(status_code=400, detail=f"Le nom de {what} est trop long.")
    return name


def clean_device(body: DeviceBody, allow_empty_name: bool = False) -> dict:
    name = " ".join((body.name or "").split())
    ip = clean_ip(body.ip)
    if not name:
        if not allow_empty_name:
            raise HTTPException(status_code=400, detail="Indiquez un nom de 80 caractères au plus.")
        name = (body.hostname or "").strip() or f"Appareil {ip}"
    if len(name) > 80:
        raise HTTPException(status_code=400, detail="Indiquez un nom de 80 caractères au plus.")
    protocol, port, path = clean_link(body.protocol, body.port, body.http_path)
    notes = (body.notes or "").strip()
    if len(notes) > 500:
        raise HTTPException(status_code=400, detail="La note est trop longue.")
    hostname = " ".join((body.hostname or "").split())[:120]
    return {
        "name": name,
        "type_id": body.type_id,
        "room_id": body.room_id or None,
        "ip": ip,
        "mac": clean_mac(body.mac),
        "hostname": hostname,
        "port": port,
        "protocol": protocol,
        "http_path": path,
        "notes": notes,
    }


def ensure_refs(fields: dict) -> None:
    if not db.type_exists(fields["type_id"]):
        raise HTTPException(status_code=400, detail="Choisissez un type d'appareil.")
    if fields["room_id"] is not None and not db.room_exists(fields["room_id"]):
        raise HTTPException(status_code=400, detail="Choisissez une pièce existante.")


def ensure_free(fields: dict, ignore_id: int | None, force: bool) -> None:
    if fields.get("mac"):
        owner = db.find_mac_owner(fields["mac"], ignore_id)
        if owner:
            raise HTTPException(
                status_code=409,
                detail=f"Cette adresse MAC est déjà notée pour {owner['name']}.",
            )
    if force:
        return
    owner = db.find_ip_owner(fields["ip"], ignore_id)
    if owner:
        raise HTTPException(
            status_code=409,
            detail=f"Cette adresse est déjà utilisée par {owner['name']}.",
        )


def remember(device_id: int) -> dict:
    device = db.get_device(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Appareil introuvable.")
    try:
        result = probe.check_device(device)
    except Exception:
        log.exception("contrôle %s", device.get("ip"))
        result = {
            "state": "unknown",
            "latency_ms": None,
            "detail": "Contrôle impossible",
            "last_checked": db.now(),
        }
    db.save_status(device_id, result)
    return {"device": db.get_device(device_id), "check": result}


def recheck_later(ids: list[int]) -> None:
    def run() -> None:
        for device_id in ids:
            try:
                remember(device_id)
            except HTTPException:
                continue
            except Exception:
                log.exception("contrôle différé %s", device_id)

    if ids:
        threading.Thread(target=run, daemon=True).start()


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/api/network")
def network():
    return scanner.network_facts()


@app.get("/api/settings")
def settings():
    raw = db.get_settings()
    return {
        "subnet": raw.get("subnet") or "",
        "ping_timeout_ms": db.get_int_setting("ping_timeout_ms", 400),
        "poll_interval_s": db.get_int_setting("poll_interval_s", 30),
        "http_timeout_s": db.get_int_setting("http_timeout_s", 2),
    }


@app.get("/api/link")
def link_state():
    cfg = distant.load_config()
    return {"linked": cfg is not None, "url": distant.PUBLIC_URL}


@app.post("/api/link")
def link_house(body: LinkBody):
    try:
        url = distant.link_with_password(body.password)
    except ValueError as exc:
        status = 401 if "incorrect" in str(exc) else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"ok": True, "url": url}


@app.put("/api/settings")
def save_settings(body: SettingsBody):
    subnet = body.subnet.strip()
    if subnet:
        try:
            subnet = str(scanner.parse_subnet(subnet))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not 200 <= body.ping_timeout_ms <= 1500:
        raise HTTPException(status_code=400, detail="Le délai de ping doit rester entre 200 et 1500 ms.")
    if not 10 <= body.poll_interval_s <= 3600:
        raise HTTPException(status_code=400, detail="Le contrôle doit rester entre 10 secondes et 1 heure.")
    if not 1 <= body.http_timeout_s <= 6:
        raise HTTPException(status_code=400, detail="Le délai des pages doit rester entre 1 et 6 secondes.")
    db.set_settings(
        {
            "subnet": subnet,
            "ping_timeout_ms": body.ping_timeout_ms,
            "poll_interval_s": body.poll_interval_s,
            "http_timeout_s": body.http_timeout_s,
        }
    )
    return settings()


@app.get("/api/types")
def types():
    return db.list_types()


@app.get("/api/presets")
def presets():
    return commands.catalog()


@app.post("/api/types")
def create_type(body: NameBody):
    name = clean_label(body.name, "le type")
    try:
        type_id = db.add_type(name)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Ce type existe déjà.") from exc
    return {"id": type_id, "name": name}


@app.put("/api/types/{type_id}")
def update_type(type_id: int, body: NameBody):
    name = clean_label(body.name, "le type")
    try:
        found = db.rename_type(type_id, name)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Ce type existe déjà.") from exc
    if not found:
        raise HTTPException(status_code=404, detail="Type introuvable.")
    return {"id": type_id, "name": name}


@app.delete("/api/types/{type_id}")
def remove_type(type_id: int):
    reason = db.delete_type(type_id)
    if reason:
        status = 404 if reason == "Type introuvable." else 409
        raise HTTPException(status_code=status, detail=reason)
    return {"ok": True}


@app.get("/api/rooms")
def rooms():
    return db.list_rooms()


@app.post("/api/rooms")
def create_room(body: NameBody):
    name = clean_label(body.name, "la pièce")
    try:
        room_id = db.add_room(name)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Cette pièce existe déjà.") from exc
    return {"id": room_id, "name": name}


@app.put("/api/rooms/{room_id}")
def update_room(room_id: int, body: NameBody):
    name = clean_label(body.name, "la pièce")
    try:
        found = db.rename_room(room_id, name)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Cette pièce existe déjà.") from exc
    if not found:
        raise HTTPException(status_code=404, detail="Pièce introuvable.")
    return {"id": room_id, "name": name}


@app.delete("/api/rooms/{room_id}")
def remove_room(room_id: int):
    if not db.delete_room(room_id):
        raise HTTPException(status_code=404, detail="Pièce introuvable.")
    return {"ok": True}


@app.get("/api/dashboard")
def dashboard():
    data = db.dashboard()
    data["settings"] = settings()
    return data


@app.get("/api/devices")
def devices():
    return db.list_devices()


@app.get("/api/devices/{device_id}")
def device(device_id: int):
    found = db.get_device(device_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Appareil introuvable.")
    return found


@app.get("/api/devices/{device_id}/history")
def history(device_id: int):
    if db.get_device(device_id) is None:
        raise HTTPException(status_code=404, detail="Appareil introuvable.")
    return db.list_history(device_id)


@app.post("/api/devices")
def create_device(body: DeviceBody):
    fields = clean_device(body)
    ensure_refs(fields)
    ensure_free(fields, None, body.force)
    try:
        device_id = db.insert_device(fields, "creation")
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="Cette fiche entre en conflit avec un appareil déjà enregistré.",
        ) from exc
    return remember(device_id)


@app.put("/api/devices/{device_id}")
def update_device(device_id: int, body: DeviceBody):
    if db.get_device(device_id) is None:
        raise HTTPException(status_code=404, detail="Appareil introuvable.")
    fields = clean_device(body)
    ensure_refs(fields)
    ensure_free(fields, device_id, body.force)
    try:
        db.update_device(device_id, fields, "manuel")
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="Cette fiche entre en conflit avec un appareil déjà enregistré.",
        ) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Appareil introuvable.") from exc
    return remember(device_id)


def _clean_action(body: ActionBody) -> dict:
    try:
        return commands.clean_action(body.model_dump())
    except commands.CommandError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _device_or_404(device_id: int) -> dict:
    found = db.get_device(device_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Appareil introuvable.")
    return found


@app.get("/api/devices/{device_id}/actions")
def device_actions(device_id: int):
    _device_or_404(device_id)
    return db.list_actions(device_id, secrets=True)


@app.post("/api/devices/{device_id}/actions")
def create_action(device_id: int, body: ActionBody):
    _device_or_404(device_id)
    return db.insert_action(device_id, _clean_action(body))


@app.put("/api/devices/{device_id}/actions/{action_id}")
def save_action(device_id: int, action_id: int, body: ActionBody):
    _device_or_404(device_id)
    saved = db.update_action(device_id, action_id, _clean_action(body))
    if saved is None:
        raise HTTPException(status_code=404, detail="Commande introuvable.")
    return saved


@app.delete("/api/devices/{device_id}/actions/{action_id}")
def remove_action(device_id: int, action_id: int):
    _device_or_404(device_id)
    if not db.delete_action(device_id, action_id):
        raise HTTPException(status_code=404, detail="Commande introuvable.")
    return {"ok": True}


@app.post("/api/devices/{device_id}/actions/preset")
def apply_preset(device_id: int, body: PresetBody):
    _device_or_404(device_id)
    preset = commands.PRESETS.get(body.preset)
    if preset is None:
        raise HTTPException(status_code=400, detail="Modèle inconnu.")
    for item in preset:
        db.insert_action(device_id, commands.clean_action(item))
    return db.list_actions(device_id, secrets=True)


@app.post("/api/devices/{device_id}/actions/{action_id}/run")
def run_action(device_id: int, action_id: int):
    device = _device_or_404(device_id)
    action = db.get_action(device_id, action_id)
    if action is None:
        raise HTTPException(status_code=404, detail="Commande introuvable.")
    if action["kind"] != "http":
        raise HTTPException(status_code=400, detail="Cette commande s'affiche, elle ne s'envoie pas.")
    return commands.run_http(device, action)


@app.get("/api/devices/{device_id}/actions/{action_id}/stream")
def stream_action(device_id: int, action_id: int):
    device = _device_or_404(device_id)
    action = db.get_action(device_id, action_id)
    if action is None:
        raise HTTPException(status_code=404, detail="Commande introuvable.")
    try:
        chunks, content_type = commands.stream_response(device, action)
    except commands.CommandError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return StreamingResponse(
        chunks,
        media_type=content_type,
        headers={"Cache-Control": "no-store"},
    )


@app.delete("/api/devices/{device_id}")
def remove_device(device_id: int):
    if not db.delete_device(device_id):
        raise HTTPException(status_code=404, detail="Appareil introuvable.")
    return {"ok": True}


@app.post("/api/probe")
def probe_endpoint(body: ProbeBody):
    ip = clean_ip(body.ip)
    protocol, port, path = clean_link(body.protocol, body.port, body.http_path)
    try:
        return probe.check_endpoint(
            ip,
            protocol,
            port,
            path,
            probe.timeouts()["ping_timeout_ms"],
            probe.timeouts()["http_timeout_s"],
        )
    except Exception as exc:
        log.exception("probe")
        raise HTTPException(status_code=400, detail="Le contrôle a échoué.") from exc


@app.post("/api/check")
def check_now():
    started = monitor.kick()
    return {"started": started}


@app.get("/api/scan")
def scan_state():
    return scanner.public_scan()


@app.post("/api/scan")
def scan_start(body: ScanBody):
    try:
        scanner.parse_subnet(body.subnet)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return scanner.start_scan(body.subnet.strip(), body.deep)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/scan/cancel")
def scan_cancel():
    return {"cancelled": scanner.request_cancel()}


@app.post("/api/scan/apply")
def scan_apply(body: ApplyBody):
    if not body.creates and not body.updates:
        raise HTTPException(status_code=400, detail="Sélectionnez au moins un appareil.")
    if len(body.creates) > 80 or len(body.updates) > 80:
        raise HTTPException(status_code=400, detail="Traitez 80 appareils à la fois au maximum.")
    creates = []
    for item in body.creates:
        fields = clean_device(
            DeviceBody(
                name=item.name,
                type_id=item.type_id,
                room_id=item.room_id,
                ip=item.ip,
                mac=item.mac or "",
                hostname=item.hostname or "",
                port=item.port,
                protocol=item.protocol,
                http_path=item.http_path,
                notes=item.notes,
            ),
            allow_empty_name=True,
        )
        ensure_refs(fields)
        creates.append(fields)
    updates = []
    for item in body.updates:
        updates.append(
            {
                "device_id": item.device_id,
                "ip": clean_ip(item.ip),
                "mac": clean_mac(item.mac),
                "hostname": " ".join((item.hostname or "").split())[:120],
            }
        )
    try:
        result = db.apply_batch(creates, updates, body.force)
    except db.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except db.Missing as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="Cette fiche entre en conflit avec un appareil déjà enregistré.",
        ) from exc
    recheck_later(result["created"] + result["updated"])
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8787)
