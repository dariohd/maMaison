import os
import socket
import sys
import threading
import time

PUBLIC_URL = "https://mamaisonconnectee.vercel.app"


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
    raise RuntimeError("Le programme n'a pas demarre.")


def serve(port: int) -> None:
    import uvicorn
    from app.main import app

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


def open_window(port: int) -> None:
    import webview

    webview.create_window(
        "maMaisonConnectee",
        f"http://127.0.0.1:{port}",
        width=1180,
        height=820,
        min_size=(860, 640),
    )
    webview.start()


def main() -> None:
    os.environ.setdefault("PYTHONUTF8", "1")
    port = int(os.environ.get("MAISON_PORT", "8787"))
    print("maMaisonConnectee")
    print("La fenetre du programme est l'ecran de la maison. Laisse-la ouverte.")
    print("Le telephone ouvre : " + PUBLIC_URL)
    if not port_free(port):
        print("maMaisonConnectee est deja ouvert sur cet ordinateur.")
        input("Appuyez sur Entree pour fermer.")
        return
    if os.environ.get("MAISON_OPEN_BROWSER", "1") == "0":
        serve(port)
        return
    threading.Thread(target=serve, args=(port,), daemon=True).start()
    wait_until_up(port)
    open_window(port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
