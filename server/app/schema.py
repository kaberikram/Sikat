"""Wire contract for RADIO_EDIT.EXE Director Mode.

Normative copy of the protocol lives in
docs/DirectorAI/03_PRD_Architecture/Command_Protocol.md and is mirrored on the
frontend by src/director/protocol.ts — keep all three in sync.

Conventions:
- rotations are world-space euler XYZ in **radians** (store convention)
- colors are "#rrggbb" hex strings
- numeric FX/light values are clamped (not rejected) to the editor's slider
  ranges so an over-eager agent can never produce an invalid scene
"""
from __future__ import annotations

import time
from typing import Annotated, Literal, Union

from pydantic import (
    AfterValidator,
    BaseModel,
    Field,
    TypeAdapter,
    model_validator,
)

# ---------------------------------------------------------------------------
# Shared primitives
# ---------------------------------------------------------------------------

Vec3 = tuple[float, float, float]
HexColor = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
Easing = Literal["linear", "easeIn", "easeOut", "easeInOut"]
FxSection = Literal["bloom", "pixelate", "cellShading", "glitch", "dither"]
Primitive = Literal["box", "sphere", "cone", "cylinder", "torus", "plane", "text", "sneaker"]
AgentName = Literal[
    "Producer",
    "DirectorsAssistant",
    "LightingTech",
    "AssetAnimator",
    "VFXOperator",
    "Agent1",
    "Agent2",
    "Agent3",
    "Agent4",
]
CancelReason = Literal["supersede", "stop", "amend"]


def now() -> float:
    return time.time()


def _clamp(lo: float, hi: float) -> AfterValidator:
    def check(v):
        return min(hi, max(lo, v))

    return AfterValidator(check)


class Transition(BaseModel):
    durationSec: Annotated[float, _clamp(0.05, 60.0)] = 1.0
    easing: Easing = "easeInOut"


class Target(BaseModel):
    """Object address; resolved client-side (id, exact name, then substring)."""

    id: str | None = None
    name: str | None = None

    @model_validator(mode="after")
    def _addressable(self) -> "Target":
        if not self.id and not self.name:
            raise ValueError("target requires an id or a name")
        return self


# ---------------------------------------------------------------------------
# Command payloads
# ---------------------------------------------------------------------------


class SpawnObjectPayload(BaseModel):
    primitive: Primitive
    id: str | None = None
    name: str | None = None
    color: HexColor | None = None
    text: str | None = None
    position: Vec3 | None = None
    rotation: Vec3 | None = None
    scale: Vec3 | None = None


class RemoveObjectPayload(BaseModel):
    target: Target


class TransformObjectPayload(BaseModel):
    target: Target
    mode: Literal["absolute", "relative"] = "absolute"
    position: Vec3 | None = None
    rotation: Vec3 | None = None
    scale: Vec3 | None = None


class AnimateObjectPayload(BaseModel):
    target: Target
    preset: Literal["turnaround", "orbit", "bounce"] | None = None
    """Legacy preset ids — use `motion` for generative tracks."""
    motion: str | None = None
    """Parametric motion id (float, drop, arc, pulse, …) or alias."""
    params: dict[str, float] | None = None
    durationSec: Annotated[float, _clamp(0.5, 60.0)] | None = None
    repeat: bool | None = False


class MoveCameraPayload(BaseModel):
    position: Vec3 | None = None
    rotation: Vec3 | None = None
    lookAt: Vec3 | None = None
    lookAtTarget: Target | None = None
    fov: Annotated[float, _clamp(5.0, 120.0)] | None = None


class AmbientLightPatch(BaseModel):
    color: HexColor | None = None
    intensity: Annotated[float, _clamp(0.0, 4.0)] | None = None


class KeyLightPatch(BaseModel):
    color: HexColor | None = None
    intensity: Annotated[float, _clamp(0.0, 8.0)] | None = None
    position: Vec3 | None = None


class UpdateLightsPayload(BaseModel):
    ambient: AmbientLightPatch | None = None
    key: KeyLightPatch | None = None
    background: HexColor | None = None


class SetMaterialPayload(BaseModel):
    target: Target
    color: HexColor | None = None
    emissive: HexColor | None = None
    emissiveIntensity: Annotated[float, _clamp(0.0, 5.0)] | None = None
    opacity: Annotated[float, _clamp(0.0, 1.0)] | None = None


