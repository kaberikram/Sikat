"""VFX Operator: viewfinder post-processing stack control."""
from __future__ import annotations

from ..fx_vocab import normalize_vfx_key
from ..schema import CommandPacket, Intent, UpdateFxPacket


class VFXOperator:
    name = "VFXOperator"
    actions = ("update_fx",)

    def build(self, intent: Intent, scene: SceneState | None = None) -> list[CommandPacket]:
        if intent.action != "update_fx" or intent.section is None:
            return []
        patch: dict = {}
        if intent.fx_enabled is not None:
            patch["enabled"] = intent.fx_enabled
        for setting in intent.fx_set or []:
            key = normalize_vfx_key(intent.section, setting.key)
            if key is None:
                continue
            patch[key] = bool(setting.value) if key == "monochrome" else setting.value
        if not patch:
            return []
        return [UpdateFxPacket(payload={"section": intent.section, "patch": patch})]
