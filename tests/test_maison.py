import os
import tempfile
from pathlib import Path

ROOT = Path(tempfile.mkdtemp())
os.environ["MAISON_DB"] = str(ROOT / "maison.db")
os.environ["MAISON_MONITOR"] = "0"
os.environ["MAISON_OPEN_BROWSER"] = "0"
os.environ["MAISON_DISTANT"] = "0"

import ipaddress

from fastapi.testclient import TestClient

from app import db, distant, probe, scanner
from app.main import app

IPCONFIG = """
Carte Ethernet VMware Network Adapter VMnet1 :

   Adresse IPv4. . . . . . . . . . . . . .: 192.168.227.1
   Masque de sous-réseau. . . . . . . . . : 255.255.255.0
   Passerelle par défaut. . . . . . . . . :

Carte réseau sans fil Wi-Fi :

   Adresse IPv4. . . . . . . . . . . . . .: 172.21.200.227
   Masque de sous-réseau. . . . . . . . . : 255.255.252.0
   Passerelle par défaut. . . . . . . . . : 172.21.200.1
"""

ARP = """
Interface : 192.168.1.20 --- 0xc
  Adresse Internet      Adresse physique      Type
  192.168.1.1           a4-91-b1-10-20-30     dynamique
  192.168.1.50          00-00-00-00-00-00     invalid
  192.168.1.255         ff-ff-ff-ff-ff-ff     statique
  224.0.0.22            01-00-5e-00-00-16     statique
  10.0.0.8              aa-bb-cc-dd-ee-ff     dynamique
"""


def test_parsers_and_rules():
    adapters = scanner.parse_ipconfig(IPCONFIG)
    assert len(adapters) == 2
    chosen = scanner.choose_adapter(adapters, "172.21.200.227")
    assert chosen["ip"] == "172.21.200.227"
    assert scanner.suggested_subnet(chosen) == "172.21.200.0/22"

    network = ipaddress.ip_network("192.168.1.0/24")
    arp = scanner.parse_arp(ARP, network)
    assert arp == {"192.168.1.1": "A4:91:B1:10:20:30"}

    assert str(scanner.parse_subnet("192.168.1.0/24")) == "192.168.1.0/24"
    assert str(scanner.parse_subnet("172.21.200.0/22")) == "172.21.200.0/22"
    for bad in ("8.8.8.8/32", "1.2.3.0/24", "10.0.0.0/16", "pas-un-reseau"):
        try:
            scanner.parse_subnet(bad)
        except ValueError:
            continue
        raise AssertionError(bad)

    devices = [
        {"id": 1, "name": "Volet salon", "ip": "192.168.1.40", "mac": "AA:BB:CC:DD:EE:01"},
        {"id": 2, "name": "Caméra", "ip": "192.168.1.30", "mac": "AA:BB:CC:DD:EE:02"},
    ]
    observations = [
        {"ip": "192.168.1.55", "mac": "AA:BB:CC:DD:EE:01", "hostname": "", "open_ports": []},
        {"ip": "192.168.1.30", "mac": "AA:BB:CC:DD:EE:02", "hostname": "", "open_ports": [554]},
        {"ip": "192.168.1.77", "mac": "AA:BB:CC:DD:EE:09", "hostname": "cam-garage", "open_ports": [80]},
        {"ip": "192.168.1.30", "mac": "AA:BB:CC:DD:EE:99", "hostname": "", "open_ports": []},
    ]
    grouped = scanner.classify(observations, devices)
    assert grouped["changed"][0]["device_name"] == "Volet salon"
    assert grouped["changed"][0]["previous_ip"] == "192.168.1.40"
    assert grouped["known"][0]["device_name"] == "Caméra"
    assert len(grouped["new"]) == 1
    assert grouped["conflicts"][0]["device_name"] == "Caméra"
    kind, protocol, port = scanner.suggest({"ip": "192.168.1.1", "is_gateway": True, "open_ports": [80], "hostname": ""})
    assert kind == "Routeur"
    assert protocol == "http"
    assert port == 80


