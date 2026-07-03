# Lighting Tech

**Code:** `server/app/agents/lighting_tech.py` · **Kind:** deterministic specialist

## Role

The set's gaffer: scene lighting (ambient + key directional + background) and
object materials (color, emissive glow, opacity).

## Owned commands

- `UPDATE_LIGHTS` — patches the store's `lighting` slice; `Scene.tsx` applies it
  every frame. Defaults match the editor's original hard-coded rig
  (ambient `#ffffff`/0.8, key `#ffffff`/1.5 at `[5,10,7]`, background `#f2f2f2`),
  so `studio` mood is a true reset.
- `SET_MATERIAL` — via the store's `setObjectMaterial`: traverses the target's
  meshes (skipping cell-outline shells), sets color/emissive/emissiveIntensity/opacity,
  and records the patch on `MotionObject.materialOverride` so exports stay truthful.

## Vocabulary it answers to (fallback grammar)

"dim/brighten the lights", "lights off", "warm/cool light", "make the background
<color>", "paint the sphere gold", "make the box glow red", "intensity to 2".

## Clamps

ambient intensity 0–4 · key intensity 0–8 · emissiveIntensity 0–5 · opacity 0–1
(enforced in `schema.py`, clamped not rejected).

## Failure modes

- Intent with no light fields set → dropped (never emits an empty patch).
- Material on a mesh without `emissive` (e.g. MeshBasicMaterial text tags) → the
  guarded traverse skips missing properties silently.
