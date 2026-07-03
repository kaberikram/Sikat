"""VFX Operator: viewfinder post-processing stack control."""
from __future__ import annotations

from ..schema import CommandPacket, Intent, UpdateFxPacket

# spoken/LLM key aliases -> canonical patch keys, per section
_KEY_ALIASES: dict[str, dict[str, str]] = {
    "bloom": {
        "strength": "strength",
        "threshold": "threshold",
        "radius": "radius",
        "emissiveboost": "emissiveBoost",
        "emissiveintensity": "emissiveIntensity",
        "glow": "strength",
    },
    "pixelate": {
        "pixelsize": "pixelSize",
        "size": "pixelSize",
        "normaledge": "normalEdge",
        "depthedge": "depthEdge",
    },
    "cellShading": {"outlinescale": "outlineScale", "outline": "outlineScale", "scale": "outlineScale"},
    "glitch": {"intensity": "intensity", "rate": "rate", "amount": "intensity"},
    "dither": {
        "pixelsize": "pixelSize",
        "size": "pixelSize",
        "levels": "levels",
        "strength": "strength",
        "mix": "strength",
        "monochrome": "monochrome",
    },
}


class VFXOperator:
    name = "VFXOperator"
    actions = ("update_fx",)

    def build(self, intent: Intent) -> list[CommandPacket]:
        if intent.action != "update_fx" or intent.section is None:
            return []
        patch: dict = {}
        if intent.fx_enabled is not None:
            patch["enabled"] = intent.fx_enabled
        aliases = _KEY_ALIASES.get(intent.section, {})
        for setting in intent.fx_set or []:
            key = aliases.get(setting.key.lower().replace("_", "").replace(" ", ""))
            if key is None:
                continue
            patch[key] = bool(setting.value) if key == "monochrome" else setting.value
        if not patch:
            return []
        # dict payload is validated (and clamped) through the discriminated union
        return [UpdateFxPacket(payload={"section": intent.section, "patch": patch})]
