# DirectorAI Vault

Knowledge base for **Director Mode** — the multi-agent, voice/text-directed
control layer on top of RADIO_EDIT.EXE. Obsidian-compatible: open `docs/DirectorAI`
as a vault (or the whole repo) and links resolve.

## Map

| Folder | Contents |
|---|---|
| `00_Meta/` | This file, [[Glossary]] |
| `02_Project_Management/` | [[Roadmap]] (scope + phases), [[Task_Board]] |
| `03_PRD_Architecture/` | [[PRD_MR_Directing_Studio]], [[System_Architecture]], [[Command_Protocol]] (the normative wire contract) |
| `04_AI_Crew_Profiles/` | One card per agent: role, owned commands, prompt text, failure modes |
| `05_Knowledge_Base/` | [[Store_Capabilities]] (what the editor store can actually do), [[Fallback_Grammar]] (rule parser reference) |
| `06_Implementation_Brief/` | [[Scene_Aware_Director]] (ready-to-code spec), [[LLM_System_Prompt]] (prompt extract) |

## Source-of-truth rules

- The wire contract has **one** normative copy: [[Command_Protocol]]. `server/app/schema.py`
  and `src/director/protocol.ts` implement it; change all three together.
- Agent prompt text in `04_AI_Crew_Profiles/` mirrors the actual strings in
  `server/app/llm.py` — update both when tuning.
- [[Fallback_Grammar]] mirrors `server/app/fallback_parser.py`.
