import ipaddress
import logging
import re
import socket
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from app import db, probe

log = logging.getLogger("maison")
_lock = threading.Lock()
_cancel = threading.Event()
_job: dict | None = None

HOME_BLOCKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),
]

VIRTUAL_HINTS = (
    "vmware",
    "virtualbox",
    "hyper-v",
    "vethernet",
    "wsl",
    "docker",
    "loopback",
    "bluetooth",
    "vpn",
    "tap-windows",
    "npcap",
    "zerotier",
    "tailscale",
)


def now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def is_home_network(network: ipaddress.IPv4Network) -> bool:
    return any(network.subnet_of(block) for block in HOME_BLOCKS)


def parse_subnet(value: str) -> ipaddress.IPv4Network:
    try:
        network = ipaddress.ip_network(value.strip(), strict=False)
    except ValueError as exc:
        raise ValueError("Réseau invalide. Exemple : 192.168.1.0/24") from exc
    if not isinstance(network, ipaddress.IPv4Network):
        raise ValueError("Seul IPv4 est pris en charge.")
    if not is_home_network(network):
        raise ValueError("Seuls les réseaux privés de la maison peuvent être analysés.")
    if network.num_addresses > 1024:
        raise ValueError(
            "Ce réseau est trop grand. Indiquez un sous-réseau jusqu'au /22, par exemple 192.168.1.0/24."
        )
    return network


def iter_hosts(network: ipaddress.IPv4Network) -> list[str]:
    if network.prefixlen >= 31:
        return [str(ip) for ip in network]
    return [str(ip) for ip in network.hosts()]


def norm_mac(raw: str | None) -> str | None:
    if raw is None:
        return None
    hexonly = re.sub(r"[^0-9a-fA-F]", "", raw)
    if len(hexonly) != 12:
        return None
    mac = ":".join(hexonly[i : i + 2] for i in range(0, 12, 2)).upper()
    if mac in {"00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF"}:
        return None
    if int(mac[:2], 16) & 1:
        return None
    return mac


def parse_ipconfig(text: str) -> list[dict]:
    blocks = re.split(r"\r?\n(?=\S)", text.strip())
    adapters = []
    for block in blocks:
        lines = [line for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        name = lines[0].strip().rstrip(":").strip()
        ipv4 = re.search(
            r"(?:IPv4 Address|Adresse IPv4).*?:\s*(\d+\.\d+\.\d+\.\d+)",
            block,
            re.I,
        )
        mask = re.search(
            r"(?:Subnet Mask|Masque de sous-r[ée]seau).*?:\s*(\d+\.\d+\.\d+\.\d+)",
            block,
            re.I,
        )
        if not ipv4 or not mask:
            continue
        ip = ipv4.group(1)
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if addr.is_loopback or addr.is_link_local or addr.is_multicast:
            continue
        gateway_zone = ""
        gateway_match = re.search(
            r"(?:Default Gateway|Passerelle par d[ée]faut)([\s\S]{0,180})",
            block,
            re.I,
        )
        if gateway_match:
            gateway_zone = gateway_match.group(1)
        gateway_ip = re.search(r"(\d+\.\d+\.\d+\.\d+)", gateway_zone)
        gateway = gateway_ip.group(1) if gateway_ip else ""
        try:
            network = ipaddress.ip_interface(f"{ip}/{mask.group(1)}").network
        except ValueError:
            continue
        adapters.append(
            {
                "name": name,
                "ip": ip,
                "mask": mask.group(1),
                "gateway": gateway,
                "subnet": str(network),
                "prefix": network.prefixlen,
                "virtual": any(hint in name.lower() for hint in VIRTUAL_HINTS),
            }
        )
    return adapters


def arp_table(network: ipaddress.IPv4Network) -> dict[str, str]:
    try:
        proc = probe.run_command(["arp", "-a"], timeout=8)
        text = probe.decode_output(proc.stdout)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    return parse_arp(text, network)


def refresh_neighborhood(network: ipaddress.IPv4Network) -> dict[str, str]:
    """Ping chaque adresse pour remplir la table ARP, puis relit les cartes réseau."""
    hosts = iter_hosts(network)
    timeout_ms = probe.timeouts()["ping_timeout_ms"]
    if hosts and not scan_running():
        with ThreadPoolExecutor(max_workers=48) as pool:
            list(pool.map(lambda ip: probe.ping(ip, timeout_ms), hosts))
    return arp_table(network)


def parse_arp(text: str, network: ipaddress.IPv4Network) -> dict[str, str]:
    found: dict[str, str] = {}
    pattern = re.compile(
        r"(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})\s+(\S+)"
    )
    for ip, mac_raw, kind in pattern.findall(text):
        if kind.lower() in {"invalid", "invalide"}:
            continue
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if addr not in network:
            continue
        mac = norm_mac(mac_raw)
        if mac is None:
            continue
        found[ip] = mac
    return found


def udp_route_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("1.1.1.1", 80))
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()