# FX patches mirror the slider ranges in Editor.tsx POST_STACK_SECTIONS.


class BloomPatch(BaseModel):
    enabled: bool | None = None
    strength: Annotated[float, _clamp(0.0, 2.5)] | None = None
    threshold: Annotated[float, _clamp(0.0, 1.0)] | None = None
    radius: Annotated[float, _clamp(0.0, 1.0)] | None = None
    emissiveBoost: Annotated[float, _clamp(0.0, 1.5)] | None = None
    emissiveIntensity: Annotated[float, _clamp(0.0, 3.0)] | None = None


class PixelatePatch(BaseModel):
    enabled: bool | None = None
    pixelSize: Annotated[int, _clamp(2, 24)] | None = None
    normalEdge: Annotated[float, _clamp(0.0, 0.8)] | None = None
    depthEdge: Annotated[float, _clamp(0.0, 0.8)] | None = None


class CellShadingPatch(BaseModel):
    enabled: bool | None = None
    outlineScale: Annotated[float, _clamp(1.0, 1.18)] | None = None


class GlitchPatch(BaseModel):
    enabled: bool | None = None
    intensity: Annotated[float, _clamp(0.0, 0.5)] | None = None
    rate: Annotated[float, _clamp(0.0, 0.35)] | None = None


class DitherPatch(BaseModel):
    enabled: bool | None = None
    pixelSize: Annotated[int, _clamp(1, 10)] | None = None
    levels: Annotated[int, _clamp(2, 16)] | None = None
    strength: Annotated[float, _clamp(0.0, 1.0)] | None = None
    monochrome: bool | None = None


class FxBloomPayload(BaseModel):
    section: Literal["bloom"] = "bloom"
    patch: BloomPatch


class FxPixelatePayload(BaseModel):
    section: Literal["pixelate"] = "pixelate"
    patch: PixelatePatch


class FxCellShadingPayload(BaseModel):
    section: Literal["cellShading"] = "cellShading"
    patch: CellShadingPatch


class FxGlitchPayload(BaseModel):
    section: Literal["glitch"] = "glitch"
    patch: GlitchPatch


class FxDitherPayload(BaseModel):
    section: Literal["dither"] = "dither"
    patch: DitherPatch


UpdateFxPayload = Annotated[
    Union[
        FxBloomPayload,
        FxPixelatePayload,
        FxCellShadingPayload,
        FxGlitchPayload,
        FxDitherPayload,
    ],
    Field(discriminator="section"),
]


class Keyframe(BaseModel):
    time: Annotated[float, _clamp(0.0, 600.0)]
    value: Vec3


class SetKeyframesPayload(BaseModel):
    target: Target | None = None
    """None targets the virtual camera."""
    property: Literal["position", "rotation", "scale", "fov"]
    keyframes: list[Keyframe]


class PlaybackPayload(BaseModel):
    action: Literal["play", "pause", "seek", "record", "cut", "loop_on", "loop_off"]
    time: float | None = None


class CallStoreActionPayload(BaseModel):
    """Generic client store dispatch — args are validated client-side only.

    Deliberately unconstrained: the SceneAgent uses this to reach editor
    actions that have no dedicated packet (overlays, takes, camera-op mode…).
    Signatures are documented in store_actions.py / src/store.ts.
    """

    action: str = Field(min_length=1)
    args: list = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Command packets (PRD shape, discriminated on `command`)
# ---------------------------------------------------------------------------


class _PacketBase(BaseModel):
    timestamp: float = Field(default_factory=now)
    commandId: str | None = None
    transition: Transition | None = None
    refinement: bool = False
    priorCommandId: str | None = None


class SpawnObjectPacket(_PacketBase):
    command: Literal["SPAWN_OBJECT"] = "SPAWN_OBJECT"
    target_agent: AgentName = "AssetAnimator"
    payload: SpawnObjectPayload


class RemoveObjectPacket(_PacketBase):
    command: Literal["REMOVE_OBJECT"] = "REMOVE_OBJECT"
    target_agent: AgentName = "AssetAnimator"
    payload: RemoveObjectPayload


