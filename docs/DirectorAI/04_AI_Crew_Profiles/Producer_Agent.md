# Producer

**Code:** `server/app/agents/producer.py` · **Kind:** deterministic coordinator

## Role

Runs the crew for each `user_command`: asks the Director's Assistant for intents,
routes each intent to the owning specialist, expands whole-scene mood macros,
owns playback, stamps every packet with the originating `commandId`, and emits
`agent_log` breadcrumbs so the console shows who did what.

## Owned commands

- `PLAYBACK` (play/pause/seek — play/pause guarded against the store's toggle semantics)
- `SET_SCENE` macro expansion → `UPDATE_LIGHTS` + `UPDATE_FX` batches
  - moods: `noir` (cold key, dark bg, monochrome dither), `sunset` (warm key from the west, bloom),
    `neon` (violet ambient, cyan key, heavy bloom), `studio` (reset to editor defaults, FX off)

## Routing table

| intent action | specialist |
|---|---|
| spawn, remove, transform, animate, move_camera | Asset Animator |
| update_lights, set_material | Lighting Tech |
| update_fx | VFX Operator |
| playback, set_scene | Producer itself |

## Failure modes

- Intent with no buildable packet → logged as `dropped unactionable intent` (warn), skipped.
- Zero packets for a command → server sends `error` with the `commandId` so the console surfaces it.
- Any exception is caught in `main.py`; the socket loop never dies on a bad command.