def choose_adapter(adapters: list[dict], route_ip: str) -> dict | None:
    if not adapters:
        return None

    def score(adapter: dict) -> tuple:
        points = 0
        if adapter.get("gateway"):
            points += 10
        if not adapter.get("virtual"):
            points += 5
        if route_ip and adapter.get("ip") == route_ip:
            points += 20
        try:
            private = ipaddress.ip_address(adapter["ip"]).is_private
        except ValueError:
            private = False
        if private:
            points += 1
        return (points, 1 if adapter.get("gateway") else 0)

    ranked = sorted(adapters, key=score, reverse=True)
    best = ranked[0]
    if score(best)[0] <= 0:
        return None
    return best


def suggested_subnet(adapter: dict | None) -> str:
    if not adapter:
        return ""
    try:
        network = ipaddress.ip_network(adapter["subnet"], strict=False)
    except ValueError:
        return ""
    if not isinstance(network, ipaddress.IPv4Network):
        return ""
    if network.prefixlen < 22:
        host = ipaddress.ip_network(f"{adapter['ip']}/24", strict=False)
        return str(host)
    if not is_home_network(network):
        return ""
    return str(network)


def network_facts() -> dict:
    raw = ""
    try:
        proc = probe.run_command(["ipconfig"], timeout=8)
        raw = probe.decode_output(proc.stdout)
    except (OSError, subprocess.TimeoutExpired):
        raw = ""
    adapters = parse_ipconfig(raw) if raw else []
    route_ip = udp_route_ip()
    chosen = choose_adapter(adapters, route_ip)
    suggestion = suggested_subnet(chosen)
    gateway = chosen.get("gateway", "") if chosen else ""
    local_ip = chosen.get("ip", "") if chosen else route_ip
    return {
        "hostname": socket.gethostname(),
        "local_ip": local_ip,
        "gateway": gateway,
        "suggested_subnet": suggestion,
        "adapter_name": chosen.get("name", "") if chosen else "",
        "adapters": adapters,
    }


def lookup_name(ip: str) -> str:
    try:
        proc = probe.run_command(["nslookup", ip], timeout=1.2)
    except Exception:
        return ""
    text = probe.decode_output(proc.stdout)
    names = re.findall(r"(?:Nom|Name)\s*:\s*(\S+)", text, re.I)
    if not names:
        return ""
    name = names[-1].rstrip(".")
    if name == ip or name.lower() == "unknown":
        return ""
    return name[:120]


