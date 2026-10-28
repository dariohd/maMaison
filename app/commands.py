import base64
import shutil
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request

from app import probe

def _http(label: str, path: str, method: str = "GET", body: str = "") -> dict:
    return {"label": label, "kind": "http", "method": method, "path": path, "body": body}


def _flux(label: str, method: str, path: str) -> dict:
    return {"label": label, "kind": "stream", "method": method, "path": path, "body": ""}


CATALOG = [
    (
        "Ouvertures",
        [
            ("volet", "Volet", [_http("Monter", "/up"), _http("Stop", "/stop"), _http("Descendre", "/down")]),
            ("store", "Store", [_http("Monter", "/up"), _http("Stop", "/stop"), _http("Descendre", "/down")]),
            ("portail", "Portail", [_http("Ouvrir", "/open"), _http("Stop", "/stop"), _http("Fermer", "/close")]),
            ("serrure", "Serrure", [_http("Verrouiller", "/lock"), _http("Déverrouiller", "/unlock")]),
        ],
    ),
    (
        "Éclairage et prises",
        [
            ("ampoule", "Ampoule", [_http("Marche", "/on"), _http("Arrêt", "/off"), _http("Varier", "/level", "POST")]),
            ("prise", "Prise", [_http("Marche", "/on"), _http("Arrêt", "/off"), _http("Consommation", "/meter")]),
            ("interrupteur", "Interrupteur", [_http("Marche", "/on"), _http("Arrêt", "/off")]),
        ],
    ),
    (
        "Chauffage et eau",
        [
            ("radiateur", "Radiateur", [_http("Confort", "/comfort"), _http("Éco", "/eco"), _http("Hors gel", "/frost"), _http("Température", "/temperature")]),
            ("climatisation", "Climatisation", [_http("Froid", "/cool"), _http("Chaud", "/heat"), _http("Arrêt", "/off"), _http("Température", "/temperature")]),
            ("chauffe-eau", "Chauffe-eau", [_http("Marche", "/on"), _http("Arrêt", "/off"), _http("Température", "/temperature")]),
            ("ventilation", "Ventilation", [_http("Marche", "/on"), _http("Arrêt", "/off"), _http("Vitesse", "/speed", "POST")]),
            ("arrosage", "Arrosage", [_http("Ouvrir", "/on"), _http("Fermer", "/off")]),
        ],
    ),
    (
        "Image et son",
        [
            ("camera", "Caméra", [_flux("Image", "mjpeg", "/video.mjpg")]),
            ("sonnette", "Sonnette", [_flux("Image", "snapshot", "/snapshot.jpg"), _http("État", "/status")]),
            ("television", "Télévision", [_http("Marche", "/on"), _http("Arrêt", "/off"), _http("Source", "/source", "POST")]),
            ("enceinte", "Enceinte", [_http("Lecture", "/play"), _http("Pause", "/pause"), _http("Volume", "/volume", "POST")]),
        ],
    ),
    (
        "Réseau et sécurité",
        [
            ("routeur", "Routeur", [_http("État", "/status"), _http("Redémarrer", "/reboot", "POST")]),
            ("capteur", "Capteur", [_http("Lire", "/status")]),
            ("alarme", "Alarme", [_http("Armer", "/arm"), _http("Désarmer", "/disarm"), _http("État", "/status")]),
            ("lecture", "Lecture simple", [_http("Lire", "/status")]),
        ],
    ),
]

PRESETS = {
    key: commands
    for _group, items in CATALOG
    for key, _label, commands in items
}


def catalog() -> list[dict]:
    return [
        {
            "name": name,
            "items": [{"id": key, "label": label} for key, label, _commands in items],
        }
        for name, items in CATALOG
    ]

HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
STREAM_METHODS = {"mjpeg", "snapshot", "rtsp"}


class CommandError(Exception):
    pass


def clean_action(fields: dict) -> dict:
    label = " ".join((fields.get("label") or "").split())
    if not label or len(label) > 40:
        raise CommandError("Indique un nom de commande, 40 caractères au plus.")
    kind = fields.get("kind") or "http"
    if kind not in {"http", "stream"}:
        raise CommandError("Commande inconnue.")
    method = (fields.get("method") or "").strip()
    if kind == "http":
        method = method.upper() or "GET"
        if method not in HTTP_METHODS:
            raise CommandError("Méthode inconnue.")
    else:
        method = method.lower() or "mjpeg"
        if method not in STREAM_METHODS:
            raise CommandError("Flux inconnu. Choisis MJPEG, image ou RTSP.")
    path = (fields.get("path") or "/").strip() or "/"
    if "://" in path or path.startswith("//") or "\\" in path:
        raise CommandError("Le chemin reste sur l'appareil, par exemple /open.")
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 300:
        raise CommandError("Le chemin est trop long.")
    body = fields.get("body") or ""
    if len(body) > 2000:
        raise CommandError("Le corps de la commande est trop long.")
    auth_user = (fields.get("auth_user") or "").strip()
    auth_pass = fields.get("auth_pass") or ""
    if len(auth_user) > 80 or len(auth_pass) > 80:
        raise CommandError("L'identifiant ou le mot de passe est trop long.")
    return {
        "label": label,
        "kind": kind,
        "method": method,
        "path": path,
        "body": body if kind == "http" else "",
        "auth_user": auth_user,
        "auth_pass": auth_pass,
    }


