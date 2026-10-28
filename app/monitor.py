import ipaddress
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app import db, probe, scanner

log = logging.getLogger("maison")
_lock = threading.Lock()
_stop = threading.Event()
_thread: threading.Thread | None = None
_last_sweep = 0.0


def _network():
    raw = (db.get_settings().get("subnet") or "").strip()
    if raw:
        try:
            return scanner.parse_subnet(raw)
        except ValueError:
            return None
    networks = set()
    for device in db.list_devices():
        try:
            addr = ipaddress.ip_address(device["ip"])
        except ValueError:
            continue
        network = ipaddress.ip_network(f"{addr}/24", strict=False)
        if isinstance(network, ipaddress.IPv4Network) and scanner.is_home_network(network):
            networks.add(network)
    if len(networks) == 1:
        return next(iter(networks))
    return None


def _mark_impostors(devices: list[dict], arp: dict[str, str]) -> None:
    for device in devices:
        mac = (device.get("mac") or "").upper()
        seen = arp.get(device["ip"], "")
        if not mac or not seen or seen == mac:
            continue
        db.save_status(
            device["id"],
            {
                "state": "offline",
                "latency_ms": None,
                "detail": "Un autre appareil répond à cette adresse.",
                "last_checked": db.now(),
            },
        )


def _recheck(device_ids: list[int]) -> None:
    for device_id in device_ids:
        device = db.get_device(device_id)
        if device is None:
            continue
        try:
            db.save_status(device_id, probe.check_device(device))
        except Exception:
            log.exception("contrôle après suivi %s", device_id)


def _recover(network) -> None:
    """Retrouve les appareils dont l'adresse a changé après un redémarrage."""
    global _last_sweep
    if scanner.scan_running():
        return
    arp = scanner.arp_table(network)
    moved = db.retarget_by_mac(arp)
    devices = db.list_devices()
    seen = set(arp.values())
    lost = False
    for device in devices:
        mac = (device.get("mac") or "").upper()
        if not mac:
            continue
        at_ip = arp.get(device["ip"], "")
        if at_ip and at_ip != mac:
            lost = True
            break
        if mac not in seen and device.get("state") in {"offline", "degraded", "unknown"}:
            lost = True
            break
    gap = 60 if network.num_addresses <= 256 else 180
    if lost and time.time() - _last_sweep >= gap:
        _last_sweep = time.time()
        try:
            arp = scanner.refresh_neighborhood(network)
        except Exception:
            log.exception("recherche des adresses")
            arp = scanner.arp_table(network)
        moved.extend(db.retarget_by_mac(arp))
    if moved:
        _recheck([item["id"] for item in moved])


def check_all() -> int:
    if not _lock.acquire(blocking=False):
        return 0
    try:
        network = _network()
        if network is not None:
            try:
                _recover(network)
            except Exception:
                log.exception("suivi des adresses")
        devices = db.list_devices()
        if not devices:
            return 0
        limits = probe.timeouts()

        def one(device: dict) -> tuple[int, dict]:
            try:
                result = probe.check_endpoint(
                    device["ip"],
                    device.get("protocol") or "ping",
                    device.get("port"),
                    device.get("http_path") or "/",
                    limits["ping_timeout_ms"],
                    limits["http_timeout_s"],
                )
            except Exception:
                log.exception("contrôle %s", device.get("ip"))
                result = {
                    "state": "unknown",
                    "latency_ms": None,
                    "detail": "Contrôle impossible",
                    "last_checked": db.now(),
                }
            return device["id"], result

        with ThreadPoolExecutor(max_workers=32) as pool:
            for device_id, result in pool.map(one, devices):
                db.save_status(device_id, result)
        if network is not None and not scanner.scan_running():
            arp = scanner.arp_table(network)
            moved = db.retarget_by_mac(arp)
            if moved:
                _recheck([item["id"] for item in moved])
                devices = db.list_devices()
                arp = scanner.arp_table(network)
            _mark_impostors(devices, arp)
        return len(devices)
    finally:
        _lock.release()


def kick() -> bool:
    if _lock.locked():
        return False
    threading.Thread(target=check_all, daemon=True).start()
    return True


def _loop() -> None:
    while not _stop.is_set():
        try:
            check_all()
        except Exception:
            log.exception("cycle de contrôle")
        interval = db.get_int_setting("poll_interval_s", 30)
        interval = max(10, min(interval, 3600))
        if _stop.wait(interval):
            return


def start() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="maison-monitor", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()
