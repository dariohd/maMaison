import ssl

from app import db


def publish_mqtt(device: dict, action: dict, value: str | None = None) -> dict:
    settings = db.get_settings()
    host = (settings.get("mqtt_host") or "").strip()
    if not host:
        return {"ok": False, "detail": "Indique l'adresse MQTT dans les réglages."}
    try:
        import paho.mqtt.publish as publish
    except Exception:
        return {"ok": False, "detail": "MQTT n'est pas installé sur cet ordinateur."}
    try:
        port = int(settings.get("mqtt_port") or 1883)
    except ValueError:
        port = 1883
    topic = (action.get("path") or device.get("mqtt_topic") or "").lstrip("/")
    if not topic or any(char in topic for char in "#+\r\n"):
        return {"ok": False, "detail": "Indique le sujet MQTT."}
    try:
        from app.commands import CommandError, clean_mqtt_value

        payload = clean_mqtt_value(value) if value is not None and value != "" else clean_mqtt_value(action.get("body") or "ON")
    except CommandError as exc:
        return {"ok": False, "detail": str(exc)}
    auth = None
    user = (settings.get("mqtt_user") or "").strip()
    password = settings.get("mqtt_pass") or ""
    if user:
        auth = {"username": user, "password": password}
    tls = {"tls_version": ssl.PROTOCOL_TLS_CLIENT} if settings.get("mqtt_tls") in {"1", "true", "True"} else None
    try:
        publish.single(
            topic,
            payload,
            hostname=host,
            port=port,
            keepalive=8,
            auth=auth,
            tls=tls,
        )
    except Exception:
        return {"ok": False, "detail": "Le courtier MQTT n'a pas répondu."}
    return {"ok": True, "detail": "C'est envoyé."}
