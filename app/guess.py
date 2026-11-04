from app import commands

SAFE = [
    ("/status", "GET"),
    ("/", "GET"),
    ("/api/status", "GET"),
    ("/relay/0", "GET"),
    ("/light/0", "GET"),
    ("/roller/0", "GET"),
    ("/cover/0", "GET"),
    ("/sensor/0", "GET"),
    ("/temperature", "GET"),
    ("/thermostat", "GET"),
    ("/snapshot.jpg", "GET"),
    ("/cgi-bin/snapshot.cgi", "GET"),
]

PATHS = {
    "Volet": [("/roller/0", "GET"), ("/cover/0", "GET"), ("/status", "GET"), ("/", "GET")],
    "Store": [("/roller/0", "GET"), ("/cover/0", "GET"), ("/status", "GET")],
    "Portail": [("/status", "GET"), ("/gate", "GET"), ("/", "GET")],
    "Serrure": [("/status", "GET"), ("/", "GET")],
    "Caméra": [("/snapshot.jpg", "GET"), ("/cgi-bin/snapshot.cgi", "GET"), ("/status", "GET")],
    "Sonnette": [("/snapshot.jpg", "GET"), ("/status", "GET")],
    "Ampoule": [("/light/0", "GET"), ("/relay/0", "GET"), ("/status", "GET")],
    "Prise": [("/relay/0", "GET"), ("/status", "GET")],
    "Interrupteur": [("/relay/0", "GET"), ("/status", "GET")],
    "Radiateur": [("/status", "GET"), ("/temperature", "GET"), ("/thermostat", "GET")],
    "Climatisation": [("/status", "GET"), ("/temperature", "GET")],
    "Chauffe-eau": [("/status", "GET"), ("/temperature", "GET")],
    "Ventilation": [("/status", "GET")],
    "Arrosage": [("/status", "GET")],
    "Télévision": [("/status", "GET"), ("/api/status", "GET")],
    "Enceinte": [("/status", "GET")],
    "Routeur": [("/status", "GET"), ("/", "GET")],
    "Capteur": [("/status", "GET"), ("/sensor/0", "GET")],
    "Alarme": [("/status", "GET"), ("/api/status", "GET")],
}

DANGEROUS = {"/up", "/down", "/open", "/close", "/lock", "/unlock", "/on", "/off", "/reboot", "/arm", "/disarm", "/gate"}


def guesses_for(type_name: str) -> list[tuple[str, str]]:
    items = PATHS.get(type_name, [("/status", "GET"), ("/", "GET")])
    return [(path, method) for path, method in items if path not in DANGEROUS]


def try_paths(device: dict, type_name: str) -> list[dict]:
    found = []
    for path, method in guesses_for(type_name):
        action = {
            "kind": "http",
            "method": method,
            "path": path,
            "body": "",
            "auth_user": "",
            "auth_pass": "",
        }
        result = commands.run_http(device, action)
        item = {"path": path, "method": method, "ok": bool(result.get("ok")), "detail": result.get("detail") or ""}
        found.append(item)
        if item["ok"] and len([row for row in found if row["ok"]]) >= 3:
            break
    return found
