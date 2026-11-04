import os
import socket
import sys
import threading
import time
import traceback

PUBLIC_URL = "https://mamaisonconnectee.vercel.app"


def keep_stdio() -> None:
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        from app.paths import home_root

        folder = home_root() / "data"
        folder.mkdir(parents=True, exist_ok=True)
        handle = open(folder / "programme.log", "a", encoding="utf-8")
    except OSError:
        handle = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = handle
    if sys.stderr is None:
        sys.stderr = handle


def tell(text: str, error: bool = False) -> None:
    if sys.platform == "win32":
        import ctypes

        flags = 0x10 if error else 0x40
        ctypes.windll.user32.MessageBoxW(None, text, "maMaisonConnectee", flags)
        return
    print(text, file=sys.stderr)


def port_free(port: int) -> bool:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        return False
    finally:
        sock.close()
    return True


def wait_until_up(port: int) -> None:
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.3):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Le programme n'a pas démarré.")


def serve(port: int) -> None:
    try:
        import uvicorn
        from app.main import app

        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    except Exception:
        traceback.print_exc()


def open_window(port: int) -> None:
    import webview
    from app.service import Tray, icon_path

    window = webview.create_window(
        "maMaisonConnectee",
        f"http://127.0.0.1:{port}",
        width=1180,
        height=820,
        min_size=(860, 640),
    )
    tray = Tray(window)

    def on_closing():
        if not tray.ready:
            tray.quit()
            return True
        tray.hide()
        return False

    window.events.closing += on_closing
    icon = icon_path()
    if icon.exists():
        try:
            window.set_icon(str(icon))
        except Exception:
            pass

    def after_start():
        tray.start()

    webview.start(after_start)


def main() -> None:
    keep_stdio()
    os.environ.setdefault("PYTHONUTF8", "1")
    try:
        port = int(os.environ.get("MAISON_PORT", "8787"))
    except ValueError:
        tell("Le programme n'a pas démarré.", error=True)
        return
    if not port_free(port):
        tell("maMaisonConnectee est déjà ouvert sur cet ordinateur.")
        return
    if os.environ.get("MAISON_OPEN_BROWSER", "1") == "0":
        serve(port)
        return
    threading.Thread(target=serve, args=(port,), daemon=True).start()
    try:
        wait_until_up(port)
    except RuntimeError:
        tell("Le programme n'a pas démarré.", error=True)
        return
    open_window(port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception:
        traceback.print_exc()
        tell("Le programme a rencontré une erreur.", error=True)
        sys.exit(1)
