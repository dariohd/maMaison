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


def _networks():
    raw = (db.get_settings().get("subnets") or db.get_settings().get("subnet") or "").strip()
    if raw:
        try:
            return scanner.parse_subnets(raw)
        except ValueError:
            return []
    found = set()
    for device in db.list_devices():
        try:
            addr = ipaddress.ip_address(device["ip"])
        except ValueError:
            continue
        network = ipaddress.ip_network(f"{addr}/24", strict=False)
        if isinstance(network, ipaddress.IPv4Network) and scanner.is_home_network(network):
            found.add(network)
    return list(found)


def _network():
    nets = _networks()
    return nets[0] if len(nets) == 1 else None


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
        previous = {item["id"]: item.get("state") for item in db.list_devices()}
        for network in _networks():
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
                before = previous.get(device_id)
                db.save_status(device_id, result)
                if before == "online" and result.get("state") == "offline":
                    device = db.get_device(device_id)
                    if device and device.get("important"):
                        db.add_alert(device_id, f"{device['name']} ne répond plus.")
        from app import readings

        for device in db.list_devices():
            if device.get("reading_path") and device.get("state") == "online":
                try:
                    readings.refresh_device(device)
                except Exception:
                    log.exception("lecture %s", device.get("ip"))
            if device.get("protocol") == "https":
                try:
                    from app import commands

                    fp = commands.fingerprint(device)
                    if fp:
                        trusted, changed = db.note_cert(device["id"], fp)
                        if changed:
                            if trusted:
                                db.add_alert(device["id"], f"Le certificat de {device['name']} a changé.")
                            else:
                                db.add_alert(device["id"], f"Confirme le certificat de {device['name']}.")
                except Exception:
                    log.exception("certificat %s", device.get("ip"))
        if not scanner.scan_running():
            arp = {}
            for network in _networks():
                arp.update(scanner.arp_table(network))
            moved = db.retarget_by_mac(arp)
            missing_host = [item for item in db.list_devices() if item.get("hostname") and not item.get("mac")]
            if missing_host:
                host_map = {}
                for ip in list(arp)[:40]:
                    name = (scanner.lookup_name(ip) or "").lower()
                    if name:
                        host_map[name.split(".")[0]] = ip
                        host_map[name] = ip
                moved.extend(db.retarget_by_hostname(host_map))
            if moved:
                _recheck([item["id"] for item in moved])
                devices = db.list_devices()
                arp = {}
                for network in _networks():
                    arp.update(scanner.arp_table(network))
            _mark_impostors(devices, arp)
        _run_due_schedules()
        return len(devices)
    finally:
        _lock.release()


def _run_due_schedules() -> None:
    stamp = db.now()
    weekday = str(__import__("datetime").datetime.now().isoweekday())
    for item in db.due_schedules(stamp, weekday):
        from app import scenes

        try:
            scenes.run_scene(item["scene_id"], source="horaire")
            db.mark_schedule_run(item["id"], stamp[:16])
        except Exception:
            log.exception("horaire %s", item.get("id"))


def kick() -> bool:
    if _lock.locked():
        return False
    threading.Thread(target=check_all, daemon=True).start()
    return True


def _loop() -> None:
    last_check = 0.0
    while not _stop.is_set():
        interval = max(10, min(db.get_int_setting("poll_interval_s", 30), 3600))
        now = time.time()
        try:
            if now - last_check >= interval:
                check_all()
                last_check = now
            else:
                _run_due_schedules()
        except Exception:
            log.exception("cycle de contrôle")
        if _stop.wait(min(30, interval)):
            return


def start() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="maison-monitor", daemon=True)
    _thread.start()


def stop() -> None:
    global _thread
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=5)
        _thread = None
    if _lock.acquire(timeout=8):
        _lock.release()
