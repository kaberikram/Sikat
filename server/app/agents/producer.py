"""Producer: coordinates the crew."""
from __future__ import annotations

import asyncio
import logging

from .. import active_commands, fallback_parser, llm, performers, session_context
from ..converse import converse_intent, radio_reply
from ..creative_parse import defer_clause_to_llm, is_open_direction
from ..grammar_say import intent_with_radio
from ..parse_hints import format_parse_hints
from ..fallback_parser import parse_one_clause, split_clauses
from ..mood_presets import mood_packets
from ..motion_variation import enrich_motion_params
from ..heuristics import Observation
from ..verify import check_apply, verify_enabled
from ..schema import (
    CommandPacket,
    Intent,
    PlaybackPacket,
    PlaybackPayload,
    SceneFrame,
    SceneState,
    agent_question_message,
    intent_preview_message,
)
from ..session_context import CLARIFY_TIMEOUT_SEC, PendingClarify
from ..target_resolution import resolve_option_answer
from .asset_animator import AssetAnimator, default_spawn_name
from .base import (
    EmitCancel,
    EmitLog,
    EmitPacket,
    EmitPreview,
    EmitQuestion,
    EmitStatus,
    EmitSuggest,
    _noop_cancel,
    _noop_emit,
    _noop_packet,
    _noop_preview,
    _noop_question,
    _noop_status,
    _noop_suggest,
)
from .directors_assistant import DirectorsAssistant
from .planner import Planner
from .lighting_tech import LightingTech
from .vfx_operator import VFXOperator

log = logging.getLogger("director.producer")

_LLM_STREAM_DONE = object()

# Server-side pacing. Kept intentionally light: the client owns the real
# choreography (flight/hover/settle). These sleeps only interleave the crew so
# statuses and packets stream over a few hundred ms instead of one burst.
AGENT_STEP_DELAY = 0.35  # between successive packets from the same specialist
AGENT_STAGGER = 0.30  # head-start offset between specialists so cursors fan out

# Present-tense verb per command, shown on the agent's cursor as a "note" the
# instant it goes active — fills the parse latency ("dead air") so the crew's
# thinking is visible before the first packet lands. The client refines these
# per packet as work proceeds (e.g. "tracing bounce 12/25").
_COMMAND_NOTE = {
    "SPAWN_OBJECT": "spawning",
    "REMOVE_OBJECT": "removing",
    "TRANSFORM_OBJECT": "moving",
    "ANIMATE_OBJECT": "animating",
    "MOVE_CAMERA": "framing shot",
    "UPDATE_LIGHTS": "lighting",
    "SET_MATERIAL": "painting",
    "UPDATE_FX": "compositing",
    "SET_KEYFRAMES": "keyframing",
    "PLAYBACK": "cueing",
}


def _agent_note(agent_packets: list[CommandPacket]) -> str:
    """A short 'what am I doing' note derived from the agent's first packet."""
    if not agent_packets:
        return "working"
    return _COMMAND_NOTE.get(agent_packets[0].command, "working")


_INSTANT_NOTE_POOL = [
    "copy",
    "on it",
    "hearing you",
    "rolling on that",
    "got it",
    "standing by",
    "yep",
    "roger",
]


def _display_note(note: str | None, agent_packets: list[CommandPacket]) -> str | None:
    if note:
        session_context.note_say(note)
        return note
    if not agent_packets:
        return session_context.pick_fresh_note(_INSTANT_NOTE_POOL)
    base = _agent_note(agent_packets)
    recent = session_context.get_session().recent_notes
    if base in recent:
        alts = [v for v in dict.fromkeys(_COMMAND_NOTE.values()) if v != base]
        return session_context.pick_fresh_note(alts + _INSTANT_NOTE_POOL)
    session_context.note_say(base)
    return base


_SUMMARY_PARAM_KEYS = ("hops", "height", "amplitude", "frequency", "turns", "radius")


