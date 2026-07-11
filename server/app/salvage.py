"""Repair malformed streamed JSON into valid Intents.

Handles common LLM JSON errors in streaming plan/intent extraction:
- Keyframe values that are not exactly 3 floats (pad/truncate to 3).
- Less than 2 valid keyframes removed entirely.
- Unknown fields stripped by model_validate.
"""
from __future__ import annotations

import json
import logging

from .schema import Intent

log = logging.getLogger("director.salvage")


def salvage_step(raw: str) -> Intent | None:
    """Try to repair a malformed streamed step into a valid Intent."""
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    tks = obj.get("track_keyframes")
    if isinstance(tks, list):
        repaired = []
        for kf in tks:
            if not isinstance(kf, dict):
                continue
            val = kf.get("value")
            if isinstance(val, list):
                try:
                    floats = [float(x) for x in val[:3]]
                except (TypeError, ValueError):
                    continue
                while len(floats) < 3:
                    floats.append(0.0)
                kf["value"] = floats[:3]
                repaired.append(kf)
        if len(repaired) >= 2:
            obj["track_keyframes"] = repaired
        else:
            obj.pop("track_keyframes", None)
    return Intent.model_validate(obj)