class TransformObjectPacket(_PacketBase):
    command: Literal["TRANSFORM_OBJECT"] = "TRANSFORM_OBJECT"
    target_agent: AgentName = "AssetAnimator"
    payload: TransformObjectPayload


class AnimateObjectPacket(_PacketBase):
    command: Literal["ANIMATE_OBJECT"] = "ANIMATE_OBJECT"
    target_agent: AgentName = "AssetAnimator"
    payload: AnimateObjectPayload


class MoveCameraPacket(_PacketBase):
    command: Literal["MOVE_CAMERA"] = "MOVE_CAMERA"
    target_agent: AgentName = "AssetAnimator"
    payload: MoveCameraPayload


class UpdateLightsPacket(_PacketBase):
    command: Literal["UPDATE_LIGHTS"] = "UPDATE_LIGHTS"
    target_agent: AgentName = "LightingTech"
    payload: UpdateLightsPayload


class SetMaterialPacket(_PacketBase):
    command: Literal["SET_MATERIAL"] = "SET_MATERIAL"
    target_agent: AgentName = "LightingTech"
    payload: SetMaterialPayload


class UpdateFxPacket(_PacketBase):
    command: Literal["UPDATE_FX"] = "UPDATE_FX"
    target_agent: AgentName = "VFXOperator"
    payload: UpdateFxPayload


class SetKeyframesPacket(_PacketBase):
    command: Literal["SET_KEYFRAMES"] = "SET_KEYFRAMES"
    target_agent: AgentName = "AssetAnimator"
    payload: SetKeyframesPayload


class PlaybackPacket(_PacketBase):
    command: Literal["PLAYBACK"] = "PLAYBACK"
    target_agent: AgentName = "Producer"
    payload: PlaybackPayload


class CallStoreActionPacket(_PacketBase):
    command: Literal["CALL_STORE_ACTION"] = "CALL_STORE_ACTION"
    target_agent: AgentName = "Producer"
    payload: CallStoreActionPayload


CommandPacket = Annotated[
    Union[
        SpawnObjectPacket,
        RemoveObjectPacket,
        TransformObjectPacket,
        AnimateObjectPacket,
        MoveCameraPacket,
        UpdateLightsPacket,
        SetMaterialPacket,
        UpdateFxPacket,
        SetKeyframesPacket,
        PlaybackPacket,
        CallStoreActionPacket,
    ],
    Field(discriminator="command"),
]

command_packet_adapter: TypeAdapter = TypeAdapter(CommandPacket)


# ---------------------------------------------------------------------------
# Client -> server messages
# ---------------------------------------------------------------------------


class MaterialOverrideSnapshot(BaseModel):
    color: HexColor | None = None
    emissive: HexColor | None = None
    emissiveIntensity: float | None = None
    opacity: float | None = None


class KeyframeTrackSummary(BaseModel):
    property: Literal["position", "rotation", "scale", "fov"]
    keyframeCount: int


class KeyframePoint(BaseModel):
    time: float
    value: Vec3


class KeyframeTrackFull(BaseModel):
    property: Literal["position", "rotation", "scale", "fov"]
    keyframes: list[KeyframePoint]


KeyframeTrack = Annotated[
    Union[KeyframeTrackSummary, KeyframeTrackFull],
    Field(discriminator=None),
]


class SampledTransform(BaseModel):
    position: Vec3
    rotation: Vec3
    scale: Vec3


class ObjectSnapshot(BaseModel):
    id: str
    name: str
    position: Vec3 = (0.0, 0.0, 0.0)
    rotation: Vec3 = (0.0, 0.0, 0.0)
    scale: Vec3 = (1.0, 1.0, 1.0)
    sampled: SampledTransform = Field(
        default_factory=lambda: SampledTransform(
            position=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)
        )
    )
    keyframedProperties: list[str] = Field(default_factory=list)
    tracks: list[KeyframeTrackSummary | KeyframeTrackFull] = Field(default_factory=list)
    materialOverride: MaterialOverrideSnapshot | None = None


class FxSummary(BaseModel):
    enabledSections: list[FxSection] = Field(default_factory=list)
    bloomStrength: float | None = None
    ditherLevels: int | None = None


STAGE_RADIUS = 1.0