def http_origin(device: dict) -> str:
    if device.get("protocol") == "https":
        port = device.get("port") or 443
        scheme = "https"
    elif device.get("protocol") == "http" and device.get("port"):
        port = device["port"]
        scheme = "http"
    else:
        port = 80
        scheme = "http"
    return f"{scheme}://{device['ip']}:{int(port)}"


def target_url(device: dict, action: dict) -> str:
    path = action["path"]
    if action["kind"] == "stream" and action["method"] == "rtsp":
        port = device.get("port") if device.get("protocol") == "rtsp" and device.get("port") else 554
        auth = ""
        if action.get("auth_user"):
            user = urllib.parse.quote(action["auth_user"], safe="")
            password = urllib.parse.quote(action.get("auth_pass") or "", safe="")
            auth = f"{user}:{password}@"
        return f"rtsp://{auth}{device['ip']}:{int(port)}{path}"
    return http_origin(device) + path


def _opener():
    context = ssl._create_unverified_context()

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context),
        _NoRedirect,
        urllib.request.ProxyHandler({}),
    )


def _request(device: dict, action: dict, timeout: float):
    url = target_url(device, action)
    data = None
    method = action["method"] if action["kind"] == "http" else "GET"
    if action["kind"] == "http" and method not in {"GET", "DELETE"}:
        data = (action.get("body") or "").encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("User-Agent", "maMaisonConnectee/1.0")
    request.add_header("Connection", "close")
    if action.get("auth_user"):
        token = base64.b64encode(
            f"{action['auth_user']}:{action.get('auth_pass') or ''}".encode("utf-8")
        ).decode("ascii")
        request.add_header("Authorization", f"Basic {token}")
    return _opener().open(request, timeout=timeout)


def run_http(device: dict, action: dict) -> dict:
    timeout = probe.timeouts()["http_timeout_s"]
    try:
        with _request(device, action, timeout) as response:
            excerpt = response.read(800).decode("utf-8", errors="replace").strip()
            detail = f"HTTP {response.status}"
            if excerpt:
                detail = f"{detail}. {excerpt[:180]}"
            return {"ok": response.status < 400, "detail": detail}
    except urllib.error.HTTPError as exc:
        ok = exc.code < 400
        return {"ok": ok, "detail": f"HTTP {exc.code}"}
    except (TimeoutError, urllib.error.URLError):
        return {"ok": False, "detail": "Appareil injoignable"}
    except Exception:
        return {"ok": False, "detail": "La commande a échoué"}


def stream_response(device: dict, action: dict):
    if action["kind"] != "stream":
        raise CommandError("Cette commande n'est pas un flux.")
    if action["method"] == "rtsp":
        if shutil.which("ffmpeg") is None:
            raise CommandError(
                "Pour un flux RTSP, ffmpeg doit être installé sur cet ordinateur. "
                "Un flux MJPEG ou une image fonctionne sans."
            )
        url = target_url(device, action)
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-i",
            url,
            "-an",
            "-f",
            "mpjpeg",
            "-q:v",
            "8",
            "-r",
            "8",
            "pipe:1",
        ]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )

        def chunks():
            try:
                assert proc.stdout is not None
                while True:
                    block = proc.stdout.read(16384)
                    if not block:
                        break
                    yield block
            finally:
                proc.kill()
                proc.wait(timeout=3)

        return chunks(), "multipart/x-mixed-replace; boundary=ffmpeg"

    timeout = max(probe.timeouts()["http_timeout_s"], 4)
    try:
        response = _request(device, action, timeout)
    except (TimeoutError, urllib.error.URLError, OSError) as exc:
        raise CommandError("Flux injoignable") from exc
    content_type = response.headers.get("Content-Type") or "image/jpeg"
    if action["method"] == "mjpeg" and "multipart" not in content_type.lower():
        content_type = "multipart/x-mixed-replace"

    def chunks():
        try:
            while True:
                block = response.read(16384)
                if not block:
                    break
                yield block
        finally:
            response.close()

    return chunks(), content_type
