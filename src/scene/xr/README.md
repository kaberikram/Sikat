# XR input — @iwsdk/xr-input

Sikat uses **selective** Immersive Web SDK adoption: `@iwsdk/xr-input` for controller/hand spaces and visuals only.

## Why not full IWSDK

Full `@iwsdk/core` (`World.create`) owns the renderer, camera, and animation loop and makes ECS Transform the source of truth. That conflicts with:

- Zustand scene state
- Dual cameras (`userCamera` vs `virtualCamera`)
- Viewfinder-only FX on a render target
- React HTML overlays + Director WebSocket crew

## What we use

| Piece | Source |
|-------|--------|
| Session (`immersive-ar` → `immersive-vr`) | [`xr-session.ts`](./xr-session.ts) |
| Exit session | [`xr-bridge.ts`](./xr-bridge.ts) `endXrSession()` + **EXIT XR** button in Editor |
| Chrome emulator Layers compat | [`xr-compat.ts`](./xr-compat.ts) |
| Grip / ray / head spaces + controller GLTF | `@iwsdk/xr-input` `XRInputManager` |
| Camcorder screen + virt cam pose + REC | [`camcorder-rig.ts`](./camcorder-rig.ts) |
| Viewfinder RT (same FX as desktop PiP) | [`xr-viewfinder.ts`](./xr-viewfinder.ts) + `viewfinder-pass.ts` |
| Post-cut take review monitor | [`review-screen.ts`](./review-screen.ts) |

## Wiring

1. `bootstrap.ts` — `createCamcorderRig` + `createReviewScreen`; cut handler opens review.
2. `animate-loop.ts` (XR frames) — camcorder update → grip LCD RT → review playback RT (if open).
3. Camcorder group is parented to `xrOrigin.gripSpaces.right`.
4. REC: `gamepads.right.getButtonDown(InputComponent.Trigger)` or `getSelectStart()` (suppressed while review is open).
5. Controller/hand meshes forced to **EDITOR_LAYER (3)** so they never appear in the virtual cam film.
   **Do not use layers 1 or 2** — Three.js WebXR reserves those for left/right eye cameras; objects on layer 1 only draw in the left eye.

## Dual monitors

| Surface | Camera source | Purpose |
|---------|---------------|---------|
| Grip LCD | Live right-grip pose | Record / aim |
| Floating review panel | Timeline keyframes (`playbackCam`) | Watch the take after cut |

Both film **studio CG** (white `#f2f2f2`), never passthrough. Passthrough is headset eyes only.

**UI chrome:** XR panels use the same desktop pastel-glass tokens (ink `#3B3A48`, candy accents `#FFC43D` / `#57CFA0` / `#5EAEF2` / `#F27BAC`, translucent white cards) via canvas textures in [`xr-ui-chrome.ts`](./xr-ui-chrome.ts) — Three.js meshes can't use CSS. Cards are visionOS-style faux frost drawn by `drawGlassCard`: rounded translucent fill + painted soft shadow, so every texture reserves a transparent `pad` margin for shadow bleed and its material must stay `transparent: true`. Buttons are pastel pills whose hover is a soft glow + lighten (never inversion); labels render in "Baloo 2", preloaded via `preloadXrUiFonts()` at app boot so canvases don't rasterize the fallback font.

## Exit XR (emulator)

- In-app **EXIT XR** button (top-left) while presenting — calls `session.end()`.
- Emulator panel Exit / End session, or **Esc**, also works.

## Right-hand controls

| Input | Action |
|-------|--------|
| **Trigger** | REC / cut take |
| **Hold A** | Push-to-talk → Director crew (Web Speech → `user_command`) |

A compact DIRECTOR slate sits under the grip LCD: status (`DIRECTOR` / `LISTENING` / `OFFLINE`) + white transcript box (live interim while holding A, last sent after release). Reuses [`voice-session.ts`](../../director/voice-session.ts) + [`director-command.ts`](../../director/director-command.ts) — same path as the desktop mic, not a separate realtime voice API.

## Review screen controls (v1)

After cut, a ~1.2×0.675 m panel appears ~1.8 m in front of the headset and auto-plays the take once.

- **Trigger** on PLAY / scrub / X — play-pause, seek, dismiss
- **Squeeze** on frame — grab-move
- **Squeeze** on blue corner cube — scale

## Peers / versions

- `@iwsdk/xr-input@0.4.2` peer: `three >= 0.160` (Sikat: `three@^0.184`)
- Node engines on the package prefer Node 20.19+ / 22.12+ / 24+
- Bundle cost: XR input + visuals add ~300KB gzip to the main chunk; acceptable for Quest

## Out of scope (for now)

- Full desktop timeline UI in XR
- Ray/grab pointers (`pointerSettings.enabled: false`) — review uses raycast hit-tests only
- UIKitML spatial UI
- Locomotion / physics / scene understanding
- IWSDK MCP coding-agent tooling (separate from Director crew)

## Manual verify checklist

- [ ] Chrome Immersive Web Emulator: ENTER XR → screen tracks right grip
- [ ] EXIT XR button ends session without refresh
- [ ] Viewfinder shows studio CG / white bg (not black, not passthrough)
- [ ] Trigger toggles TAKE / REC — blinking red dot on LCD while rolling
- [ ] Cut → floating review screen appears, plays camera path on studio bg
- [ ] PLAY / scrub / dismiss / grab-move / corner-scale work
- [ ] Grip LCD stays live aim; review shows timeline playback
- [ ] Hold A → slate LISTENING + live STT; release stops mic; finals reach crew when server up
- [ ] Quest Browser: same, with passthrough on headset view only
