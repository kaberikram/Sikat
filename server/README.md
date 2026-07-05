# Director Server

FastAPI agent-swarm backend for RADIO_EDIT.EXE **Director Mode**.
Protocol reference: `../docs/DirectorAI/03_PRD_Architecture/Command_Protocol.md`.

## Run

```sh
cd server
uv sync
uv run uvicorn app.main:app --port 8000
```

Optional LLM parsing (falls back to the deterministic rule grammar without it).
Two providers are supported with **quality-tier routing** when both keys are set.

**Recommended:** copy `.env.example` → `.env` in this folder and paste your keys.
`.env` is gitignored; only `.env.example` is tracked.

```sh
cp .env.example .env
# edit .env — add ANTHROPIC_API_KEY=sk-ant-...
uv run uvicorn app.main:app --port 8000
```

Or pass keys inline (same vars, no file):

```sh
# Recommended: Anthropic for choreo refine + vision
ANTHROPIC_API_KEY=sk-ant-... uv run uvicorn app.main:app --port 8000

# Both keys — Anthropic wins for LLM parse/stream; DeepSeek unused unless forced
DEEPSEEK_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... uv run uvicorn app.main:app --port 8000

# DeepSeek only (text commands; weaker choreo; vision → fallback grammar)
DEEPSEEK_API_KEY=sk-... uv run uvicorn app.main:app --port 8000
```

Model overrides:
- `DIRECTOR_QUALITY_MODEL=claude-sonnet-5` — animate/choreo refine (default)
- `DIRECTOR_FAST_MODEL=deepseek-v4-flash` — reserved for future fast helpers
- `DIRECTOR_MODEL=...` — legacy override for whichever provider is selected

Provider resolution:

| variable | effect |
|---|---|
| `DIRECTOR_LLM_PROVIDER` | force `anthropic` \| `deepseek` \| `none` (skip the LLM) |
| both keys, no override | **Anthropic** for text parse/stream + vision; DeepSeek not used |
| `ANTHROPIC_API_KEY` only | Anthropic for text and vision |
| `DEEPSEEK_API_KEY` only | DeepSeek for text; vision → fallback grammar |
| `DIRECTOR_QUALITY_MODEL` | Anthropic model id (use non-reasoning Sonnet, not `*-max`) |

With no key (or `DIRECTOR_LLM_PROVIDER=none`) the rule grammar runs the show.
Any LLM error or invalid JSON also degrades to the rule grammar.

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
app/session_context.py rolling conversation memory (pronouns + amendments)
app/llm.py             pluggable DeepSeek/Anthropic client + parse
app/fallback_parser.py deterministic text -> Intent grammar
app/agents/            Producer, DirectorsAssistant, LightingTech,
                       AssetAnimator, VFXOperator
scripts/mock_telemetry.py
tests/
```
