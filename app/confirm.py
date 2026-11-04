import time

WINDOW_S = 30.0
_pending: dict[tuple[int, int], float] = {}


def arm_tap(device_id: int, action_id: int) -> dict:
    _pending[(int(device_id), int(action_id))] = time.monotonic()
    return {"ok": False, "need": "tap", "detail": "Appuie encore pour confirmer."}


def take_tap(device_id: int, action_id: int) -> str | None:
    stamp = _pending.pop((int(device_id), int(action_id)), 0.0)
    if stamp <= 0 or time.monotonic() - stamp > WINDOW_S:
        return "Le second appui a expiré."
    return None
