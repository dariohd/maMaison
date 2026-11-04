import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from app.paths import home_root
from app.vault import lock, unlock

ROOT = home_root()

DEFAULTS = {
    "subnet": "",
    "subnets": "",
    "ping_timeout_ms": "400",
    "poll_interval_s": "30",
    "http_timeout_s": "2",
    "mqtt_host": "",
    "mqtt_port": "1883",
    "mqtt_user": "",
    "mqtt_pass": "",
    "mqtt_tls": "0",
    "autostart": "0",
    "lite_ui": "0",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
);

CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type_id INTEGER NOT NULL REFERENCES device_types(id),
    room_id INTEGER REFERENCES rooms(id),
    ip TEXT NOT NULL,
    mac TEXT,
    hostname TEXT,
    port INTEGER,
    protocol TEXT NOT NULL DEFAULT 'ping',
    http_path TEXT NOT NULL DEFAULT '/',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_mac
    ON devices(mac) WHERE mac IS NOT NULL AND mac != '';

CREATE TABLE IF NOT EXISTS device_status (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    latency_ms INTEGER,
    last_checked TEXT,
    last_seen TEXT,
    detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ip_history (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    old_ip TEXT,
    new_ip TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_actions (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    auth_user TEXT NOT NULL DEFAULT '',
    auth_pass TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
);
"""

EXTRA_TABLES = """
CREATE TABLE IF NOT EXISTS command_log (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    action_id INTEGER,
    label TEXT NOT NULL,
    ok INTEGER NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'maison',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scene_steps (
    id INTEGER PRIMARY KEY,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    action_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    hhmm TEXT NOT NULL,
    days TEXT NOT NULL DEFAULT '1234567',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY,
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_hostname
    ON devices(hostname) WHERE hostname IS NOT NULL AND hostname != '';
"""

DEVICE_COLUMNS = {
    "pinned": "INTEGER NOT NULL DEFAULT 0",
    "important": "INTEGER NOT NULL DEFAULT 0",
    "reading": "TEXT NOT NULL DEFAULT ''",
    "reading_kind": "TEXT NOT NULL DEFAULT ''",
    "reading_path": "TEXT NOT NULL DEFAULT ''",
    "cert_fp": "TEXT NOT NULL DEFAULT ''",
    "cert_seen": "TEXT NOT NULL DEFAULT ''",
    "parent_id": "INTEGER",
    "transport": "TEXT NOT NULL DEFAULT 'http'",
    "mqtt_topic": "TEXT NOT NULL DEFAULT ''",
}

ACTION_COLUMNS = {
    "confirm": "TEXT NOT NULL DEFAULT ''",
    "value_kind": "TEXT NOT NULL DEFAULT ''",
    "value_min": "REAL",
    "value_max": "REAL",
    "value_step": "REAL",
}

SEED_TYPES = [
    "Volet",
    "Store",
    "Portail",
    "Serrure",
    "Caméra",
    "Sonnette",
    "Ampoule",
    "Prise",
    "Interrupteur",
    "Radiateur",
    "Climatisation",
    "Chauffe-eau",
    "Ventilation",
    "Arrosage",
    "Télévision",
    "Enceinte",
    "Routeur",
    "Capteur",
    "Alarme",
    "Ordinateur",
    "Autre",
]

SEED_ROOMS = [
    "Salon",
    "Cuisine",
    "Chambre",
    "Bureau",
    "Salle de bain",
    "Entrée",
    "Extérieur",
    "Local technique",
]

DEVICE_SELECT = """
SELECT
    d.id, d.name, d.type_id, d.room_id, d.ip, d.mac, d.hostname,
    d.port, d.protocol, d.http_path, d.notes, d.created_at, d.updated_at,
    d.pinned, d.important, d.reading, d.reading_kind, d.reading_path,
    d.cert_fp, d.cert_seen, d.parent_id, d.transport, d.mqtt_topic,
    t.name AS type_name,
    r.name AS room_name,
    s.state AS state,
    s.latency_ms AS latency_ms,
    s.last_checked AS last_checked,
    s.last_seen AS last_seen,
    s.detail AS detail
FROM devices d
JOIN device_types t ON t.id = d.type_id
LEFT JOIN rooms r ON r.id = d.room_id
LEFT JOIN device_status s ON s.device_id = d.id
"""


def _add_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def db_path() -> Path:
    return Path(os.environ.get("MAISON_DB", ROOT / "data" / "maison.db"))


def close_files() -> None:
    path = db_path()
    if not path.exists():
        return
    conn = sqlite3.connect(path, timeout=10)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
    finally:
        conn.close()


def now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


@contextmanager
def session():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA)
        conn.executescript(EXTRA_TABLES)
        _add_columns(conn, "devices", DEVICE_COLUMNS)
        _add_columns(conn, "device_actions", ACTION_COLUMNS)
        for name in SEED_TYPES:
            conn.execute("INSERT OR IGNORE INTO device_types (name) VALUES (?)", (name,))
        rooms = conn.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]
        if rooms == 0:
            conn.executemany(
                "INSERT INTO rooms (name, sort_order) VALUES (?, ?)",
                [(name, index) for index, name in enumerate(SEED_ROOMS)],
            )
        for key, value in DEFAULTS.items():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
                (key, value),
            )
        conn.commit()
    finally:
        conn.close()


def _device_from_row(row: sqlite3.Row, conflicts: set[str]) -> dict:
    item = dict(row)
    item["state"] = item["state"] or "unknown"
    item["ip_conflict"] = item["ip"] in conflicts
    item["mac"] = item["mac"] or ""
    item["hostname"] = item["hostname"] or ""
    item["notes"] = item["notes"] or ""
    item["room_name"] = item["room_name"] or ""
    item["pinned"] = int(item.get("pinned") or 0)
    item["important"] = int(item.get("important") or 0)
    item["reading"] = item.get("reading") or ""
    item["reading_kind"] = item.get("reading_kind") or ""
    item["reading_path"] = item.get("reading_path") or ""
    item["cert_fp"] = item.get("cert_fp") or ""
    item["cert_seen"] = item.get("cert_seen") or ""
    item["parent_id"] = item.get("parent_id")
    item["transport"] = item.get("transport") or "http"
    item["mqtt_topic"] = item.get("mqtt_topic") or ""
    return item


def list_devices() -> list[dict]:
    with session() as conn:
        rows = conn.execute(DEVICE_SELECT + " ORDER BY d.name COLLATE NOCASE").fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["ip"]] = counts.get(row["ip"], 0) + 1
    conflicts = {ip for ip, count in counts.items() if count > 1}
    devices = [_device_from_row(row, conflicts) for row in rows]
    _attach_actions(devices, secrets=False)
    return devices


def get_device(device_id: int) -> dict | None:
    with session() as conn:
        row = conn.execute(DEVICE_SELECT + " WHERE d.id = ?", (device_id,)).fetchone()
    if row is None:
        return None
    conflicts = {
        item["ip"]
        for item in list_devices()
        if item["ip_conflict"]
    }
    device = _device_from_row(row, conflicts)
    _attach_actions([device], secrets=True)
    return device


def _action_dict(row: sqlite3.Row, secrets: bool) -> dict:
    item = {
        "id": row["id"],
        "label": row["label"],
        "kind": row["kind"],
        "method": row["method"],
        "path": row["path"],
        "body": row["body"] or "",
        "sort_order": row["sort_order"],
        "confirm": row["confirm"] if "confirm" in row.keys() else "",
        "value_kind": row["value_kind"] if "value_kind" in row.keys() else "",
        "value_min": row["value_min"] if "value_min" in row.keys() else None,
        "value_max": row["value_max"] if "value_max" in row.keys() else None,
        "value_step": row["value_step"] if "value_step" in row.keys() else None,
    }
    if secrets:
        item["auth_user"] = row["auth_user"] or ""
        item["auth_pass"] = unlock(row["auth_pass"] or "")
    return item


def _attach_actions(devices: list[dict], secrets: bool) -> None:
    if not devices:
        return
    with session() as conn:
        rows = conn.execute(
            "SELECT * FROM device_actions ORDER BY sort_order, id"
        ).fetchall()
    grouped: dict[int, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["device_id"], []).append(_action_dict(row, secrets))
    for device in devices:
        device["actions"] = grouped.get(device["id"], [])


def list_actions(device_id: int, secrets: bool = False) -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            """
            SELECT * FROM device_actions
            WHERE device_id = ?
            ORDER BY sort_order, id
            """,
            (device_id,),
        ).fetchall()
    return [_action_dict(row, secrets) for row in rows]


def get_action(device_id: int, action_id: int) -> dict | None:
    with session() as conn:
        row = conn.execute(
            "SELECT * FROM device_actions WHERE device_id = ? AND id = ?",
            (device_id, action_id),
        ).fetchone()
    return _action_dict(row, True) if row else None


def insert_action(device_id: int, fields: dict) -> dict:
    with session() as conn:
        order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM device_actions WHERE device_id = ?",
            (device_id,),
        ).fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO device_actions (
                device_id, label, kind, method, path, body, auth_user, auth_pass, sort_order,
                confirm, value_kind, value_min, value_max, value_step
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                device_id,
                fields["label"],
                fields["kind"],
                fields["method"],
                fields["path"],
                fields.get("body") or "",
                fields.get("auth_user") or "",
                lock(fields.get("auth_pass") or ""),
                order,
                fields.get("confirm") or "",
                fields.get("value_kind") or "",
                fields.get("value_min"),
                fields.get("value_max"),
                fields.get("value_step"),
            ),
        )
        action_id = int(cur.lastrowid)
    found = get_action(device_id, action_id)
    if found is None:
        raise KeyError(action_id)
    return found


def update_action(device_id: int, action_id: int, fields: dict) -> dict | None:
    with session() as conn:
        cur = conn.execute(
            """
            UPDATE device_actions SET
                label = ?, kind = ?, method = ?, path = ?, body = ?,
                auth_user = ?, auth_pass = ?,
                confirm = ?, value_kind = ?, value_min = ?, value_max = ?, value_step = ?
            WHERE device_id = ? AND id = ?
            """,
            (
                fields["label"],
                fields["kind"],
                fields["method"],
                fields["path"],
                fields.get("body") or "",
                fields.get("auth_user") or "",
                lock(fields.get("auth_pass") or ""),
                fields.get("confirm") or "",
                fields.get("value_kind") or "",
                fields.get("value_min"),
                fields.get("value_max"),
                fields.get("value_step"),
                device_id,
                action_id,
            ),
        )
        if cur.rowcount == 0:
            return None
    return get_action(device_id, action_id)


def delete_action(device_id: int, action_id: int) -> bool:
    with session() as conn:
        cur = conn.execute(
            "DELETE FROM device_actions WHERE device_id = ? AND id = ?",
            (device_id, action_id),
        )
        return cur.rowcount > 0


def list_types() -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            "SELECT id, name FROM device_types ORDER BY name COLLATE NOCASE"
        ).fetchall()
    return [dict(row) for row in rows]


def list_rooms() -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            "SELECT id, name, sort_order FROM rooms ORDER BY sort_order, name COLLATE NOCASE"
        ).fetchall()
    return [dict(row) for row in rows]


def get_settings() -> dict:
    with session() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    data = dict(DEFAULTS)
    data.update({row["key"]: row["value"] for row in rows})
    if data.get("mqtt_pass"):
        data["mqtt_pass"] = unlock(data["mqtt_pass"])
    return data


def get_int_setting(key: str, default: int) -> int:
    raw = get_settings().get(key, str(default))
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def set_settings(updates: dict) -> dict:
    allowed = set(DEFAULTS)
    with session() as conn:
        for key, value in updates.items():
            if key not in allowed:
                continue
            stored = lock(str(value)) if key == "mqtt_pass" and value else str(value)
            conn.execute(
                """
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, stored),
            )
    return get_settings()


def _history(conn: sqlite3.Connection, device_id: int, old_ip: str | None, new_ip: str, source: str) -> None:
    if old_ip == new_ip:
        return
    conn.execute(
        """
        INSERT INTO ip_history (device_id, old_ip, new_ip, changed_at, source)
        VALUES (?, ?, ?, ?, ?)
        """,
        (device_id, old_ip, new_ip, now(), source),
    )


def find_ip_owner(ip: str, ignore_id: int | None = None) -> dict | None:
    with session() as conn:
        if ignore_id is None:
            row = conn.execute(
                "SELECT id, name, ip FROM devices WHERE ip = ?",
                (ip,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id, name, ip FROM devices WHERE ip = ? AND id != ?",
                (ip, ignore_id),
            ).fetchone()
    return dict(row) if row else None


def find_mac_owner(mac: str, ignore_id: int | None = None) -> dict | None:
    if not mac:
        return None
    with session() as conn:
        if ignore_id is None:
            row = conn.execute(
                "SELECT id, name, ip, mac FROM devices WHERE mac = ?",
                (mac,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id, name, ip, mac FROM devices WHERE mac = ? AND id != ?",
                (mac, ignore_id),
            ).fetchone()
    return dict(row) if row else None


def insert_device(fields: dict, source: str = "creation") -> int:
    stamp = now()
    with session() as conn:
        cur = conn.execute(
            """
            INSERT INTO devices (
                name, type_id, room_id, ip, mac, hostname, port, protocol,
                http_path, notes, created_at, updated_at,
                pinned, important, reading_kind, reading_path, parent_id, transport, mqtt_topic
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fields["name"],
                fields["type_id"],
                fields["room_id"],
                fields["ip"],
                fields["mac"],
                fields.get("hostname") or "",
                fields["port"],
                fields["protocol"],
                fields["http_path"],
                fields["notes"],
                stamp,
                stamp,
                int(fields.get("pinned") or 0),
                int(fields.get("important") or 0),
                fields.get("reading_kind") or "",
                fields.get("reading_path") or "",
                fields.get("parent_id"),
                fields.get("transport") or "http",
                fields.get("mqtt_topic") or "",
            ),
        )
        device_id = int(cur.lastrowid)
        _history(conn, device_id, None, fields["ip"], source)
    return device_id


def retarget_by_mac(arp: dict[str, str]) -> list[dict]:
    """L'adresse suit la carte réseau. Un redémarrage qui change l'IP met la fiche à jour."""
    mac_to_ip: dict[str, str] = {}
    for ip, mac in arp.items():
        if mac:
            mac_to_ip[mac.upper()] = ip
    if not mac_to_ip:
        return []
    moved: list[dict] = []
    with session() as conn:
        rows = conn.execute("SELECT id, name, ip, mac FROM devices").fetchall()
        for row in rows:
            mac = (row["mac"] or "").upper()
            new_ip = mac_to_ip.get(mac)
            if not new_ip or new_ip == row["ip"]:
                continue
            owner = conn.execute(
                "SELECT id FROM devices WHERE ip = ? AND id != ?",
                (new_ip, row["id"]),
            ).fetchone()
            if owner:
                continue
            conn.execute(
                "UPDATE devices SET ip = ?, updated_at = ? WHERE id = ?",
                (new_ip, now(), row["id"]),
            )
            _history(conn, row["id"], row["ip"], new_ip, "suivi")
            moved.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "old_ip": row["ip"],
                    "new_ip": new_ip,
                }
            )
    return moved


def update_device(device_id: int, fields: dict, source: str = "manuel") -> None:
    with session() as conn:
        current = conn.execute("SELECT ip FROM devices WHERE id = ?", (device_id,)).fetchone()
        if current is None:
            raise KeyError(device_id)
        conn.execute(
            """
            UPDATE devices SET
                name = ?, type_id = ?, room_id = ?, ip = ?, mac = ?, hostname = ?,
                port = ?, protocol = ?, http_path = ?, notes = ?, updated_at = ?,
                pinned = ?, important = ?, reading_kind = ?, reading_path = ?,
                parent_id = ?, transport = ?, mqtt_topic = ?
            WHERE id = ?
            """,
            (
                fields["name"],
                fields["type_id"],
                fields["room_id"],
                fields["ip"],
                fields["mac"],
                fields.get("hostname") or "",
                fields["port"],
                fields["protocol"],
                fields["http_path"],
                fields["notes"],
                now(),
                int(fields.get("pinned") or 0),
                int(fields.get("important") or 0),
                fields.get("reading_kind") or "",
                fields.get("reading_path") or "",
                fields.get("parent_id"),
                fields.get("transport") or "http",
                fields.get("mqtt_topic") or "",
                device_id,
            ),
        )
        _history(conn, device_id, current["ip"], fields["ip"], source)


def delete_device(device_id: int) -> bool:
    with session() as conn:
        cur = conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        return cur.rowcount > 0


def list_history(device_id: int) -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            """
            SELECT old_ip, new_ip, changed_at, source
            FROM ip_history
            WHERE device_id = ?
            ORDER BY id DESC
            LIMIT 30
            """,
            (device_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def save_status(device_id: int, result: dict) -> None:
    with session() as conn:
        prev = conn.execute(
            "SELECT last_seen FROM device_status WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        last_seen = prev["last_seen"] if prev else None
        checked = result.get("last_checked") or now()
        if result["state"] in {"online", "degraded"}:
            last_seen = checked
        conn.execute(
            """
            INSERT INTO device_status (device_id, state, latency_ms, last_checked, last_seen, detail)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                state = excluded.state,
                latency_ms = excluded.latency_ms,
                last_checked = excluded.last_checked,
                last_seen = excluded.last_seen,
                detail = excluded.detail
            """,
            (
                device_id,
                result["state"],
                result.get("latency_ms"),
                checked,
                last_seen,
                result.get("detail") or "",
            ),
        )


def add_type(name: str) -> int:
    with session() as conn:
        cur = conn.execute("INSERT INTO device_types (name) VALUES (?)", (name,))
        return int(cur.lastrowid)


def rename_type(type_id: int, name: str) -> bool:
    with session() as conn:
        cur = conn.execute(
            "UPDATE device_types SET name = ? WHERE id = ?",
            (name, type_id),
        )
        return cur.rowcount > 0


def delete_type(type_id: int) -> str | None:
    with session() as conn:
        total = conn.execute("SELECT COUNT(*) FROM device_types").fetchone()[0]
        if total <= 1:
            return "Conservez au moins un type d'appareil."
        used = conn.execute(
            "SELECT COUNT(*) FROM devices WHERE type_id = ?",
            (type_id,),
        ).fetchone()[0]
        if used:
            return "Ce type est encore utilisé par des appareils."
        cur = conn.execute("DELETE FROM device_types WHERE id = ?", (type_id,))
        if cur.rowcount == 0:
            return "Type introuvable."
    return None


def add_room(name: str) -> int:
    with session() as conn:
        order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM rooms").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO rooms (name, sort_order) VALUES (?, ?)",
            (name, order),
        )
        return int(cur.lastrowid)


def rename_room(room_id: int, name: str) -> bool:
    with session() as conn:
        cur = conn.execute("UPDATE rooms SET name = ? WHERE id = ?", (name, room_id))
        return cur.rowcount > 0


def delete_room(room_id: int) -> bool:
    with session() as conn:
        conn.execute("UPDATE devices SET room_id = NULL WHERE room_id = ?", (room_id,))
        cur = conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
        return cur.rowcount > 0


def type_exists(type_id: int) -> bool:
    with session() as conn:
        row = conn.execute("SELECT 1 FROM device_types WHERE id = ?", (type_id,)).fetchone()
    return row is not None


def room_exists(room_id: int) -> bool:
    with session() as conn:
        row = conn.execute("SELECT 1 FROM rooms WHERE id = ?", (room_id,)).fetchone()
    return row is not None


def save_scan_cache(payload: dict) -> None:
    with session() as conn:
        conn.execute(
            """
            INSERT INTO scan_cache (id, payload, updated_at) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
            """,
            (json.dumps(payload, ensure_ascii=False), now()),
        )


def load_scan_cache() -> dict | None:
    with session() as conn:
        row = conn.execute("SELECT payload, updated_at FROM scan_cache WHERE id = 1").fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(row["payload"])
    except json.JSONDecodeError:
        return None
    payload["cached_at"] = row["updated_at"]
    return payload


def fill_observed_identity(observations: list[dict]) -> None:
    """Complète la MAC ou le nom réseau quand l'adresse correspond déjà à une fiche."""
    with session() as conn:
        rows = conn.execute("SELECT id, ip, mac, hostname FROM devices").fetchall()
        by_ip = {row["ip"]: row for row in rows}
        for obs in observations:
            current = by_ip.get(obs.get("ip"))
            if current is None:
                continue
            mac = obs.get("mac") or ""
            hostname = obs.get("hostname") or ""
            if mac and not current["mac"]:
                owner = conn.execute(
                    "SELECT id FROM devices WHERE mac = ? AND id != ?",
                    (mac, current["id"]),
                ).fetchone()
                if owner is None:
                    conn.execute(
                        "UPDATE devices SET mac = ? WHERE id = ?",
                        (mac, current["id"]),
                    )
            if hostname and hostname != (current["hostname"] or ""):
                conn.execute(
                    "UPDATE devices SET hostname = ? WHERE id = ?",
                    (hostname, current["id"]),
                )


class Conflict(Exception):
    pass


class Missing(Exception):
    pass


def apply_batch(creates: list[dict], updates: list[dict], force: bool = False) -> dict:
    created_ids: list[int] = []
    updated_ids: list[int] = []
    with session() as conn:
        for item in updates:
            current = conn.execute(
                "SELECT id, ip, mac, hostname FROM devices WHERE id = ?",
                (item["device_id"],),
            ).fetchone()
            if current is None:
                raise Missing("Un appareil sélectionné n'existe plus.")
            owner = conn.execute(
                "SELECT name FROM devices WHERE ip = ? AND id != ?",
                (item["ip"], item["device_id"]),
            ).fetchone()
            if owner and not force:
                raise Conflict(f"{item['ip']} est déjà notée pour {owner['name']}.")
            mac = item.get("mac") or current["mac"]
            if mac:
                mac_owner = conn.execute(
                    "SELECT name FROM devices WHERE mac = ? AND id != ?",
                    (mac, item["device_id"]),
                ).fetchone()
                if mac_owner:
                    raise Conflict(f"L'adresse MAC {mac} est déjà notée pour {mac_owner['name']}.")
            hostname = item.get("hostname") or current["hostname"] or ""
            conn.execute(
                """
                UPDATE devices
                SET ip = ?, mac = ?, hostname = ?, updated_at = ?
                WHERE id = ?
                """,
                (item["ip"], mac, hostname, now(), item["device_id"]),
            )
            _history(conn, item["device_id"], current["ip"], item["ip"], "detection")
            updated_ids.append(item["device_id"])

        for item in creates:
            mac = item.get("mac")
            if mac:
                mac_owner = conn.execute(
                    "SELECT name FROM devices WHERE mac = ?",
                    (mac,),
                ).fetchone()
                if mac_owner:
                    raise Conflict(f"L'adresse MAC {mac} est déjà notée pour {mac_owner['name']}.")
            if not force:
                owner = conn.execute(
                    "SELECT name FROM devices WHERE ip = ?",
                    (item["ip"],),
                ).fetchone()
                if owner:
                    raise Conflict(f"{item['ip']} est déjà notée pour {owner['name']}.")
            stamp = now()
            cur = conn.execute(
                """
                INSERT INTO devices (
                    name, type_id, room_id, ip, mac, hostname, port, protocol,
                    http_path, notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["name"],
                    item["type_id"],
                    item["room_id"],
                    item["ip"],
                    mac,
                    item.get("hostname") or "",
                    item["port"],
                    item["protocol"],
                    item["http_path"],
                    item.get("notes") or "",
                    stamp,
                    stamp,
                ),
            )
            device_id = int(cur.lastrowid)
            _history(conn, device_id, None, item["ip"], "creation")
            created_ids.append(device_id)
    return {"created": created_ids, "updated": updated_ids}


def dashboard() -> dict:
    devices = list_devices()
    counts = {"total": len(devices), "online": 0, "offline": 0, "degraded": 0, "unknown": 0}
    by_type: dict[str, dict] = {}
    by_room: dict[str, dict] = {}
    for device in devices:
        state = device["state"] if device["state"] in counts else "unknown"
        counts[state] += 1
        type_bucket = by_type.setdefault(
            device["type_name"],
            {"name": device["type_name"], "total": 0, "online": 0},
        )
        type_bucket["total"] += 1
        if state == "online":
            type_bucket["online"] += 1
        room_name = device["room_name"] or "Non classé"
        room_bucket = by_room.setdefault(
            room_name,
            {"name": room_name, "total": 0, "online": 0},
        )
        room_bucket["total"] += 1
        if state == "online":
            room_bucket["online"] += 1
    rank = {"offline": 0, "degraded": 1, "unknown": 2, "online": 3}
    ordered = sorted(
        devices,
        key=lambda item: (0 if item.get("pinned") else 1, rank.get(item["state"], 9), item["name"].lower()),
    )
    attention = [item for item in ordered if item["state"] in {"offline", "degraded"}]
    cache = load_scan_cache()
    return {
        "counts": counts,
        "by_type": sorted(by_type.values(), key=lambda item: (-item["total"], item["name"].lower())),
        "by_room": sorted(by_room.values(), key=lambda item: (-item["total"], item["name"].lower())),
        "devices": ordered,
        "attention": attention,
        "alerts": list_alerts(unread=True),
        "schedules": list_schedules(),
        "last_scan": cache.get("finished_at") if cache else None,
    }


def retarget_by_hostname(hosts: dict[str, str]) -> list[dict]:
    if not hosts:
        return []
    moved = []
    with session() as conn:
        rows = conn.execute("SELECT id, name, ip, mac, hostname FROM devices").fetchall()
        for row in rows:
            if row["mac"]:
                continue
            host = (row["hostname"] or "").lower()
            if not host:
                continue
            new_ip = hosts.get(host)
            if not new_ip or new_ip == row["ip"]:
                continue
            owner = conn.execute(
                "SELECT id FROM devices WHERE ip = ? AND id != ?",
                (new_ip, row["id"]),
            ).fetchone()
            if owner:
                continue
            conn.execute(
                "UPDATE devices SET ip = ?, updated_at = ? WHERE id = ?",
                (new_ip, now(), row["id"]),
            )
            _history(conn, row["id"], row["ip"], new_ip, "suivi")
            moved.append({"id": row["id"], "name": row["name"], "old_ip": row["ip"], "new_ip": new_ip})
    return moved


def save_reading(device_id: int, value: str) -> None:
    with session() as conn:
        conn.execute(
            "UPDATE devices SET reading = ?, updated_at = ? WHERE id = ?",
            (value[:80], now(), device_id),
        )


def note_cert(device_id: int, fingerprint: str) -> tuple[str, bool]:
    if not fingerprint:
        return "", False
    with session() as conn:
        row = conn.execute(
            "SELECT cert_fp, cert_seen FROM devices WHERE id = ?",
            (device_id,),
        ).fetchone()
        trusted = (row["cert_fp"] if row else "") or ""
        seen = (row["cert_seen"] if row else "") or ""
        if not trusted:
            changed = fingerprint != seen
        else:
            changed = fingerprint != trusted and fingerprint != seen
        conn.execute(
            "UPDATE devices SET cert_seen = ? WHERE id = ?",
            (fingerprint, device_id),
        )
        return trusted, changed


def trust_cert(device_id: int, fingerprint: str) -> None:
    with session() as conn:
        conn.execute(
            "UPDATE devices SET cert_fp = ?, cert_seen = ? WHERE id = ?",
            (fingerprint, fingerprint, device_id),
        )


def save_cert(device_id: int, fingerprint: str) -> str:
    trusted, _changed = note_cert(device_id, fingerprint)
    return trusted


def list_recent_histories(limit: int = 5) -> dict[int, list[dict]]:
    with session() as conn:
        rows = conn.execute(
            """
            SELECT device_id, old_ip, new_ip, changed_at, source
            FROM ip_history
            ORDER BY id DESC
            LIMIT 400
            """
        ).fetchall()
    grouped: dict[int, list[dict]] = {}
    for row in rows:
        bucket = grouped.setdefault(int(row["device_id"]), [])
        if len(bucket) < limit:
            bucket.append(dict(row))
    return grouped


def log_command(device_id: int, action_id: int | None, label: str, result: dict, source: str = "maison") -> None:
    with session() as conn:
        conn.execute(
            """
            INSERT INTO command_log (device_id, action_id, label, ok, detail, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                device_id,
                action_id,
                label[:40],
                1 if result.get("ok") else 0,
                str(result.get("detail") or "")[:180],
                source,
                now(),
            ),
        )
        conn.execute(
            "DELETE FROM command_log WHERE id NOT IN (SELECT id FROM command_log ORDER BY id DESC LIMIT 400)"
        )


def list_command_log(device_id: int) -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            """
            SELECT label, ok, detail, source, created_at
            FROM command_log WHERE device_id = ?
            ORDER BY id DESC LIMIT 30
            """,
            (device_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_scenes() -> list[dict]:
    with session() as conn:
        scenes = [dict(row) for row in conn.execute("SELECT id, name, sort_order FROM scenes ORDER BY sort_order, id")]
        steps = conn.execute(
            """
            SELECT s.id, s.scene_id, s.device_id, s.action_id, s.sort_order, d.name AS device_name, a.label AS action_label, a.confirm AS confirm
            FROM scene_steps s
            JOIN devices d ON d.id = s.device_id
            LEFT JOIN device_actions a ON a.id = s.action_id
            ORDER BY s.sort_order, s.id
            """
        ).fetchall()
    grouped: dict[int, list] = {}
    for row in steps:
        grouped.setdefault(row["scene_id"], []).append(dict(row))
    for scene in scenes:
        scene["steps"] = grouped.get(scene["id"], [])
    return scenes


def insert_scene(name: str, steps: list[dict]) -> dict:
    with session() as conn:
        order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM scenes").fetchone()[0]
        cur = conn.execute("INSERT INTO scenes (name, sort_order) VALUES (?, ?)", (name, order))
        scene_id = int(cur.lastrowid)
        for index, step in enumerate(steps):
            conn.execute(
                "INSERT INTO scene_steps (scene_id, device_id, action_id, sort_order) VALUES (?, ?, ?, ?)",
                (scene_id, int(step["device_id"]), int(step["action_id"]), index),
            )
    return next(item for item in list_scenes() if item["id"] == scene_id)


def delete_scene(scene_id: int) -> bool:
    with session() as conn:
        conn.execute("DELETE FROM scene_steps WHERE scene_id = ?", (scene_id,))
        conn.execute("DELETE FROM schedules WHERE scene_id = ?", (scene_id,))
        cur = conn.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
        return cur.rowcount > 0


def list_schedules() -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            """
            SELECT h.id, h.scene_id, h.hhmm, h.days, h.enabled, h.last_run, s.name AS scene_name
            FROM schedules h JOIN scenes s ON s.id = h.scene_id
            ORDER BY h.hhmm, h.id
            """
        ).fetchall()
    return [dict(row) for row in rows]


def insert_schedule(scene_id: int, hhmm: str, days: str) -> dict:
    with session() as conn:
        cur = conn.execute(
            "INSERT INTO schedules (scene_id, hhmm, days, enabled) VALUES (?, ?, ?, 1)",
            (scene_id, hhmm, days),
        )
        schedule_id = int(cur.lastrowid)
    return next(item for item in list_schedules() if item["id"] == schedule_id)


def set_schedule(schedule_id: int, enabled: bool) -> None:
    with session() as conn:
        conn.execute("UPDATE schedules SET enabled = ? WHERE id = ?", (1 if enabled else 0, schedule_id))


def mark_schedule_run(schedule_id: int, stamp: str) -> None:
    with session() as conn:
        conn.execute("UPDATE schedules SET last_run = ? WHERE id = ?", (stamp, schedule_id))


def delete_schedule(schedule_id: int) -> bool:
    with session() as conn:
        cur = conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
        return cur.rowcount > 0


def add_alert(device_id: int | None, message: str) -> None:
    with session() as conn:
        conn.execute(
            "INSERT INTO alerts (device_id, message, created_at) VALUES (?, ?, ?)",
            (device_id, message[:180], now()),
        )


def list_alerts(unread: bool = False) -> list[dict]:
    with session() as conn:
        sql = "SELECT id, device_id, message, created_at, read_at FROM alerts"
        if unread:
            sql += " WHERE read_at IS NULL"
        sql += " ORDER BY id DESC LIMIT 20"
        rows = conn.execute(sql).fetchall()
    return [dict(row) for row in rows]


def read_alerts() -> None:
    with session() as conn:
        conn.execute("UPDATE alerts SET read_at = ? WHERE read_at IS NULL", (now(),))


def due_schedules(stamp: str, weekday: str) -> list[dict]:
    hhmm = stamp[11:16]
    due = []
    for item in list_schedules():
        if not item["enabled"]:
            continue
        if item["hhmm"] != hhmm:
            continue
        if weekday not in (item["days"] or "1234567"):
            continue
        if item["last_run"] == stamp[:16]:
            continue
        due.append(item)
    return due

