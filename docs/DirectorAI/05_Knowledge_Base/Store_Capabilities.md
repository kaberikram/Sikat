# Store Capabilities (src/store.ts)

The ground truth every agent command ultimately lands on. Scene.tsx re-reads
this store **every frame**, so a store write is a scene change — the applier
never touches the renderer.

## Pre-existing actions (unchanged)

| action | signature | notes |
|---|---|---|
| `addObject` | `(Partial<MotionObject>)` | takes a pre-built `THREE.Object3D` in `.mesh`; stamps `mesh.userData.id`. Now honors a caller-provided `id` (was always random). |
| `removeObject` | `(id)` | Scene prunes the mesh via a store subscription |
| `updateObject` | `(id, {name?, position?, rotation?, scale?})` | base transform patch |
| `updateCamera` | `({position?, rotation?, fov?, postProcessing?})` | FX stack lives here |
| `setTime` / `togglePlay` | | `togglePlay` is a **toggle** — applier compares `isPlaying` to the desired state first |
| `addKeyframe` / `addCameraKeyframe` | | dedupes same time+property |
| `setObjectPropertyKeyframes` | | replaces ALL keyframes of one property (preset animations) |
| `setSubMeshTransparent` / `setSubMeshShadow` | | mutate THREE materials inside the store — the precedent `setObjectMaterial` follows |

## Added for Director Mode

| addition | shape |
|---|---|
| `lighting` slice | `{ambient {color,intensity}, key {color,intensity,position}, background}` — defaults exactly match the values previously hard-coded in Scene.tsx |
| `updateLighting(patch)` | deep-merge; Scene applies per frame (same pattern as postProcessing) |
| `setObjectMaterial(id, patch)` | `{color?, emissive?, emissiveIntensity?, opacity?}` — traverses meshes, records on `materialOverride` |
| `MotionObject.materialOverride` | keeps agent material changes exportable/serializable |

## Sharp edges to remember

- **Keyframes override base values** (`keyframe-interpolation.ts` ignores base
  when any keyframes exist for a property) → applier's bake-vs-tween policy.
- `isExporting` pauses the Scene RAF loop → the tween engine holds too.
- Object ids are 9-char randoms unless provided; names are the human handle —
  which is why target resolution is name-first with substring fallback.
