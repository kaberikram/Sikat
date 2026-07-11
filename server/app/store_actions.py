"""Editor store action signatures for the SceneAgent's call_store_action tool.

Hand-maintained mirror of the actions on useEditorStore (src/store.ts,
EditorState interface). Keep in sync when store actions change. Args are
positional JSON values; the client dispatches them unvalidated.

Conventions: Vec3 = [x, y, z]; rotations are world-space euler XYZ in radians;
colors are "#rrggbb"; times are seconds.
"""

STORE_ACTION_DOCS = """\
Editor store actions (call with positional JSON args). Vec3=[x,y,z], rotations
in radians, colors "#rrggbb", times in seconds.

OBJECTS
- addObject(obj: partial) — LOW-LEVEL: objects added without a mesh render as
  nothing. Prefer the run_commands SPAWN_OBJECT packet for new geometry.
- removeObject(id: str)
- updateObject(id: str, updates: partial {name?, position?: Vec3, rotation?: Vec3, scale?: Vec3})
- setObjectMaterial(id: str, patch {color?, emissive?, emissiveIntensity?: float, opacity?: float})
- setSubMeshTransparent(objectId: str, meshUuid: str, transparent: bool)
- setSubMeshShadow(objectId: str, meshUuid: str, castAndReceive: bool)
- setSelected(id: str | null) — select an object in the UI (null = deselect)

CAMERA / LIGHTING / STAGE
- updateCamera(updates: partial {position?: Vec3, rotation?: Vec3, fov?: float, post?: object})
- updateLighting(patch {ambient?: {color?, intensity?}, key?: {color?, intensity?, position?: Vec3}, background?: str})
- updateStage(patch {position?: Vec3, radius?: float})
- setCameraOpMode(on: bool) — first-person camera-operator mode

TIMELINE / PLAYBACK
- setTime(time: float) — move the playhead
- togglePlay() — no args; flips play/pause (check isPlaying in the scene first)
- setPlayOnceEnd(time: float | null) — stop playback at this time (null clears)
- setPlaybackLoop(loop: bool)
- setClipLoopEnd(time: float | null)

TAKES (recording)
- startTake() — roll a new take
- endTake() — cut

KEYFRAMES
- addKeyframe(objectId: str, time: float, property: "position"|"rotation"|"scale", value: Vec3)
- addCameraKeyframe(time: float, property: "position"|"rotation"|"scale"|"fov", value: Vec3)
  (fov value is [fov, 0, 0])
- setCameraPropertyKeyframes(property: "position"|"rotation"|"fov", keyframes: [{time, value: Vec3}])
- setObjectPropertyKeyframes(objectId: str, property, keyframes: [{time, value: Vec3}]) — replaces the whole track
- mergeObjectPropertyKeyframes(objectId: str, property, keyframes, fromTime: float) — replaces from fromTime forward
- snapshotObjectKeyframes(objectId: str, time: float)
- snapshotCameraKeyframes(time: float)

UI OVERLAYS
- setOverlay(overlay: "timeline"|"objects"|"export", open?: bool) — omit open to toggle
- closeAllOverlays()
- setExporting(v: bool) — pauses the scene's render loop; only for export flows

Object ids come from the scene snapshot (get_scene / tool results). Prefer the
typed run_commands packets when one exists — they clamp values and handle
keyframe/tween policy; use store actions for everything the packets can't do.\
"""
