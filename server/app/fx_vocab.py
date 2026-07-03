"""Shared FX vocabulary for parser and VFX operator."""

FX_WORDS: dict[str, str] = {
    "bloom": "bloom",
    "glow effect": "bloom",
    "pixelate": "pixelate",
    "pixelation": "pixelate",
    "pixel effect": "pixelate",
    "glitch": "glitch",
    "dithering": "dither",
    "dither": "dither",
    "cell shading": "cellShading",
    "cel shading": "cellShading",
    "toon outline": "cellShading",
    "outline": "cellShading",
}

PRIMARY_FX_PARAM: dict[str, tuple[str, float, float]] = {
    "bloom": ("strength", 1.8, 0.4),
    "pixelate": ("pixelSize", 12, 4),
    "glitch": ("intensity", 0.3, 0.06),
    "dither": ("strength", 1.0, 0.3),
    "cellShading": ("outlineScale", 1.12, 1.02),
}

FX_PARAM_KEYS: dict[str, dict[str, str]] = {
    "bloom": {"strength": "strength", "threshold": "threshold", "radius": "radius"},
    "pixelate": {"size": "pixelSize", "pixel size": "pixelSize"},
    "glitch": {"intensity": "intensity", "rate": "rate"},
    "dither": {"size": "pixelSize", "levels": "levels", "strength": "strength", "mix": "strength"},
    "cellShading": {"outline": "outlineScale", "scale": "outlineScale"},
}

VFX_KEY_ALIASES: dict[str, dict[str, str]] = {
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


def normalize_vfx_key(section: str, spoken_key: str) -> str | None:
    aliases = VFX_KEY_ALIASES.get(section, {})
    return aliases.get(spoken_key.lower().replace("_", "").replace(" ", ""))
