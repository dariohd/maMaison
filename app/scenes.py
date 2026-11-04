from app import commands, db


def run_scene(scene_id: int, source: str = "maison", value: str | None = None, otp: str = "") -> dict:
    scene = next((item for item in db.list_scenes() if item["id"] == scene_id), None)
    if scene is None:
        return {"ok": False, "detail": "Scène introuvable."}
    actions = []
    for step in scene["steps"]:
        device = db.get_device(step["device_id"])
        action = db.get_action(step["device_id"], step["action_id"])
        actions.append((device, action))
    confirms = [(action or {}).get("confirm") or "" for _device, action in actions]
    if source == "telephone" and any(item in {"totp", "tap"} for item in confirms):
        from app import distant

        try:
            distant.verify_action_totp(otp)
        except ValueError as exc:
            return {"ok": False, "detail": str(exc)}
    elif source != "horaire" and any(item == "totp" for item in confirms):
        from app import distant

        try:
            distant.verify_action_totp(otp)
        except ValueError as exc:
            return {"ok": False, "detail": str(exc)}
    results = []
    for device, action in actions:
        if not device or not action:
            results.append({"ok": False, "detail": "Bouton introuvable."})
            continue
        if action["kind"] == "stream":
            results.append({"ok": False, "detail": "Une image ne se lance pas dans une scène."})
            continue
        confirm = action.get("confirm") or ""
        if source == "horaire" and confirm in {"totp", "tap"}:
            results.append({"ok": False, "detail": "Geste sensible, pas sur horaire."})
            continue
        payload = {**action, "value": value}
        result = commands.run_http(device, payload)
        db.log_command(device["id"], action["id"], action["label"], result, source)
        results.append(result)
    ok = all(item.get("ok") for item in results) if results else False
    return {"ok": ok, "detail": "C'est fait." if ok else "Une étape n'a pas marché.", "steps": len(results)}