def suggest(obs: dict) -> tuple[str | None, str, int | None]:
    ports = set(obs.get("open_ports") or [])
    host = (obs.get("hostname") or "").lower()
    if obs.get("is_gateway"):
        type_name = "Routeur"
    elif obs.get("is_self"):
        type_name = "Ordinateur"
    elif 554 in ports or any(word in host for word in ("cam", "ipcam", "hikvision", "dahua", "reolink")):
        type_name = "Caméra"
    elif any(word in host for word in ("volet", "shutter", "somfy", "roller")):
        type_name = "Volet"
    elif any(word in host for word in ("radiat", "thermo", "chauff", "heat")):
        type_name = "Radiateur"
    else:
        type_name = None
    if 554 in ports:
        return type_name, "rtsp", 554
    if 443 in ports:
        return type_name, "https", 443
    if 8443 in ports:
        return type_name, "https", 8443
    if 8080 in ports:
        return type_name, "http", 8080
    if 80 in ports:
        return type_name, "http", 80
    if 1883 in ports:
        return type_name, "tcp", 1883
    return type_name, "ping", None


def decorate(obs: dict) -> dict:
    type_name, protocol, port = suggest(obs)
    return {
        **obs,
        "suggested_type": type_name,
        "suggested_protocol": protocol,
        "suggested_port": port,
    }


def ip_sort(value: str) -> tuple:
    try:
        return tuple(int(part) for part in value.split("."))
    except ValueError:
        return (999, 999, 999, 999)


def classify(observations: list[dict], devices: list[dict]) -> dict:
    by_mac = {}
    by_ip = {}
    for device in devices:
        mac = (device.get("mac") or "").upper()
        if mac:
            by_mac[mac] = device
        if device.get("ip"):
            by_ip[device["ip"]] = device
    changed, known, fresh, conflicts = [], [], [], []
    for obs in observations:
        mac = (obs.get("mac") or "").upper()
        ip = obs["ip"]
        mac_hit = by_mac.get(mac) if mac else None
        ip_hit = by_ip.get(ip)
        if mac_hit and mac_hit["ip"] != ip:
            changed.append(
                {
                    **obs,
                    "device_id": mac_hit["id"],
                    "device_name": mac_hit["name"],
                    "previous_ip": mac_hit["ip"],
                }
            )
        elif mac_hit:
            known.append({**obs, "device_id": mac_hit["id"], "device_name": mac_hit["name"]})
        elif ip_hit and ip_hit.get("mac") and mac and ip_hit["mac"].upper() != mac:
            conflicts.append(
                {
                    **obs,
                    "device_id": ip_hit["id"],
                    "device_name": ip_hit["name"],
                }
            )
        elif ip_hit:
            known.append({**obs, "device_id": ip_hit["id"], "device_name": ip_hit["name"]})
        else:
            fresh.append(obs)
    for bucket in (changed, known, fresh, conflicts):
        bucket.sort(key=lambda item: ip_sort(item["ip"]))
    return {"changed": changed, "known": known, "new": fresh, "conflicts": conflicts}


def snapshot() -> dict | None:
    with _lock:
        if _job is None:
            return None
        return {
            "state": _job["state"],
            "phase": _job["phase"],
            "done": _job["done"],
            "total": _job["total"],
            "subnet": _job["subnet"],
            "deep": _job["deep"],
            "started_at": _job["started_at"],
            "finished_at": _job["finished_at"],
            "error": _job["error"],
            "responding": len(_job["observations"]),
            "observations": list(_job["observations"]),
        }


def scan_running() -> bool:
    with _lock:
        return _job is not None and _job["state"] == "running"


def request_cancel() -> bool:
    with _lock:
        if _job is None or _job["state"] != "running":
            return False
    _cancel.set()
    return True


def _set(**fields) -> None:
    with _lock:
        if _job is not None:
            _job.update(fields)


def _add_obs(obs: dict) -> None:
    with _lock:
        if _job is not None:
            _job["observations"].append(obs)


def start_scan(subnet: str, deep: bool) -> dict:
    network = parse_subnet(subnet)
    with _lock:
        global _job
        if _job is not None and _job["state"] == "running":
            raise RuntimeError("Une analyse est déjà en cours.")
        _cancel.clear()
        _job = {
            "state": "running",
            "phase": "ping",
            "done": 0,
            "total": 0,
            "subnet": str(network),
            "deep": deep,
            "started_at": now(),
            "finished_at": None,
            "error": "",
            "observations": [],
        }
    db.set_settings({"subnet": str(network)})
    thread = threading.Thread(target=_run, args=(network, deep), daemon=True)
    thread.start()
    return snapshot() or {}


