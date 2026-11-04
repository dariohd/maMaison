import json
import os
import threading
from pathlib import Path

LIMIT = 120
_lock = threading.Lock()
_memory: dict[str, dict] = {}

INTERRUPTED = {"ok": False, "detail": "Cette commande a déjà été prise. Réessaie si rien n'a bougé."}


def jobs_path() -> Path:
    forced = os.environ.get("MAISON_JOBS")
    if forced:
        return Path(forced)
    db = os.environ.get("MAISON_DB")
    if db:
        return Path(db).with_name("jobs.json")
    from app.paths import home_root

    return home_root() / "data" / "jobs.json"


def _load_disk() -> dict:
    path = jobs_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_disk(data: dict) -> None:
    path = jobs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    trimmed = dict(list(data.items())[-LIMIT:])
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(trimmed), encoding="utf-8")
    tmp.replace(path)


def _public_result(result: dict) -> dict:
    if not isinstance(result, dict):
        return {"ok": False, "detail": "La commande a échoué"}
    payload = {
        "ok": bool(result.get("ok")),
        "detail": str(result.get("detail") or "")[:180],
    }
    if result.get("need"):
        payload["need"] = result["need"]
    return payload


def recall(command_id: str) -> dict | None:
    key = str(command_id or "")
    if not key:
        return None
    with _lock:
        if key in _memory:
            return _memory[key]
        stored = _load_disk().get(key)
    if not stored or not isinstance(stored, dict):
        return None
    if stored.get("status") == "done":
        result = stored.get("result") if isinstance(stored.get("result"), dict) else {"ok": True}
        return result
    return dict(INTERRUPTED)


def mark(command_id: str) -> None:
    key = str(command_id or "")
    if not key:
        return
    with _lock:
        data = _load_disk()
        if key not in data:
            data[key] = {"status": "taken"}
            _save_disk(data)


def finish(command_id: str, result: dict) -> None:
    key = str(command_id or "")
    if not key:
        return
    public = _public_result(result)
    with _lock:
        _memory[key] = result if isinstance(result, dict) else public
        if len(_memory) > LIMIT:
            _memory.pop(next(iter(_memory)))
        data = _load_disk()
        data[key] = {"status": "done", "result": public}
        _save_disk(data)
