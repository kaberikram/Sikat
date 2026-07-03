# VFX Operator

**Code:** `server/app/agents/vfx_operator.py` · **Kind:** deterministic specialist

## Role

Controls the viewfinder post-processing stack: bloom, pixelate, cell shading,
glitch, dither. **Never** the main viewport — FX render only on the virtual
camera's PiP (the editor's core comfort invariant, which becomes "never
post-process passthrough" in XR).

## Owned command

- `UPDATE_FX {section, patch}` — the applier merges the patch into
  `virtualCamera.postProcessing[section]` (same merge the Properties panel does).

## Alias table

Spoken parameter names normalize to canonical patch keys per section, e.g.
`size → pixelSize`, `mix → strength` (dither), `amount → intensity` (glitch),
`glow → strength` (bloom). Unknown keys are dropped, not errored.

## Deterministic "more/less" semantics

Without current-FX feedback in the snapshot, relative asks map to preset points:

| section | "more" | "less" |
|---|---|---|
| bloom strength | 1.8 | 0.4 |
| pixelate pixelSize | 12 | 4 |
| glitch intensity | 0.3 | 0.06 |
| dither strength | 1.0 | 0.3 |
| cellShading outlineScale | 1.12 | 1.02 |

## Failure modes

- Empty patch after alias filtering → no packet (Producer logs a warn).
- Out-of-range values are clamped by `schema.py` to the editor's slider ranges —
  "set bloom strength to 99" lands at 2.5, never a rejection.
