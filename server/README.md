# Director Server

FastAPI agent-swarm backend for RADIO_EDIT.EXE **Director Mode**.
Protocol reference: `../docs/DirectorAI/03_PRD_Architecture/Command_Protocol.md`.

## Run

```sh
cd server
uv sync
uv run uvicorn app.main:app --port 8000
```

Optional LLM parsing (falls back to the rule grammar without it):

```sh
ANTHROPIC_API_KEY=sk-... uv run uvicorn app.main:app --port 8000
# model override: DIRECTOR_MODEL=claude-opus-4-8
```

## Test

```sh
uv run pytest
```

## Mock camera telemetry

With the server (and the editor) running:

```sh
uv run python scripts/mock_telemetry.py --duration 15
```

simulates a camera operator orbiting the stage at 20 Hz — the virtual camera
PiP in the editor follows.

## Layout

```
app/main.py            /ws endpoint, broadcast, telemetry throttle, /healthz
app/schema.py          wire contract (pydantic; values clamped to editor ranges)
app/scene_state.py     latest editor snapshot (grounds agent parsing)
app/llm.py             lazy Anthropic client + structured-outputs parse
app/fallback_parser.py deterministic text -> Intent grammar
app/agents/            Producer, DirectorsAssistant, LightingTech,
                       AssetAnimator, VFXOperator
scripts/mock_telemetry.py
tests/
```
