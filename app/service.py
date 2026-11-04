import json
import os
import sys
import threading
import urllib.request
from pathlib import Path

from app.paths import home_root, project_root, resource_root
from app.version import DOWNLOAD, RELEASE, VERSION

APP_NAME = "maMaisonConnectee"


def icon_path() -> Path:
    local = resource_root() / "assets" / "maison.ico"
    if local.exists():
        return local
    return project_root() / "assets" / "maison.ico"


def startup_dir() -> Path:
    appdata = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    return appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def startup_path() -> Path:
    return startup_dir() / f"{APP_NAME}.vbs"


def program_command() -> str:
    if getattr(sys, "frozen", False):
        return str(Path(sys.executable))
    return f"{sys.executable} {project_root() / 'lancer.py'}"


def autostart_on() -> bool:
    folder = startup_dir()
    return (folder / f"{APP_NAME}.vbs").exists() or (folder / f"{APP_NAME}.cmd").exists()


def set_autostart(enabled: bool) -> dict:
    folder = startup_dir()
    vbs = folder / f"{APP_NAME}.vbs"
    cmd = folder / f"{APP_NAME}.cmd"
    if enabled:
        folder.mkdir(parents=True, exist_ok=True)
        if getattr(sys, "frozen", False):
            target = str(Path(sys.executable)).replace('"', "")
            line = f'w.Run """{target}""", 1, False'
        else:
            python = str(Path(sys.executable)).replace('"', "")
            lancer = str(project_root() / "lancer.py").replace('"', "")
            line = f'w.Run """{python}"" ""{lancer}""", 1, False'
        vbs.write_text(
            f'Set w = CreateObject("WScript.Shell")\r\n{line}\r\n',
            encoding="utf-8",
        )
        if cmd.exists():
            cmd.unlink()
    else:
        if vbs.exists():
            vbs.unlink()
        if cmd.exists():
            cmd.unlink()
    return {"ok": True, "autostart": autostart_on()}


def version_parts(value: str) -> list[int]:
    parts = []
    for piece in (value or "").strip().lstrip("vV").replace("-", ".").split("."):
        digits = "".join(char for char in piece if char.isdigit())
        if digits:
            parts.append(int(digits))
        elif parts:
            break
    return parts or [0]


def version_newer(latest: str, current: str) -> bool:
    left = version_parts(latest)
    right = version_parts(current)
    size = max(len(left), len(right))
    left.extend([0] * (size - len(left)))
    right.extend([0] * (size - len(right)))
    return left > right


def latest_release() -> dict:
    req = urllib.request.Request(
        "https://api.github.com/repos/dariohd/maMaison/releases/latest",
        headers={"User-Agent": "maMaisonConnectee/1.0", "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (OSError, json.JSONDecodeError, TimeoutError):
        return {"version": VERSION, "latest": VERSION, "newer": False, "url": RELEASE, "download": DOWNLOAD}
    tag = str(data.get("tag_name") or "").lstrip("v")
    return {
        "version": VERSION,
        "latest": tag or VERSION,
        "newer": version_newer(tag, VERSION),
        "url": str(data.get("html_url") or RELEASE),
        "download": DOWNLOAD,
    }


class Tray:
    def __init__(self, window) -> None:
        self.window = window
        self.icon = None
        self.ready = False

    def show(self) -> None:
        try:
            self.window.show()
            self.window.restore()
        except Exception:
            pass

    def hide(self) -> None:
        try:
            self.window.hide()
        except Exception:
            pass

    def quit(self) -> None:
        if self.icon is not None:
            try:
                self.icon.stop()
            except Exception:
                pass
        try:
            self.window.destroy()
        except Exception:
            pass
        os._exit(0)

    def start(self) -> None:
        try:
            import pystray
            from PIL import Image
        except Exception:
            return
        path = icon_path()
        image = Image.open(path) if path.exists() else Image.new("RGBA", (32, 32), (29, 79, 134, 255))
        menu = pystray.Menu(
            pystray.MenuItem("Ouvrir", lambda: self.show(), default=True),
            pystray.MenuItem("Quitter", lambda: self.quit()),
        )
        self.icon = pystray.Icon(APP_NAME, image, APP_NAME, menu)
        self.ready = True
        threading.Thread(target=self.icon.run, daemon=True).start()
