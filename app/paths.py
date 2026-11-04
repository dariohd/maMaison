import os
import shutil
import sys
from pathlib import Path


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent.parent


def project_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def home_root() -> Path:
    forced = os.environ.get("MAISON_HOME")
    if forced:
        path = Path(forced)
        path.mkdir(parents=True, exist_ok=True)
        return path
    if getattr(sys, "frozen", False):
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        path = base / "maMaisonConnectee"
        path.mkdir(parents=True, exist_ok=True)
        _migrate_next_to_exe(path)
        return path
    return Path(__file__).resolve().parent.parent


def _migrate_next_to_exe(target: Path) -> None:
    source = Path(sys.executable).resolve().parent / "data"
    dest = target / "data"
    if dest.exists() or not source.exists():
        return
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("maison.db", "maison.db-wal", "maison.db-shm", "distant.json", "jobs.json", "programme.log"):
        item = source / name
        if item.exists() and not (dest / name).exists():
            shutil.copy2(item, dest / name)
