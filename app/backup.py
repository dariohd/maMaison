import json
import sqlite3
import zipfile
from io import BytesIO
from pathlib import Path

from app import db
from app.distant import config_path, load_config
from app.paths import home_root
from app.version import VERSION


def export_bytes() -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("version.txt", VERSION)
        db_file = db.db_path()
        if db_file.exists():
            archive.write(db_file, "maison.db")
        link = config_path()
        if link.exists():
            archive.write(link, "distant.json")
        settings = {"version": VERSION, "home": str(home_root())}
        archive.writestr("meta.json", json.dumps(settings, indent=2))
    return buffer.getvalue()


def restore_bytes(payload: bytes) -> dict:
    import os

    from app import monitor

    if len(payload) > 12 * 1024 * 1024:
        raise ValueError("Cette sauvegarde est trop lourde.")
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        names = set(archive.namelist())
        if "maison.db" not in names:
            raise ValueError("Cette sauvegarde n'a pas la maison.")
        info = archive.getinfo("maison.db")
        if info.file_size > 30 * 1024 * 1024:
            raise ValueError("Cette sauvegarde est trop lourde.")
        raw = archive.read("maison.db")
        distant = archive.read("distant.json") if "distant.json" in names else None
    target = db.db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name("maison.restore.db")
    staging.write_bytes(raw)
    conn = sqlite3.connect(str(staging))
    try:
        row = conn.execute("PRAGMA integrity_check").fetchone()
    finally:
        conn.close()
    if not row or str(row[0]) != "ok":
        staging.unlink(missing_ok=True)
        raise ValueError("Cette sauvegarde est endommagée.")
    monitor.stop()
    try:
        db.close_files()
        for suffix in ("", "-wal", "-shm"):
            extra = Path(str(target) + suffix) if suffix else target
            if extra.exists():
                extra.unlink()
        staging.replace(target)
        if distant is not None:
            config_path().parent.mkdir(parents=True, exist_ok=True)
            config_path().write_bytes(distant)
        db.init_db()
        cfg = load_config()
        return {"ok": True, "house": cfg["house"] if cfg else ""}
    finally:
        if staging.exists():
            staging.unlink(missing_ok=True)
        if os.environ.get("MAISON_MONITOR", "1") != "0":
            monitor.start()