def _default_virtual_camera_position() -> tuple[float, float, float]:
    # Mirrors defaultVirtualCameraPosition in src/store.ts.
    return (0.0, STAGE_RADIUS * 0.16, STAGE_RADIUS * 0.64)


# Mirrors DEFAULT_VIRTUAL_CAM_ROTATION in src/store.ts (slight downward pitch).
_DEFAULT_VIRTUAL_CAM_ROTATION = (-0.2, 0.0, 0.0)


def _default_key_light_position() -> tuple[float, float, float]:
    return (STAGE_RADIUS * 2, STAGE_RADIUS * 4, STAGE_RADIUS * 2.8)


class VirtualCameraSnapshot(BaseModel):
    position: Vec3 = Field(default_factory=lambda: _default_virtual_camera_position())
    rotation: Vec3 = _DEFAULT_VIRTUAL_CAM_ROTATION
    fov: float = 50.0
    sampled: SampledTransform = Field(
        default_factory=lambda: SampledTransform(
            position=_default_virtual_camera_position(),
            rotation=_DEFAULT_VIRTUAL_CAM_ROTATION,
            scale=(1.0, 1.0, 1.0),
        )
    )
    sampledFov: float = 50.0
    keyframedProperties: list[str] = Field(default_factory=list)
    tracks: list[KeyframeTrackSummary | KeyframeTrackFull] = Field(default_factory=list)
    fx: FxSummary = Field(default_factory=FxSummary)


class SceneLightingSnapshot(BaseModel):
    ambient: AmbientLightPatch
    key: KeyLightPatch
    background: HexColor


class StageSnapshot(BaseModel):
    position: Vec3 = (0.0, 0.0, 0.0)
    radius: float = STAGE_RADIUS


class SceneState(BaseModel):
    type: Literal["scene_state"] = "scene_state"
    timestamp: float = Field(default_factory=now)
    mode: Literal["heartbeat", "full"] = "heartbeat"
    currentTime: float = 0.0
    duration: float = 10.0
    isPlaying: bool = False
    isRolling: bool = False
    takeStartTime: float = 0.0
    selectedId: str | None = None
    stage: StageSnapshot = Field(default_factory=StageSnapshot)
    objects: list[ObjectSnapshot] = Field(default_factory=list)
    virtualCamera: VirtualCameraSnapshot = Field(default_factory=VirtualCameraSnapshot)
    lighting: SceneLightingSnapshot = Field(
        default_factory=lambda: SceneLightingSnapshot(
            ambient=AmbientLightPatch(color="#ffffff", intensity=0.8),
            key=KeyLightPatch(
                color="#ffffff",
                intensity=1.5,
                position=_default_key_light_position(),
            ),
            background="#f2f2f2",
        )
    )


class SceneFrame(BaseModel):
    mime: Literal["image/jpeg"] = "image/jpeg"
    width: int
    height: int
    data: str
    capturedAt: float


class UserCommand(BaseModel):
    type: Literal["user_command"] = "user_command"
    timestamp: float = Field(default_factory=now)
    text: str = Field(min_length=1)
    commandId: str | None = None
    scene: SceneState | None = None
    frame: SceneFrame | None = None
    # Point + speak: the object the director is physically aiming at (XR).
    targetHint: Target | None = None


class TelemetryPose(BaseModel):
    position: Vec3
    rotation: Vec3 | None = None
    fov: float | None = None


class Telemetry(BaseModel):
    type: Literal["telemetry"] = "telemetry"
    timestamp: float = Field(default_factory=now)
    source: str = "mock_camera"
    pose: TelemetryPose


class AgentToolResult(BaseModel):
    """Client's reply to one agent_tool_use round trip (SceneAgent loop)."""

    type: Literal["agent_tool_result"] = "agent_tool_result"
    timestamp: float = Field(default_factory=now)
    commandId: str
    requestId: str
    ok: bool = True
    results: list[str] = Field(default_factory=list)
    scene: SceneState | None = None
    frame: SceneFrame | None = None


class AgentAbort(BaseModel):
    """User stopped an in-flight SceneAgent session (e.g. said "cut")."""

    type: Literal["agent_abort"] = "agent_abort"
    timestamp: float = Field(default_factory=now)
    commandId: str