def _performer_action_summary(intent: Intent) -> str:
    """Short "action target motion params" text for a performer's recent-work
    memory, e.g. "animate CORE_SPHERE bounce ×3 high" — grounds a later
    "again but bigger" against this performer's own last move."""
    parts = [intent.action]
    if intent.target:
        parts.append(intent.target)
    motion = intent.motion or intent.preset
    if motion:
        parts.append(motion)
    if intent.motion_params:
        for key in _SUMMARY_PARAM_KEYS:
            if key in intent.motion_params:
                parts.append(f"{key}={intent.motion_params[key]:g}")
    if intent.scale:
        parts.append(f"scale={intent.scale}")
    return " ".join(parts)


async def _drain_llm_stream(agen, queue: asyncio.Queue) -> None:
    """Pump an ``llm.stream_intents`` async generator into a queue.

    Runs as its own task so the LLM call proceeds concurrently with grammar
    staging. On task cancellation, closes the generator before re-raising.
    """
    try:
        async for intent in agen:
            await queue.put(intent)
    except asyncio.CancelledError:
        await agen.aclose()
        raise
    except Exception:
        log.exception("LLM intent stream consumption failed")
    finally:
        queue.put_nowait(_LLM_STREAM_DONE)


class Producer:
    name = "Producer"

    def __init__(self) -> None:
        self.assistant = DirectorsAssistant()
        self.specialists = [AssetAnimator(), LightingTech(), VFXOperator()]
        self._routes = {
            action: specialist
            for specialist in self.specialists
            for action in specialist.actions
        }

    def _build_own(self, intent: Intent) -> list[CommandPacket]:
        if intent.action == "playback" and intent.playback_action:
            packets = [
                PlaybackPacket(
                    payload=PlaybackPayload(
                        action=intent.playback_action, time=intent.seek_time
                    )
                )
            ]
            if intent.playback_pause_after_seek:
                packets.append(PlaybackPacket(payload=PlaybackPayload(action="pause")))
            return packets
        if intent.action == "set_scene" and intent.mood:
            packets = mood_packets(intent.mood)
            if not packets:
                return []
            return packets
        return []

    async def _emit_describe(
        self, intent: Intent, emit: EmitLog = _noop_emit
    ) -> None:
        await emit(
            self.assistant.name,
            intent.describe_message or "Scene description requested.",
            "info",
        )

    async def _build_packets_for_intent(
        self,
        intent: Intent,
        emit: EmitLog = _noop_emit,
        emit_status: EmitStatus = _noop_status,
        command_id: str | None = None,
        scene: SceneState | None = None,
    ) -> list[CommandPacket]:
        if intent.action == "assign":
            if intent.addressee and intent.target:
                performers.assign(intent.addressee, intent.target, intent.role)
                agent = f"Agent{intent.addressee}"
                await emit(
                    self.name,
                    f"Agent {intent.addressee} on {intent.target}",
                    "info",
                )
                await emit_status(agent, "active", command_id, "assigned")
                await emit_status(agent, "idle", command_id, "copy")
            return []

        if intent.action in ("playback", "set_scene"):
            built = self._build_own(intent)
            if intent.action == "set_scene" and intent.mood and not built:
                await emit(self.name, f"unknown mood '{intent.mood}'", "warn")
            elif intent.action == "set_scene" and built:
                await emit(
                    self.name, f"mood '{intent.mood}' -> {len(built)} packets", "info"
                )
            return built

        specialist = self._routes.get(intent.action)
        working = intent
        if intent.action == "animate" and not intent.track_keyframes:
            motion = intent.motion or intent.preset
            if motion:
                stage_r = scene.stage.radius if scene else 25.0
                params = enrich_motion_params(
                    intent.motion_params, motion, command_id, stage_r
                )
                working = intent.model_copy(update={"motion_params": params})
        if intent.addressee and not working.target:
            assignment = performers.get(intent.addressee)
            if assignment:
                working = working.model_copy(update={"target": assignment.target})
        built = specialist.build(working, scene) if specialist else []
        if built and specialist:
            await emit(
                specialist.name,
                intent.say or ", ".join(p.command for p in built),
                "info",
            )
        if intent.addressee and built:
            agent = f"Agent{intent.addressee}"
            for packet in built:
                packet.target_agent = agent  # type: ignore[assignment]
            performers.record_action(intent.addressee, _performer_action_summary(intent))
        if not built:
            await emit(self.name, f"dropped unactionable intent: {intent.action}", "warn")
        return built

    async def _build_packets_for_intents(
        self,
        intents: list[Intent],
        emit: EmitLog = _noop_emit,
        emit_status: EmitStatus = _noop_status,
        command_id: str | None = None,
        scene: SceneState | None = None,
    ) -> list[CommandPacket]:
        packets: list[CommandPacket] = []
        for intent in intents:
            if intent.action == "describe":
                continue
            packets.extend(
                await self._build_packets_for_intent(
                    intent, emit, emit_status, command_id, scene
                )
            )
        return packets

    async def _maybe_emit_supersede_cancel(
        self,
        packet: CommandPacket,
        emit_cancel: EmitCancel,
    ) -> None:
        target_name = active_commands._packet_target_name(packet)
        if not target_name or not packet.commandId:
            return
        if packet.command not in (
            "TRANSFORM_OBJECT",
            "ANIMATE_OBJECT",
            "SET_MATERIAL",
            "SET_KEYFRAMES",
        ):
            return
        prior = active_commands.note_active(
            target_name, packet.command, packet.commandId
        )
        if prior and prior[0] != packet.commandId:
            await emit_cancel(
                active_commands.build_supersede_cancel(
                    prior[0],
                    superseded_by=packet.commandId,
                    target_name=target_name,
                    command=prior[1],
                )
            )

    async def _maybe_emit_freeze_cancel(
        self,
        intent: Intent,
        command_id: str | None,
        emit_cancel: EmitCancel,
    ) -> None:
        if not intent.freeze_motion or not command_id:
            return
        target = session_context.last_target()
        if not target:
            return
        prior = active_commands.prior_for(target, "ANIMATE_OBJECT")
        if prior:
            await emit_cancel(active_commands.build_stop_cancel(prior[0], target))

    async def _emit_clarify(
        self,
        intent: Intent,
        held_clause: str,
        command_id: str | None,
        emit_log: EmitLog,
        emit_question: EmitQuestion,
        emit_cancel: EmitCancel,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        scene: SceneState | None,
    ) -> None:
        if not command_id or not intent.clarify_question or not intent.clarify_options:
            return
        agent = "AssetAnimator"
        session_context.set_pending_clarify(
            PendingClarify(
                command_id=command_id,
                held_clauses=[held_clause],
                question=intent.clarify_question,
                options=intent.clarify_options,
                agent=agent,
            )
        )
        await emit_question(
            agent_question_message(
                agent,
                command_id,
                intent.clarify_question,
                intent.clarify_options,
            )
        )
        await emit_log(self.name, f"clarify: {intent.clarify_question}", "info")

        async def timeout() -> None:
            await asyncio.sleep(CLARIFY_TIMEOUT_SEC)
            pending = session_context.pending_clarify()
            if pending is None or pending.command_id != command_id:
                return
            guess = pending.options[0]
            await emit_log(
                self.name, f"clarify timeout — assuming {guess}", "warn"
            )
            session_context.clear_pending_clarify()
            session_context.set_clarify_target(guess)
            held = " and ".join(pending.held_clauses)
            await self._direct_multi_clause(
                held,
                split_clauses(held),
                scene,
                pending.command_id,
                emit_log,
                emit_packet,
                emit_status,
                None,
                _noop_preview,
                emit_cancel,
                _noop_question,
                skip_clarify_resume=True,
            )

        asyncio.create_task(timeout())

    async def _emit_suggest(
        self,
        intent: Intent,
        emit_suggest: EmitSuggest,
    ) -> None:
        if not intent.say and not intent.suggestion_command:
            return
        obs = Observation(
            kind="command_suggest",
            agent="Producer",
            subject_object=intent.target,
            severity=2,
            template_line=intent.say or "got a follow-up idea",
            suggested_command=intent.suggestion_command,
            dedupe_key=f"suggest:{intent.suggestion_command or intent.say}",
        )
        await emit_suggest(obs)

    async def _try_resume_clarify(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        emit_cancel: EmitCancel,
        emit_question: EmitQuestion,
    ) -> tuple[list[CommandPacket], bool] | None:
        pending = session_context.pending_clarify()
        if pending is None:
            return None
        answer = resolve_option_answer(text, pending.options)
        if not answer:
            return None
        session_context.clear_pending_clarify()
        session_context.set_clarify_target(answer)
        await emit_log(self.name, f"clarify answered → {answer}", "info")
        held = " and ".join(pending.held_clauses)
        return await self._direct_multi_clause(
            held,
            split_clauses(held),
            scene,
            pending.command_id,
            emit_log,
            emit_packet,
            emit_status,
            None,
            _noop_preview,
            emit_cancel,
            emit_question,
            skip_clarify_resume=True,
        )

    async def _stream_packets_staged(
        self,
        packets: list[CommandPacket],
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        note: str | None = None,
        emit_cancel: EmitCancel = _noop_cancel,
        scene: SceneState | None = None,
        intent: Intent | None = None,
    ) -> None:
        if not packets:
            return

        groups: dict[str, list[CommandPacket]] = {}
        for packet in packets:
            packet.commandId = command_id
            groups.setdefault(packet.target_agent, []).append(packet)

        assignment = ", ".join(
            f"{agent}→{'/'.join(dict.fromkeys(p.command for p in pkts))}"
            for agent, pkts in groups.items()
        )
        log.debug("assigning: %s", assignment)

        async def run_specialist(
            index: int, agent: str, agent_packets: list[CommandPacket]
        ) -> None:
            await asyncio.sleep(index * AGENT_STAGGER)
            await emit_status(agent, "active", command_id, _display_note(note, agent_packets))
            for step, packet in enumerate(agent_packets):
                if step:
                    await asyncio.sleep(AGENT_STEP_DELAY)
                await self._maybe_emit_supersede_cancel(packet, emit_cancel)
                await emit_packet(packet)
            await emit_status(agent, "idle", command_id, "done")

        await asyncio.gather(
            *(
                run_specialist(index, agent, agent_packets)
                for index, (agent, agent_packets) in enumerate(groups.items())
            )
        )

        if verify_enabled():
            asyncio.create_task(
                self._post_verify(
                    packets, command_id, emit_log, emit_packet, scene, intent
                )
            )

    async def _post_verify(
        self,
        packets: list[CommandPacket],
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        scene: SceneState | None,
        intent: Intent | None,
    ) -> None:
        session = session_context.get_session()
        try:
            await asyncio.wait_for(session.scene_event.wait(), 1.5)
        except asyncio.TimeoutError:
            pass
        scene_now = session.latest_scene or scene
        for packet in packets:
            if packet.command not in ("TRANSFORM_OBJECT", "SET_KEYFRAMES"):
                continue
            correction = check_apply(intent, packet, scene_now)
            if correction is None:
                continue
            await emit_log("Producer", correction.message, "warn")
            await emit_packet(correction.packet)
            break

    async def handle_user_command(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None = None,
        emit: EmitLog = _noop_emit,
        emit_status: EmitStatus = _noop_status,
        frame: SceneFrame | None = None,
    ) -> tuple[list[CommandPacket], bool]:
        """Returns (packets, describe_only). describe_only suppresses no-op errors."""
        intents, source = await self.assistant.parse(text, scene, frame)
        session_context.record(text, intents)
        await emit(
            self.assistant.name,
            f"parsed {len(intents)} intent(s) via {source}",
            "info" if intents else "warn",
        )

        describe_intents = [i for i in intents if i.action == "describe"]
        mutating_intents = [i for i in intents if i.action != "describe"]

        for intent in describe_intents:
            await self._emit_describe(intent, emit)

        if describe_intents and not mutating_intents:
            return [], True

        packets = await self._build_packets_for_intents(
            mutating_intents, emit, emit_status, command_id, scene
        )
        for packet in packets:
            packet.commandId = command_id

        if not packets and any(i.action == "assign" for i in mutating_intents):
            return [], True

        return packets, False

    async def _direct_single_clause(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        frame: SceneFrame | None,
        emit_cancel: EmitCancel = _noop_cancel,
    ) -> tuple[list[CommandPacket], bool]:
        packets, describe_only = await self.handle_user_command(
            text, scene, command_id, emit_log, emit_status, frame
        )
        if not packets:
            return packets, describe_only

        await self._stream_packets_staged(
            packets, command_id, emit_log, emit_packet, emit_status, emit_cancel=emit_cancel
        )
        return packets, False

    async def _stream_intents(
        self,
        intents: list[Intent],
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        scene: SceneState | None = None,
        emit_cancel: EmitCancel = _noop_cancel,
        emit_suggest: EmitSuggest = _noop_suggest,
    ) -> list[CommandPacket]:
        packets: list[CommandPacket] = []
        for intent in intents:
            if intent.action == "describe":
                await self._emit_describe(intent, emit_log)
                continue
            if intent.action == "suggest":
                await self._emit_suggest(intent, emit_suggest)
                continue
            voiced = intent_with_radio(intent)
            await self._maybe_emit_freeze_cancel(voiced, command_id, emit_cancel)
            built = await self._build_packets_for_intent(
                voiced, emit_log, emit_status, command_id, scene
            )
            for packet in built:
                packet.commandId = command_id
            packets.extend(built)
            await self._stream_packets_staged(
                built,
                command_id,
                emit_log,
                emit_packet,
                emit_status,
                note=voiced.say,
                emit_cancel=emit_cancel,
                scene=scene,
                intent=voiced,
            )
        return packets

    async def _emit_staged_intent(
        self,
        intent: Intent,
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        emit_cancel: EmitCancel,
        scene: SceneState | None,
        *,
        refinement: bool = False,
        prior_command_id: str | None = None,
    ) -> list[CommandPacket]:
        voiced = intent_with_radio(intent)
        await self._maybe_emit_freeze_cancel(voiced, command_id, emit_cancel)
        built = await self._build_packets_for_intent(
            voiced, emit_log, emit_status, command_id, scene
        )
        for packet in built:
            packet.commandId = command_id
            if refinement:
                packet.refinement = True
                packet.priorCommandId = prior_command_id or command_id
        await self._stream_packets_staged(
            built,
            command_id,
            emit_log,
            emit_packet,
            emit_status,
            note=voiced.say,
            emit_cancel=emit_cancel,
            scene=scene,
            intent=voiced,
        )
        return built

    def _resolve_pronoun_target(
        self, intent: Intent, grammar_emitted: list[Intent]
    ) -> Intent:
        if intent.action != "animate":
            return intent
        target = (intent.target or "").strip().lower()
        if target and target not in ("it", "that", "this", "this one"):
            return intent
        for g in grammar_emitted:
            if g.action == "spawn":
                return intent.model_copy(update={"target": default_spawn_name(g)})
        pending = session_context.last_target()
        if pending:
            return intent.model_copy(update={"target": pending})
        return intent

    def _is_duplicate_of_grammar(
        self, grammar_emitted: list[Intent], llm_intent: Intent
    ) -> bool:
        if llm_intent.action == "spawn":
            prim = (llm_intent.primitive or "").lower()
            return any(
                g.action == "spawn" and (g.primitive or "").lower() == prim
                for g in grammar_emitted
            )
        resolved = self._resolve_pronoun_target(llm_intent, grammar_emitted)
        target = resolved.target or llm_intent.target
        return any(
            g.action == llm_intent.action and (g.target or "") == (target or "")
            for g in grammar_emitted
        )

    async def _emit_llm_intent(
        self,
        intent: Intent,
        grammar_emitted: list[Intent],
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        emit_cancel: EmitCancel,
        scene: SceneState | None,
    ) -> list[CommandPacket]:
        if intent.action in ("describe", "suggest", "clarify"):
            return []

        if self._is_duplicate_of_grammar(grammar_emitted, intent):
            if intent.say:
                session_context.note_say(intent.say)
                await emit_log(self.assistant.name, intent.say, "info")
            return []

        working = self._resolve_pronoun_target(intent, grammar_emitted)
        return await self._emit_staged_intent(
            working,
            command_id,
            emit_log,
            emit_packet,
            emit_status,
            emit_cancel,
            scene,
            refinement=False,
        )

    async def _direct_multi_clause(
        self,
        text: str,
        clauses: list[str],
        scene: SceneState | None,
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        frame: SceneFrame | None,
        emit_preview: EmitPreview = _noop_preview,
        emit_cancel: EmitCancel = _noop_cancel,
        emit_question: EmitQuestion = _noop_question,
        emit_suggest: EmitSuggest = _noop_suggest,
        skip_clarify_resume: bool = False,
    ) -> tuple[list[CommandPacket], bool]:
        if not skip_clarify_resume:
            resumed = await self._try_resume_clarify(
                text,
                scene,
                command_id,
                emit_log,
                emit_packet,
                emit_status,
                emit_cancel,
                emit_question,
            )
            if resumed is not None:
                return resumed

        parsed = [(cl, parse_one_clause(cl, scene)) for cl in clauses]

        llm_available = llm.select_provider(frame) is not None
        if llm_available and is_open_direction(text):
            all_deferred = all(
                defer_clause_to_llm(cl, intent, llm_available=True)
                for cl, intent in parsed
            )
            if all_deferred:
                return await Planner(self).run(
                    text,
                    scene,
                    command_id,
                    emit_log,
                    emit_packet,
                    emit_status,
                    frame,
                    emit_cancel,
                    emit_suggest,
                )

        grammar_handled_indices: set[int] = set()
        if llm_available:
            for idx, (clause, raw_intent) in enumerate(parsed):
                if raw_intent is None:
                    continue
                if not defer_clause_to_llm(clause, raw_intent, llm_available=True):
                    grammar_handled_indices.add(idx)

        any_llm_owned = llm_available and any(
            defer_clause_to_llm(cl, intent, llm_available=True)
            for cl, intent in parsed
        )

        hints = (
            format_parse_hints(parsed, scene, handled_indices=grammar_handled_indices)
            if any_llm_owned
            else ""
        )

        llm_feed_task: asyncio.Task | None = None
        llm_queue: asyncio.Queue | None = None
        partial_seen: set[tuple[tuple[str, str | int], ...]] = set()

        async def on_llm_partial(fields: dict[str, str | int]) -> None:
            key = tuple(sorted(fields.items()))
            if key in partial_seen:
                return
            partial_seen.add(key)
            addressee = fields.get("addressee")
            agent = f"Agent{addressee}" if isinstance(addressee, int) else "AssetAnimator"
            note = str(fields.get("say") or fields.get("motion") or "working on it")[:80]
            target = str(fields["target"]) if fields.get("target") else None
            action = str(fields["action"]) if fields.get("action") else None
            motion = str(fields["motion"]) if fields.get("motion") else None
            if command_id:
                await emit_preview(
                    intent_preview_message(
                        command_id,
                        agent,
                        note,
                        target=target,
                        action=action,
                        motion=motion,
                        confidence="llm_partial",
                    )
                )

        # Any LLM-owned clause (including hybrid grammar+LLM) — keep the crew
        # "live" so the client holds cursors/spinners until motion arrives.
        if any_llm_owned:
            await emit_status(self.name, "active", command_id, "hearing you")

        if any_llm_owned:
            llm_agen = llm.stream_intents(
                text, scene, frame, on_partial=on_llm_partial, hints=hints or None
            )
            llm_queue = asyncio.Queue()
            llm_feed_task = asyncio.create_task(_drain_llm_stream(llm_agen, llm_queue))
            log.debug("streaming %d clause(s); LLM in parallel", len(clauses))

        grammar_emitted: list[Intent] = []
        all_intents: list[Intent] = []
        all_packets: list[CommandPacket] = []
        describe_only = True
        grammar_handled_count = 0
        llm_directed_count = 0

        for idx, (clause, raw_intent) in enumerate(parsed):
            if raw_intent is not None and defer_clause_to_llm(
                clause, raw_intent, llm_available=llm_available
            ):
                if llm_available:
                    log.debug(
                        "defer → LLM: %s",
                        f"{clause[:72]}{'…' if len(clause) > 72 else ''}",
                    )
                continue

            if raw_intent is None:
                continue

            if raw_intent.action == "clarify":
                if llm_available:
                    continue
                all_intents.append(raw_intent)
                await self._emit_clarify(
                    raw_intent,
                    clause,
                    command_id,
                    emit_log,
                    emit_question,
                    emit_cancel,
                    emit_packet,
                    emit_status,
                    scene,
                )
                continue

            if raw_intent.action == "describe":
                all_intents.append(raw_intent)
                # Grammar-owned describe (incl. open-speech converse) always logs.
                # LLM-owned describe is deferred above and emitted from the stream.
                await self._emit_describe(raw_intent, emit_log)
                continue

            if raw_intent.action == "suggest":
                all_intents.append(raw_intent)
                if not llm_available:
                    await self._emit_suggest(raw_intent, emit_suggest)
                continue

            all_intents.append(raw_intent)
            describe_only = False
            voiced = intent_with_radio(raw_intent)
            built = await self._emit_staged_intent(
                voiced,
                command_id,
                emit_log,
                emit_packet,
                emit_status,
                emit_cancel,
                scene,
                refinement=False,
            )
            all_packets.extend(built)
            grammar_emitted.append(voiced)
            grammar_handled_count += 1
            if raw_intent.action == "spawn" and built:
                spawn_name = built[0].payload.name
                if spawn_name:
                    session_context.note_target(spawn_name)

        if llm_feed_task is not None and llm_queue is not None:
            while True:
                try:
                    intent = await asyncio.wait_for(llm_queue.get(), timeout=45.0)
                except asyncio.TimeoutError:
                    log.warning("LLM drain timed out after 45s")
                    break
                if intent is _LLM_STREAM_DONE:
                    break
                all_intents.append(intent)
                if intent.action == "suggest":
                    await self._emit_suggest(intent, emit_suggest)
                    continue
                if intent.action == "describe":
                    await self._emit_describe(intent, emit_log)
                    continue
                describe_only = False
                built = await self._emit_llm_intent(
                    intent,
                    grammar_emitted,
                    command_id,
                    emit_log,
                    emit_packet,
                    emit_status,
                    emit_cancel,
                    scene,
                )
                if built:
                    llm_directed_count += 1
                all_packets.extend(built)
            await llm_feed_task

        session_context.record(text, all_intents)
        if llm_available:
            if any_llm_owned:
                log.debug(
                    "grammar handled %d; LLM directed %d",
                    grammar_handled_count,
                    llm_directed_count,
                )
            else:
                log.debug(
                    "instant — %d intent(s) via grammar (LLM idle)",
                    grammar_handled_count,
                )
        else:
            if all_intents:
                log.debug("parsed %d intent(s) via fallback", len(all_intents))
            else:
                await emit_log(
                    self.assistant.name,
                    f"parsed {len(all_intents)} intent(s) via fallback",
                    "warn",
                )

        if describe_only and all_intents:
            return [], True

        if not all_packets and not all_intents:
            rescue = fallback_parser.parse(text, scene)
            if rescue:
                await emit_log(
                    self.assistant.name,
                    "LLM missed — applying rule-parser rescue",
                    "warn",
                )
                all_intents.extend(rescue)
                describe_only = all(i.action == "describe" for i in rescue)
                rescued = await self._stream_intents(
                    [i for i in rescue if i.action != "describe"],
                    command_id,
                    emit_log,
                    emit_packet,
                    emit_status,
                    scene,
                    emit_cancel,
                    emit_suggest,
                )
                all_packets.extend(rescued)
                if describe_only and not rescued:
                    return [], True
                if rescued:
                    return all_packets, False

            # Soft miss: radio reply instead of hard "couldn't interpret"
            reply = converse_intent(text)
            await emit_log(self.name, reply.describe_message or radio_reply(text), "info")
            return [], True

        return all_packets, False

    async def direct(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None = None,
        emit_log: EmitLog = _noop_emit,
        emit_packet: EmitPacket = _noop_packet,
        emit_status: EmitStatus = _noop_status,
        frame: SceneFrame | None = None,
        emit_preview: EmitPreview = _noop_preview,
        emit_cancel: EmitCancel = _noop_cancel,
        emit_question: EmitQuestion = _noop_question,
        emit_suggest: EmitSuggest = _noop_suggest,
    ) -> tuple[list[CommandPacket], bool]:
        """Staged execution: plan the crew's work, then stream it over time.

        Multi-clause commands stream fallback-parsed clauses immediately while
        the LLM (when configured) finishes the full sentence in parallel.

        Returns (packets, describe_only). When describe_only is True the command
        was satisfied with agent_log messages only — no error should be emitted.
        """
        clauses = split_clauses(text)
        return await self._direct_multi_clause(
            text,
            clauses,
            scene,
            command_id,
            emit_log,
            emit_packet,
            emit_status,
            frame,
            emit_preview,
            emit_cancel,
            emit_question,
            emit_suggest,
        )
