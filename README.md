# RADIO_EDIT.EXE

A brutalist, browser-based 3D scene editor for building stylized shots with a post-processing FX stack and a keyframe timeline. Drop in a `.glb`, throw some effects on it, scrub the timeline, and export the scene as JSON.

Built with React + Three.js. No backend, no accounts, no API keys — just open it and start moving things around.

**Optional: [Director Mode](#director-mode-optional)** adds a voice/text-commanded AI crew (spawn props, relight the set, dial FX, move the camera) via a local FastAPI agent server. The editor still runs fully standalone without it.

## Product direction

Radio Edit is one app in two form factors:

### Desktop (current focus)

A conventional web-based 3D motion design tool. Arrange objects, keyframe transforms, stylize the shot through a **virtual camera**, scrub, preview, export. The main viewport shows the scene perspective; a **picture-in-picture viewfinder** in the corner shows what the virtual camera sees with all FX applied — your final-look preview.

### XR (next phase)

Same app, spatial form factor. On Quest 3 / Vision Pro: you stand in your real room, the 3D scene composites onto passthrough, and you hold a virtual camcorder whose back screen is the viewfinder. You "shoot" the scene by physically moving the camcorder — pose samples into keyframes, timeline plays them back.

The **viewfinder** is the concept that unifies both modes. On desktop it's a PiP overlay; in XR it's a mesh in your hand. **Post-processing lives on the viewfinder only** — never on the user's view of the scene. This is what makes the XR experience comfortable (no motion-sickness-inducing full-screen effects on passthrough) and gives us a clean "film stock / lens" metaphor on desktop.

**Desktop first. XR when the editing model is solid.**

## Roadmap

### Phase 1 — Desktop MVP (current)

1. **Virtual camera as a first-class entity** — separate `virtualCamera` from `userCamera` in the store, with its own transform, FOV, and FX stack.
2. **Viewfinder PiP** — small `RenderTarget` rendered from the virtual camera, drawn as a corner overlay. FX moves off `MotionObject` and onto the virtual camera.
3. **Camera-view toggle** — press `C` to fullscreen the viewfinder.
4. **Auto-keyframe / record mode** — toggle "REC"; any transform change auto-records a keyframe.
5. **Easing curves per keyframe** — `linear`, `easeIn`, `easeOut`, `easeInOut`, `step`.
6. **Undo / redo** — Zundo on top of Zustand.

Stretch: object duplication, keyboard shortcuts, scene save/load to localStorage, material editor (color + emissive + material type), video export via WebCodecs.

### Phase 2 — XR (Quest 3 / Vision Pro)

1. WebXR session + passthrough + controller/hand tracking.
2. Virtual camcorder mesh locked to a controller; viewfinder moves from PiP overlay to the camcorder's back screen (same `RenderTarget`).
3. "Record" = trigger button; keyframe sampling runs at headset framerate.
4. Playback / scrub UI reachable in-headset.

Steps 1–2 of the desktop phase are the architectural investment that makes Phase 2 a mount-point swap rather than a rewrite.

## Features

- **3D viewport** with orbit camera and a translate gizmo for moving objects
- **Object library**: add primitives (box, sphere), text tags, or import your own `.gltf` / `.glb` models (Draco-compressed models supported)
- **Keyframe timeline**: scrub, play, and record position / rotation / scale keyframes per object
- **Per-object post-processing stack**:
  - `BLOOM` — UnrealBloom with surface glow controls
  - `PIXELATE` — pixel-art render pass with normal/depth edge detection
  - `CELL_SHADING` — back-face outline shell for toon looks
  - `GLITCH` — jitter on position at a configurable rate
  - `DITHER` — Bayer-dithered, quantized color with optional monochrome
- **JSON export** of the full scene (transforms, keyframes, FX settings)

## Tech Stack

- **React 19** + **TypeScript** + **Vite**
- **Three.js** (WebGL renderer, EffectComposer, custom ShaderPass)
- **Zustand** for editor state
- **Tailwind CSS v4** + **Motion** for the UI
- **lucide-react** for icons

## Run Locally

**Prerequisites:** Node.js 18+

```bash
npm install
npm run dev
```

The app runs on [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` — start the Vite dev server
- `npm run build` — production build
- `npm run preview` — preview the production build
- `npm run lint` — typecheck with `tsc --noEmit`
- `npm run clean` — remove `dist/`

## Project Structure

```
src/
  Editor.tsx      — Toolbar, Outliner, Properties, Timeline, Editor shell
  Scene.tsx       — Three.js scene, composer passes, animation loop
  store.ts        — Zustand store (objects, keyframes, lighting, FX state)
  gltf-loader.ts  — GLTFLoader wired up with Draco decoder
  index.css       — Tailwind + brutalist theme tokens
  director/       — Director Mode client (socket, applier, tween, console)
server/           — Director Mode agent server (FastAPI, optional)
docs/DirectorAI/  — Obsidian-compatible vault: PRD, protocol, agent profiles
public/
  draco/          — Draco decoder assets for compressed glTF models
```

## Director Mode (optional)

Direct the scene like a film set: a **DIRECTOR_LINK** console appears in the
viewport, and an AI crew (Producer, Director's Assistant, Lighting Tech, Asset
Animator, VFX Operator) turns instructions into live scene changes over a
WebSocket — `"add a red box then dim the lights"`, `"sunset mood"`,
`"move the box up 2 over 3 seconds"`, `"turnaround the sphere"`, `"enable bloom"`.

```bash
# Terminal A — agent server (requires uv; https://docs.astral.sh/uv/)
cd server && uv sync && uv run uvicorn app.main:app --port 8000

# Terminal B — the editor as usual
npm run dev
```

Works with **no API key** via a deterministic command grammar. Set
`ANTHROPIC_API_KEY` for free-form phrasing (Claude structured outputs; the
grammar remains the fallback). Chromium-based browsers also get a mic button
for spoken direction.

Extras:

- `cd server && uv run pytest` — agent/parser/protocol test suite
- `uv run python scripts/mock_telemetry.py --duration 15` — simulated camera
  operator orbiting the stage (drives the virtual camera through the same path
  a headset will use in the XR phase)
- Protocol + architecture docs: `docs/DirectorAI/` (Obsidian-compatible vault)

Director Mode respects the architectural invariants below: agents mutate the
Zustand store only, and FX changes land exclusively on the viewfinder.

## Notes

- Draco decoder files live in `public/draco/` so compressed `.glb` files load without a CDN round-trip.
- The post-processing passes are aggregated across all objects that have a given effect enabled — per-object effect state drives a single shared pipeline for performance.

## Renderer & XR strategy

**WebGL today. WebGPU later, only once WebXR-on-WebGPU is stable on Quest browser.**

The scene runs on `THREE.WebGLRenderer` + `EffectComposer`. WebXR on Quest 3 currently rides WebGL2, and Three.js's WebGL XR path is years more mature than its WebGPU XR path. Swapping renderers now would slow XR, not speed it up.

### Architectural invariants (read before adding features)

1. **`src/Scene.tsx` is the only renderer-aware module.** `Editor.tsx`, `store.ts`, and the FX config types stay agnostic to WebGL / WebGPU / WebXR. Never reach for renderer or composer APIs from UI code.

2. **Post-processing is per-camera ("lens"), never per-scene or per-world-render.**
   - The user's view (passthrough + scene) stays clean. No bloom, no pixelate, nothing — on any device.
   - Effects only apply to the **viewfinder render target** attached to the virtual camcorder.
   - This keeps the XR experience comfortable (no motion-sickness inducing full-screen effects) and gives us the "film stock" metaphor for free.

3. **Two cameras, not one.**
   - `userCamera` — what the viewer sees. Stereo under WebXR, mono on desktop. No FX.
   - `virtualCamera` — the camcorder. Renders into a small RT shown as the viewfinder texture. This is the camera whose pose the timeline records.

4. **New FX = declarative config on the camera's FX stack**, wired up inside `Scene.tsx`. No exceptions.

A full WebGPU migration checklist (with XR gating criteria) lives at the top of `src/Scene.tsx`.