ClientMessage = Annotated[
    Union[UserCommand, SceneState, Telemetry, AgentToolResult, AgentAbort],
    Field(discriminator="type"),
]
client_message_adapter: TypeAdapter = TypeAdapter(ClientMessage)


# ---------------------------------------------------------------------------
# Server -> client message builders
# ---------------------------------------------------------------------------


def agent_command_message(packet) -> dict:
    return {"type": "agent_command", "timestamp": now(), "packet": packet.model_dump()}


AgentToolName = Literal["run_commands", "call_store_action", "get_scene", "capture_frame"]


def agent_tool_use_message(
    command_id: str, request_id: str, tool: AgentToolName, payload: dict
) -> dict:
    """One SceneAgent tool invocation for the client to execute. Sent to the
    owning websocket only — never broadcast (a second client would double-run it)."""
    return {
        "type": "agent_tool_use",
        "timestamp": now(),
        "commandId": command_id,
        "requestId": request_id,
        "tool": tool,
        "payload": payload,
    }


def agent_status_message(
    agent: str,
    status: str,
    for_command_id: str | None = None,
    note: str | None = None,
) -> dict:
    """Cursor-presence lifecycle event: an agent became ``active`` or ``idle``.

    Semantic only — the client derives the cursor's 3D target from the
    ``agent_command`` packets that ride alongside these events.
    """
    return {
        "type": "agent_status",
        "timestamp": now(),
        "agent": agent,
        "status": status,
        "forCommandId": for_command_id,
        "note": note,
    }


def agent_log_message(
    agent: str,
    message: str,
    level: str = "info",
    for_command_id: str | None = None,
    kind: str | None = None,
) -> dict:
    """`kind` marks machine-readable log classes the client renders specially:
    'reply' = a direct director answer to the user; 'miss' = didn't understand.
    """
    msg = {
        "type": "agent_log",
        "timestamp": now(),
        "agent": agent,
        "level": level,
        "message": message,
        "forCommandId": for_command_id,
    }
    if kind is not None:
        msg["kind"] = kind
    return msg


def error_message(message: str, for_command_id: str | None = None) -> dict:
    return {
        "type": "error",
        "timestamp": now(),
        "message": message,
        "forCommandId": for_command_id,
    }


def command_cancel_message(
    command_id: str,
    *,
    superseded_by: str | None = None,
    target: Target | None = None,
    command: str | None = None,
    reason: CancelReason = "supersede",
) -> dict:
    payload: dict = {
        "type": "command_cancel",
        "timestamp": now(),
        "commandId": command_id,
        "reason": reason,
    }
    if superseded_by:
        payload["supersededBy"] = superseded_by
    if target is not None:
        payload["target"] = target.model_dump(exclude_none=True)
    if command:
        payload["command"] = command
    return payload


def agent_question_message(
    agent: str,
    command_id: str,
    question: str,
    options: list[str],
) -> dict:
    return {
        "type": "agent_question",
        "timestamp": now(),
        "agent": agent,
        "commandId": command_id,
        "question": question,
        "options": options,
    }


SuggestionKind = Literal["observation", "suggestion", "reaction"]


def agent_suggestion_message(
    agent: str,
    suggestion_id: str,
    text: str,
    *,
    suggested_command: str | None = None,
    subject_object: str | None = None,
    kind: SuggestionKind = "observation",
) -> dict:
    payload: dict = {
        "type": "agent_suggestion",
        "timestamp": now(),
        "suggestionId": suggestion_id,
        "agent": agent,
        "text": text,
        "kind": kind,
    }
    if suggested_command:
        payload["suggestedCommand"] = suggested_command
    if subject_object:
        payload["subjectObject"] = subject_object
    return payload


def intent_preview_message(
    command_id: str,
    agent: str,
    note: str,
    *,
    target: str | None = None,
    action: str | None = None,
    motion: str | None = None,
    confidence: IntentPreviewConfidence = "grammar",
) -> dict:
    """Fast acknowledge before full parse — client moves cursor immediately."""
    return {
        "type": "intent_preview",
        "timestamp": now(),
        "commandId": command_id,
        "agent": agent,
        "target": target,
        "action": action,
        "motion": motion,
        "note": note,
        "confidence": confidence,
    }


PlanUpdateStatus = Literal[
    "planning",
    "escalating",
    "step_start",
    "step_done",
    "adjusting",
    "pitched",
    "done",
]