def test_api_flow():
    db.init_db()
    with TestClient(app) as client:
        page = client.get("/")
        assert page.status_code == 200
        assert "Tableau de bord" in page.text
        script = client.get("/assets/app.js")
        assert script.status_code == 200
        assert "Enregistrer et tester" in script.text

        board = client.get("/api/dashboard")
        assert board.status_code == 200
        assert board.json()["counts"]["total"] == 0

        types = client.get("/api/types").json()
        rooms = client.get("/api/rooms").json()
        volet = next(item["id"] for item in types if item["name"] == "Volet")
        salon = next(item["id"] for item in rooms if item["name"] == "Salon")

        created = client.post("/api/devices", json={
            "name": "Volet salon",
            "type_id": volet,
            "room_id": salon,
            "ip": "192.168.1.40",
            "mac": "aa-bb-cc-dd-ee-10",
            "protocol": "ping",
        })
        assert created.status_code == 200, created.text
        device_id = created.json()["device"]["id"]
        assert created.json()["device"]["mac"] == "AA:BB:CC:DD:EE:10"
        assert created.json()["check"]["state"] in {"online", "offline", "degraded", "unknown"}

        conflict = client.post("/api/devices", json={
            "name": "Doublon",
            "type_id": volet,
            "ip": "192.168.1.40",
            "protocol": "ping",
        })
        assert conflict.status_code == 409

        public = client.post("/api/scan", json={"subnet": "8.8.8.8/32"})
        assert public.status_code == 400
        too_big = client.post("/api/scan", json={"subnet": "10.0.0.0/16"})
        assert too_big.status_code == 400

        moved = client.put(f"/api/devices/{device_id}", json={
            "name": "Volet salon",
            "type_id": volet,
            "room_id": salon,
            "ip": "192.168.1.41",
            "mac": "AA:BB:CC:DD:EE:10",
            "protocol": "http",
            "port": 80,
            "http_path": "/status",
        })
        assert moved.status_code == 200, moved.text
        assert moved.json()["device"]["ip"] == "192.168.1.41"
        history = client.get(f"/api/devices/{device_id}/history").json()
        assert history[0]["new_ip"] == "192.168.1.41"
        assert history[0]["old_ip"] == "192.168.1.40"
        assert any(item["source"] == "creation" for item in history)

        other = client.post("/api/devices", json={
            "name": "Radiateur",
            "type_id": volet,
            "ip": "192.168.1.50",
            "protocol": "ping",
        })
        assert other.status_code == 200, other.text
        forced = client.put(f"/api/devices/{other.json()['device']['id']}", json={
            "name": "Radiateur",
            "type_id": volet,
            "ip": "192.168.1.41",
            "protocol": "ping",
            "force": True,
        })
        assert forced.status_code == 200, forced.text
        assert forced.json()["device"]["ip_conflict"] is True

        refused = client.delete(f"/api/types/{volet}")
        assert refused.status_code == 409

        facts = client.get("/api/network").json()
        assert "adapters" in facts
        if facts.get("local_ip"):
            single = ipaddress.ip_network(f"{facts['local_ip']}/32", strict=False)
            if scanner.is_home_network(single):
                started = client.post("/api/scan", json={"subnet": str(single), "deep": False})
                assert started.status_code == 200, started.text
                import time
                seen = None
                for _ in range(40):
                    seen = client.get("/api/scan").json()
                    if seen["state"] != "running":
                        break
                    time.sleep(0.25)
                assert seen["state"] in {"done", "cancelled"}
                found = [item for bucket in ("new", "known", "changed", "conflicts") for item in seen.get(bucket, [])]
                assert any(item["ip"] == facts["local_ip"] for item in found)


def test_follow_mac_after_restart():
    db.init_db()
    type_id = next(item["id"] for item in db.list_types() if item["name"] == "Volet")
    device_id = db.insert_device(
        {
            "name": "Volet test suivi",
            "type_id": type_id,
            "room_id": None,
            "ip": "192.168.50.10",
            "mac": "AA:BB:CC:DD:EE:77",
            "hostname": "",
            "port": None,
            "protocol": "ping",
            "http_path": "/",
            "notes": "",
        }
    )
    try:
        moved = db.retarget_by_mac({"192.168.50.44": "AA:BB:CC:DD:EE:77"})
        assert moved[0]["old_ip"] == "192.168.50.10"
        assert moved[0]["new_ip"] == "192.168.50.44"
        assert db.get_device(device_id)["ip"] == "192.168.50.44"
        assert db.list_history(device_id)[0]["source"] == "suivi"
        assert db.retarget_by_mac({"192.168.50.44": "AA:BB:CC:DD:EE:77"}) == []
    finally:
        db.delete_device(device_id)


