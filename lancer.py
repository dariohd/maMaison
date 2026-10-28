import os
import socket
import sys
import threading
import webbrowser

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


def open_page() -> None:
    from app import distant

    if distant.load_config():
        webbrowser.open(PUBLIC_URL)
        return
    webbrowser.open("http://127.0.0.1:8787")


def main() -> None:
    os.environ.setdefault("PYTHONUTF8", "1")
    port = int(os.environ.get("MAISON_PORT", "8787"))
    print("maMaisonConnectee")
    print("Laissez cette fenetre ouverte.")
    print("Le telephone utilise : " + PUBLIC_URL)
    if not port_free(port):
        print("maMaisonConnectee est deja ouvert sur cet ordinateur.")
        input("Appuyez sur Entree pour fermer.")
        return
    if os.environ.get("MAISON_OPEN_BROWSER", "1") != "0":
        threading.Timer(0.8, open_page).start()
    import uvicorn
    from app.main import app

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
