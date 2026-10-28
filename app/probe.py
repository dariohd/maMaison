import os
import re
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request

from app import db

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def console_encoding() -> str:
    if os.name != "nt":
        return "utf-8"
    try:
        import ctypes

        return f"cp{ctypes.windll.kernel32.GetOEMCP()}"
    except Exception:
        return "cp850"


def run_command(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        capture_output=True,
        timeout=timeout,
        creationflags=CREATE_NO_WINDOW,
    )


def decode_output(data: bytes) -> str:
    return data.decode(console_encoding(), errors="replace")


def ping(ip: str, timeout_ms: int) -> tuple[bool, int | None]:
    timeout_ms = max(150, min(int(timeout_ms), 2000))
    try:
        proc = run_command(
            ["ping", "-n", "1", "-w", str(timeout_ms), ip],
            timeout=(timeout_ms / 1000) + 2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, None
    if proc.returncode != 0:
        return False, None
    text = decode_output(proc.stdout)
    match = re.search(r"(?:time|temps|durée|duree)[=<]\s*(\d+)", text, re.I)
    latency = int(match.group(1)) if match else None
    return True, latency


def tcp_open(ip: str, port: int, timeout: float) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((ip, int(port)))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def http_probe(ip: str, port: int, path: str, https: bool, timeout: float) -> tuple[bool, str]:
    scheme = "https" if https else "http"
    if not path.startswith("/"):
        path = "/" + path
    url = f"{scheme}://{ip}:{port}{path}"
    context = ssl._create_unverified_context() if https else None
    for method in ("HEAD", "GET"):
        request = urllib.request.Request(
            url,
            method=method,
            headers={"User-Agent": "maMaisonConnectee/1.0", "Connection": "close"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
                response.read(64)
                return True, f"HTTP {response.status}"
        except urllib.error.HTTPError as exc:
            if exc.code == 405 and method == "HEAD":
                continue
            if exc.code < 500:
                return True, f"HTTP {exc.code}"
            return False, f"HTTP {exc.code}"
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (TimeoutError, socket.timeout)):
                return False, "Délai dépassé"
            return False, "Page injoignable"
        except (TimeoutError, socket.timeout):
            return False, "Délai dépassé"
        except Exception:
            return False, "Page injoignable"
    return False, "Page injoignable"


def timeouts() -> dict:
    ping_ms = db.get_int_setting("ping_timeout_ms", 400)
    http_s = db.get_int_setting("http_timeout_s", 2)
    return {
        "ping_timeout_ms": max(150, min(ping_ms, 2000)),
        "http_timeout_s": max(1, min(http_s, 6)),
    }


def check_endpoint(
    ip: str,
    protocol: str,
    port: int | None,
    http_path: str,
    ping_timeout_ms: int,
    http_timeout_s: float,
) -> dict:
    answered, latency = ping(ip, ping_timeout_ms)
    checked = time.strftime("%Y-%m-%dT%H:%M:%S")
    protocol = protocol or "ping"

    def pack(state: str, detail: str, latency_value: int | None = latency) -> dict:
        return {
            "state": state,
            "latency_ms": latency_value,
            "detail": detail,
            "last_checked": checked,
        }

    if protocol == "ping":
        if answered:
            shown = f"{latency} ms" if latency is not None else "réponse reçue"
            return pack("online", f"Ping {shown}")
        return pack("offline", "Pas de réponse au ping", None)

    if protocol in {"http", "https"}:
        used_port = port or (443 if protocol == "https" else 80)
        ok, detail = http_probe(ip, used_port, http_path or "/", protocol == "https", http_timeout_s)
        if ok:
            return pack("online", detail)
        if answered:
            return pack("degraded", "Ping reçu, page injoignable")
        return pack("offline", detail, None)

    used_port = port or (554 if protocol == "rtsp" else None)
    if not used_port:
        return pack("offline", "Port manquant", None if not answered else latency)
    open_port = tcp_open(ip, used_port, min(http_timeout_s, 2))
    if open_port:
        if protocol == "rtsp":
            return pack("online", f"Flux RTSP joignable, port {used_port}")
        return pack("online", f"Port {used_port} ouvert")
    if answered:
        return pack("degraded", f"Ping reçu, port {used_port} fermé")
    return pack("offline", f"Port {used_port} fermé", None)


def check_device(device: dict) -> dict:
    limits = timeouts()
    return check_endpoint(
        device["ip"],
        device.get("protocol") or "ping",
        device.get("port"),
        device.get("http_path") or "/",
        limits["ping_timeout_ms"],
        limits["http_timeout_s"],
    )
