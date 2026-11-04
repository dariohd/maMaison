import os
import socket
import sys
import threading
import time
import traceback

PUBLIC_URL = "https://mamaisonconnectee.vercel.app"


def log_path():
    try:
        from app.paths import home_root

        folder = home_root() / "data"
        folder.mkdir(parents=True, exist_ok=True)
        return folder / "programme.log"
    except OSError:
        return None


def keep_stdio() -> None:
    path = log_path()
    try:
        handle = open(path, "a", encoding="utf-8") if path else open(os.devnull, "w", encoding="utf-8")
    except OSError:
        handle = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = handle
    if sys.stderr is None:
        sys.stderr = handle
    try:
        import logging

        logging.basicConfig(
            stream=handle,
            level=logging.WARNING,
            format="%(asctime)s %(name)s %(message)s",
            force=True,
        )
    except Exception:
        pass


def catch_window_errors() -> None:
    if sys.platform != "win32":
        return
    try:
        import System
        import System.Windows.Forms as WinForms
    except Exception:
        return
    try:
        WinForms.Application.SetUnhandledExceptionMode(WinForms.UnhandledExceptionMode.CatchException)
    except Exception:
        pass

    def on_thread(_sender, args) -> None:
        try:
            print("fenetre: " + str(getattr(args, "Exception", args)), file=sys.stderr, flush=True)
        except Exception:
            pass

    def on_domain(_sender, args) -> None:
        try:
            print("fenetre: " + str(getattr(args, "ExceptionObject", args)), file=sys.stderr, flush=True)
        except Exception:
            pass

    try:
        WinForms.Application.ThreadException += on_thread
    except Exception:
        pass
    try:
        System.AppDomain.CurrentDomain.UnhandledException += on_domain
    except Exception:
        pass


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
    from app.paths import home_root
    from app.service import Tray, icon_path

    catch_window_errors()
    window = webview.create_window(
        "maMaisonConnectee",
        f"http://127.0.0.1:{port}",
        width=1180,
        height=820,
        min_size=(860, 640),
        background_color="#d7e1ec",
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
    storage = home_root() / "data" / "webview"
    storage.mkdir(parents=True, exist_ok=True)

    def after_start():
        try:
            tray.start()
        except Exception:
            traceback.print_exc()

    webview.start(
        after_start,
        gui="edgechromium",
        private_mode=False,
        storage_path=str(storage),
        icon=str(icon) if icon.exists() else None,
    )


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