def test_commands_are_generic():
    from app import commands

    device = {"ip": "192.168.1.20", "protocol": "http", "port": None}
    action = commands.clean_action(
        {"label": "Monter", "kind": "http", "method": "get", "path": "up", "body": ""}
    )
    assert commands.target_url(device, action) == "http://192.168.1.20:80/up"
    stream = commands.clean_action(
        {"label": "Image", "kind": "stream", "method": "rtsp", "path": "/live", "auth_user": "a", "auth_pass": "b"}
    )
    assert commands.target_url(device, stream) == "rtsp://a:b@192.168.1.20:554/live"
    try:
        commands.clean_action({"label": "X", "kind": "http", "method": "GET", "path": "http://autre"})
    except commands.CommandError:
        pass
    else:
        raise AssertionError("chemin externe")

    db.init_db()
    type_id = next(item["id"] for item in db.list_types() if item["name"] == "Volet")
    with TestClient(app) as client:
        created = client.post("/api/devices", json={
            "name": "Volet commandes",
            "type_id": type_id,
            "ip": "192.168.50.20",
            "mac": "AA:BB:CC:DD:EE:88",
            "protocol": "ping",
        })
        assert created.status_code == 200, created.text
        device_id = created.json()["device"]["id"]
        try:
            preset = client.post(f"/api/devices/{device_id}/actions/preset", json={"preset": "volet"})
            assert preset.status_code == 200, preset.text
            labels = [item["label"] for item in preset.json()]
            assert labels == ["Monter", "Stop", "Descendre"]
            catalog = client.get("/api/presets").json()
            ids = [item["id"] for group in catalog for item in group["items"]]
            for key in ("volet", "store", "portail", "serrure", "ampoule", "prise", "radiateur", "climatisation", "camera", "sonnette", "television", "enceinte", "routeur", "capteur", "alarme", "arrosage"):
                assert key in ids
            assert "auth_pass" in preset.json()[0]
            public = client.get("/api/devices").json()
            listed = next(item for item in public if item["id"] == device_id)
            assert "auth_pass" not in listed["actions"][0]
            refused = client.post(f"/api/devices/{device_id}/actions", json={
                "label": "Dehors",
                "kind": "http",
                "method": "GET",
                "path": "https://example.com/",
            })
            assert refused.status_code == 400
        finally:
            client.delete(f"/api/devices/{device_id}")


def test_distant_allows_only_house_commands():
    assert distant.allowed("POST", "/api/check")
    assert distant.allowed("POST", "/api/devices/4/actions/9/run")
    assert not distant.allowed("POST", "/api/devices/4")
    assert not distant.allowed("GET", "/api/check")
    assert not distant.allowed("POST", "/api/devices/4/actions/9/run/../settings")
    blocked = distant.execute({"method": "DELETE", "path": "/api/devices/1"})
    assert blocked["ok"] is False


def test_distant_refuses_another_site():
    try:
        distant.public_url("https://example.com/pair")
    except ValueError as exc:
        assert "refus" in str(exc).lower()
    else:
        raise AssertionError("site externe")
    assert distant.public_url("https://mamaisonconnectee.vercel.app") == "https://mamaisonconnectee.vercel.app"


def test_each_house_has_its_own_link():
    try:
        distant.create_house("court")
    except ValueError as exc:
        assert "6" in str(exc)
    else:
        raise AssertionError("mot de passe trop court")
    assert distant.parse_config({
        "url": "https://mamaisonconnectee.vercel.app",
        "token": "secret",
    }) is None
    parsed = distant.parse_config({
        "url": "https://mamaisonconnectee.vercel.app",
        "token": "secret",
        "house": "ab12-cd34",
    })
    assert parsed["house"] == "AB12CD34"
    assert distant.format_house("AB12CD34") == "AB12-CD34"


def test_ping_localhost():
    ok, latency = probe.ping("127.0.0.1", 400)
    assert ok is True
    assert latency is not None