def _ping_host(ip: str, timeout_ms: int) -> tuple[str, bool, int | None]:
    if _cancel.is_set():
        return ip, False, None
    ok, latency = probe.ping(ip, timeout_ms)
    return ip, ok, latency


def _probe_ports(ip: str, ports: list[int], timeout: float) -> tuple[str, list[int]]:
    if _cancel.is_set():
        return ip, []
    opened = [port for port in ports if probe.tcp_open(ip, port, timeout)]
    return ip, opened


def _consume(pool: ThreadPoolExecutor, futures: list, handle) -> None:
    try:
        for future in as_completed(futures):
            if _cancel.is_set():
                break
            handle(future.result())
    finally:
        pool.shutdown(wait=not _cancel.is_set(), cancel_futures=True)


def _run(network: ipaddress.IPv4Network, deep: bool) -> None:
    try:
        hosts = iter_hosts(network)
        limits = probe.timeouts()
        timeout_ms = limits["ping_timeout_ms"]
        _set(phase="ping", done=0, total=len(hosts))
        ping_ok: dict[str, int | None] = {}
        completed: set[str] = set()

        def take_ping(result) -> None:
            ip, ok, latency = result
            completed.add(ip)
            if ok:
                ping_ok[ip] = latency
            with _lock:
                if _job is not None:
                    _job["done"] += 1

        ping_pool = ThreadPoolExecutor(max_workers=48)
        _consume(
            ping_pool,
            [ping_pool.submit(_ping_host, ip, timeout_ms) for ip in hosts],
            take_ping,
        )
        if _cancel.is_set() and not completed:
            _finish_cancelled([])
            return
        try:
            arp_proc = probe.run_command(["arp", "-a"], timeout=8)
            arp_text = probe.decode_output(arp_proc.stdout)
            arp_map = parse_arp(arp_text, network)
        except Exception:
            arp_map = {}
        facts = network_facts()
        local_ips = {item["ip"] for item in facts.get("adapters", []) if item.get("ip")}
        if facts.get("local_ip"):
            local_ips.add(facts["local_ip"])
        gateways = {item["gateway"] for item in facts.get("adapters", []) if item.get("gateway")}
        if facts.get("gateway"):
            gateways.add(facts["gateway"])

        candidates: dict[str, dict] = {}
        for ip in completed:
            mac = arp_map.get(ip, "")
            answered = ip in ping_ok
            if not answered and not mac and ip not in gateways:
                continue
            candidates[ip] = {
                "ip": ip,
                "mac": mac,
                "hostname": "",
                "latency_ms": ping_ok.get(ip),
                "answered_ping": answered,
                "open_ports": [],
                "is_self": ip in local_ips,
                "is_gateway": ip in gateways,
            }
        for gateway in gateways:
            try:
                inside = ipaddress.ip_address(gateway) in network
            except ValueError:
                inside = False
            if inside and gateway not in candidates:
                candidates[gateway] = {
                    "ip": gateway,
                    "mac": arp_map.get(gateway, ""),
                    "hostname": "",
                    "latency_ms": ping_ok.get(gateway),
                    "answered_ping": gateway in ping_ok,
                    "open_ports": [],
                    "is_self": gateway in local_ips,
                    "is_gateway": True,
                }

        silent: list[str] = []
        if deep and not _cancel.is_set():
            silent = [ip for ip in completed if ip not in candidates and ip not in local_ips]

        if _cancel.is_set():
            _finish_cancelled([decorate(item) for item in candidates.values()])
            return

        silent_set = set(silent)
        port_targets = list(candidates)
        if deep:
            port_targets.extend(silent)
        hint_ports = [80, 443, 554, 8080, 8443, 1883]
        deep_ports = [80, 443, 554]
        _set(phase="ports", done=0, total=len(port_targets))
        opened_map: dict[str, list[int]] = {}

        def take_port(result) -> None:
            ip, opened = result
            opened_map[ip] = opened
            with _lock:
                if _job is not None:
                    _job["done"] += 1
            if ip in silent_set and opened:
                candidates[ip] = {
                    "ip": ip,
                    "mac": arp_map.get(ip, ""),
                    "hostname": "",
                    "latency_ms": None,
                    "answered_ping": False,
                    "open_ports": opened,
                    "is_self": False,
                    "is_gateway": ip in gateways,
                }

        port_pool = ThreadPoolExecutor(max_workers=48)
        _consume(
            port_pool,
            [
                port_pool.submit(
                    _probe_ports,
                    ip,
                    deep_ports if ip in silent_set else hint_ports,
                    0.3,
                )
                for ip in port_targets
            ],
            take_port,
        )

        names: dict[str, str] = {}
        if not _cancel.is_set():
            with ThreadPoolExecutor(max_workers=24) as pool:
                futures = {pool.submit(lookup_name, ip): ip for ip in candidates}
                for future in as_completed(futures):
                    ip = futures[future]
                    try:
                        names[ip] = future.result()
                    except Exception:
                        names[ip] = ""

        observations = []
        for ip, obs in candidates.items():
            obs["open_ports"] = opened_map.get(ip, obs.get("open_ports") or [])
            obs["hostname"] = names.get(ip, "")
            observations.append(decorate(obs))
        observations.sort(key=lambda item: ip_sort(item["ip"]))
        if _cancel.is_set():
            _finish_cancelled(observations)
            return
        _finish_done(observations)
    except Exception as exc:
        _set(state="error", error=str(exc) or "Analyse interrompue", finished_at=now(), phase="error")