def plan_update_message(
    command_id: str,
    *,
    status: PlanUpdateStatus,
    say: str | None = None,
    mode: str | None = None,
    step_index: int | None = None,
    steps_total: int | None = None,
    step_label: str | None = None,
) -> dict:
    """Progress from the Director planning loop; not a CommandPacket."""
    return {
        "type": "plan_update",
        "timestamp": now(),
        "commandId": command_id,
        "status": status,
        "say": say,
        "mode": mode,
        "stepIndex": step_index,
        "stepsTotal": steps_total,
        "stepLabel": step_label,
    }


# ---------------------------------------------------------------------------
# Director's Assistant intermediate representation
# ---------------------------------------------------------------------------

IntentAction = Literal[
    "spawn",
    "remove",
    "transform",
    "animate",
    "move_camera",
    "update_lights",
    "set_material",
    "update_fx",
    "playback",
    "set_scene",
    "describe",
    "assign",
    "clarify",
    "suggest",
]


class FxSetting(BaseModel):
    key: str
    value: float


class Intent(BaseModel):
    """Flat, structured-output-friendly parse of one director instruction.

    Only the fields relevant to `action` are set; specialists ignore the rest.
    Kept free of range constraints so the LLM structured-output schema stays
    simple — clamping happens when specialists build CommandPackets.
    """

    action: IntentAction
    target: str | None = None
    addressee: int | None = None
    role: str | None = None
    transition: Transition | None = None
    snap_motion: bool | None = None
    """When true, omit default transition injection (director said snap/instantly)."""
    freeze_motion: bool | None = None
    """When true with playback pause, cancel in-flight animate on last target."""
    say: str | None = None
    """In-character film-set radio line for this intent (server-internal —
    not part of the wire protocol; producer emits it as the cursor note)."""
    # spawn
    primitive: Primitive | None = None
    color: HexColor | None = None
    name: str | None = None
    text: str | None = None
    # transform / spawn / move_camera (rotations in radians)
    position: Vec3 | None = None
    rotation: Vec3 | None = None
    scale: Vec3 | None = None
    mode: Literal["absolute", "relative"] | None = None
    # animate — preset (legacy) or generative motion + params
    preset: Literal["turnaround", "orbit", "bounce"] | None = None
    motion: str | None = None
    motion_params: dict[str, float] | None = None
    animate_repeat: bool | None = None
    track_property: Literal["position", "rotation", "scale"] | None = None
    track_keyframes: list[Keyframe] | None = None
    # move_camera
    look_at: str | None = None
    fov: float | None = None
    # update_lights
    ambient_color: HexColor | None = None
    ambient_intensity: float | None = None
    key_color: HexColor | None = None
    key_intensity: float | None = None
    key_position: Vec3 | None = None
    background: HexColor | None = None
    # set_material
    emissive: HexColor | None = None
    emissive_intensity: float | None = None
    opacity: float | None = None
    # update_fx
    section: FxSection | None = None
    fx_enabled: bool | None = None
    fx_set: list[FxSetting] | None = None
    # playback
    playback_action: Literal["play", "pause", "seek", "record", "cut", "loop_on", "loop_off"] | None = None
    seek_time: float | None = None
    playback_pause_after_seek: bool | None = None
    # set_scene
    mood: str | None = None
    # describe
    describe_topic: (
        Literal["scene", "animation", "lighting", "fx", "camera", "object"] | None
    ) = None
    describe_message: str | None = None
    # clarify (server-internal — surfaced as agent_question wire message)
    clarify_question: str | None = None
    clarify_options: list[str] | None = None
    # suggest (server-internal — surfaced as agent_suggestion after command)
    suggestion_command: str | None = None


class IntentList(BaseModel):
    intents: list[Intent] = Field(default_factory=list)


PlanMode = Literal["execute", "pitch", "amend", "surprise"]


class PlanStep(Intent):
    """One executable instruction in a whole-utterance Director plan."""

    agent: str | None = None


class DirectorPlan(BaseModel):
    """The streamed planning envelope emitted by the Director LLM."""

    say: str | None = None
    mode: PlanMode = "execute"
    needs_deeper_creativity: bool = False
    steps: list[PlanStep] = Field(default_factory=list, max_length=6)
