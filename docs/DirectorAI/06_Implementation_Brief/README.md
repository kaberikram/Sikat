# Implementation Briefs

Actionable specs for upcoming Director Mode work. Each brief is self-contained
enough to hand to an agent: schema diffs, file touch lists, acceptance criteria,
and a copy-paste kickoff prompt.

| Brief | Status | Summary |
|---|---|---|
| [[Scene_Aware_Director]] | **Ready** | Rich scene context, vision-on-command, set radio, hold/action/cut |
| [[LLM_System_Prompt]] | Reference | Extracted system prompt from Scene_Aware_Director (Phase A) |

## How to implement

1. Open [[Scene_Aware_Director]] and read Phase A acceptance criteria.
2. Switch to Agent mode and paste the **Agent kickoff** block at the bottom of that file.
3. Land Phase A before starting B–E.

## Related

- [[System_Architecture]] — current data flow
- [[Command_Protocol]] — normative wire contract (update with every schema change)
- [[Roadmap]] — product phases
- [[Task_Board]] — kanban tracking