def _remember_identities(observations: list[dict]) -> None:
    try:
        db.fill_observed_identity(observations)
    except Exception:
        log.exception("mise à jour des adresses MAC déjà connues")


def _finish_done(observations: list[dict]) -> None:
    payload = _payload("done", observations)
    _remember_identities(observations)
    db.save_scan_cache(payload)
    _set(state="done", phase="done", finished_at=payload["finished_at"], observations=observations, error="")


def _finish_cancelled(observations: list[dict]) -> None:
    payload = _payload("cancelled", observations)
    if observations:
        _remember_identities(observations)
        db.save_scan_cache(payload)
    _set(
        state="cancelled",
        phase="cancelled",
        finished_at=payload["finished_at"],
        observations=observations,
        error="",
    )


def _payload(state: str, observations: list[dict]) -> dict:
    with _lock:
        base = dict(_job or {})
    return {
        "state": state,
        "subnet": base.get("subnet", ""),
        "deep": base.get("deep", False),
        "started_at": base.get("started_at"),
        "finished_at": now(),
        "responding": len(observations),
        "observations": observations,
    }


def public_scan() -> dict:
    job = snapshot()
    if job and job["state"] == "running":
        return {
            "state": "running",
            "phase": job["phase"],
            "done": job["done"],
            "total": job["total"],
            "subnet": job["subnet"],
            "deep": job["deep"],
            "started_at": job["started_at"],
            "responding": job["responding"],
        }
    record = None
    if job and job["state"] in {"done", "cancelled", "error"}:
        record = job
    if record is None or (record.get("state") == "error" and not record.get("observations")):
        cached = db.load_scan_cache()
        if record and record.get("state") == "error":
            return {
                "state": "error",
                "error": record.get("error") or "Analyse interrompue",
                "subnet": record.get("subnet") or "",
            }
        record = cached
    if not record:
        return {"state": "idle"}
    observations = record.get("observations") or []
    grouped = classify(observations, db.list_devices())
    return {
        "state": record.get("state") or "done",
        "subnet": record.get("subnet") or "",
        "started_at": record.get("started_at"),
        "finished_at": record.get("finished_at"),
        "responding": record.get("responding", len(observations)),
        "error": record.get("error") or "",
        **grouped,
    }
