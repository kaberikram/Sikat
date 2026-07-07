# Server commands (cheat sheet)

Quick reference from repo root unless noted.

## Full stack (Director Mode)

**Terminal A — agent server**

```bash
cd server
uv sync                    # first time / after dep changes
uv run uvicorn app.main:app --port 8000
```

**Terminal B — editor**

```bash
npm run dev
```

Open the app → **DIRECTOR_LINK** connects to `ws://localhost:8000/ws` automatically.

---

## First-time API keys

```bash
cd server
cp .env.example .env
# edit .env — ANTHROPIC_API_KEY and/or DEEPSEEK_API_KEY
uv run uvicorn app.main:app --port 8000
```

No keys? Server still runs — rule grammar only.

---

## Handy variants

```bash
# auto-reload on Python changes (dev)
cd server && uv run uvicorn app.main:app --port 8000 --reload

# smoke check
curl http://localhost:8000/healthz

# tests
cd server && uv run pytest

# mock camera operator (server + editor must be running)
cd server && uv run python scripts/mock_telemetry.py --duration 15
```

---

## Env overrides (optional)

| Variable | Values |
|----------|--------|
| `DIRECTOR_LLM_PROVIDER` | `anthropic` \| `deepseek` \| `none` |
| `ANTHROPIC_API_KEY` | vision + quality parse |
| `DEEPSEEK_API_KEY` | text-only fallback |

More detail: [README.md](./README.md)
