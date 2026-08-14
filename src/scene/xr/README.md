# XR input — @iwsdk/xr-input

Sikat uses **selective** Immersive Web SDK adoption: `@iwsdk/xr-input` for controller/hand spaces and visuals only.

## Response invariants (read before adding feedback)

The set answers by changing, not by captioning. Full argument in
[`docs/Thesis/Ambient_Design_Principles.md`](../../../docs/Thesis/Ambient_Design_Principles.md);
the rules that bind code in this directory:

1. **No text-to-speech, ever.** Not optional, not behind a flag. Feedback is
   change, synthesized earcons ([`sound.ts`](../../director/sound.ts)), and
   haptics.
2. **Route every system response through [`ambient-channel.ts`](./ambient-channel.ts).**
   Do not call slate methods directly from new code — the routing policy lives in
   one module so "slate as fallback" does not decay one call site at a time.
3. **The slate is for what the world cannot say.** Blocked mic, dropped link,
   missing controller, coach lines, a second consecutive miss, and words a person
   wrote. That list is short on purpose.
4. **Attention travels before action.** Anything that will change an object
   lights that object first ([`attention-field.ts`](./attention-field.ts)).
5. **Nothing proactive commits on its own.** Suggestions are ghosts until a voice
   takes them up ([`proposal-ghost.ts`](../../director/proposal-ghost.ts)), and
   they never interrupt a director mid-move
   ([`ambient-sense.ts`](./ambient-sense.ts)).
6. **Nothing autonomous happens without a visible author.** Crew cursors carry
   attribution; `undo that` stays the net.
7. **State draw calls and per-frame allocation for anything new.** 72Hz on a
   standalone headset — an ambient layer that drops frames is not calm, it is
   broken.

**Ownership:** [`room-response.ts`](./room-response.ts) is the sole writer of the
stage marker's tint. Two writers on one material is how a ring ends up stuck mint
after a strike.

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

**UI chrome:** XR panels use the same desktop Figma tokens (ink `#17171a`, accent `#2c6bf5`, white floating cards) via canvas textures in [`xr-ui-chrome.ts`](./xr-ui-chrome.ts) — Three.js meshes can't use CSS. Cards are visionOS-style faux frost drawn by `drawGlassCard`: rounded translucent fill + painted soft shadow, so every texture reserves a transparent `pad` margin for shadow bleed and its material must stay `transparent: true`. Buttons are wash/ink pills whose hover is a soft glow + lighten (never inversion); labels render in Nunito, preloaded via `preloadXrUiFonts()` at app boot so canvases don't rasterize the fallback font.

## Exit XR (emulator)

- In-app **EXIT XR** button (top-left) while presenting — calls `session.end()`.
- Emulator panel Exit / End session, or **Esc**, also works.

## Right-hand controls

| Input | Action |
|-------|--------|
| **Trigger** | REC / cut take |
| **Hold A** | Push-to-talk → Director crew (Web Speech → `user_command`) |

A larger DIRECTOR slate hangs under the grip LCD: status (`DIRECTOR` / `LISTENING` / `OFFLINE`) + live transcript while holding A (ambient mode no longer hides listening/sending). Release keeps the captured line until the final lands. Reuses [`voice-session.ts`](../../director/voice-session.ts) + [`director-command.ts`](../../director/director-command.ts) — same path as the desktop mic, not a separate realtime voice API.

## Review screen controls

After cut, a ~1.2×0.675 m panel appears ~1.8 m in front of the headset and auto-plays the take once. No controller pointer / ray hit-tests — face buttons and stick only.

| Input | Action |
|-------|--------|
| **B tap** | Play / pause |
| **Hold B** (~400ms) | Close monitor |
| **Thumbstick X** | Scrub within the take |
| **Squeeze** | Grab-move panel |
| **Squeeze + thumbstick Y** | Scale panel (0.5–2.5×) |

Trigger stays REC (still suppressed while the monitor is open). Hold A stays PTT. Voice `play` / `pause` / `where's the monitor` still work.

## Review card layout

The post-cut monitor is **three stacked bands** inside the glass pad — header,
16:9 film, transport dock — and they must not overlap. Every number lives in
[`review-layout.ts`](./review-layout.ts); nothing in `review-screen.ts` or
`makeReviewCardTexture` may hardcode a position.

World metres are the source of truth and the canvas is derived from them
(`pxX` / `pxY` / `canvasX` / `canvasY`), because that is the direction that
can't rot: a band that fits in metres cannot fail to fit in pixels. The two used
to carry the same numbers independently behind a "keep these in sync" comment,
and they drifted — the title chip and legend sat at y ≈ 0.405 while the film
reached 0.395, so the header painted over the video.

Rules that hold the fix in place:

- **Size the film from the bezel inward.** The dark plate is what has to clear
  the bands, so the reveal comes out of the budget *before* the 16:9 is derived.
  Fitting the film first and painting a bezel around it is how the plate ends up
  wider than the space it was measured for.
- **Header, hint, play pill, and scrub track are baked into the card**, not
  separate meshes. A transparent quad in front of the glass is what reads as a
  dark rectangular mask against passthrough (square corners, room showing
  through the padding). The playhead thumb is the only overlay — two opaque
  discs, because it has to slide.
- **The film is a rounded `ShapeGeometry`**, radius `BEZEL_RADIUS − FILM_INSET`
  so its corners are concentric with the bezel's. Square corners on a rounded
  plate punch through the glass. `ShapeGeometry` UVs are raw vertex coords, so
  they need remap to 0..1 or the render target samples off the edge.
- **Play and scrub share `DOCK_Y`** so the transport is one row; the hint stays
  in the header.

Guarded by [`review-layout.test.ts`](./review-layout.test.ts) — band order, gaps
of at least `BAND_GAP`, controls inside the groove, and the canvas mapping.

## Peers / versions

- `@iwsdk/xr-input@0.4.2` peer: `three >= 0.160` (Sikat: `three@^0.184`)
- Node engines on the package prefer Node 20.19+ / 22.12+ / 24+
- Bundle cost: XR input + visuals add ~300KB gzip to the main chunk; acceptable for Quest

## Out of scope (for now)

- Full desktop timeline UI in XR
- Ray/grab pointers (`pointerSettings.enabled: false`) — no controller laser; review is button-driven
- Aim-pick / point-and-speak deictics (removed with the pointer)
- UIKitML spatial UI
- Locomotion / physics / scene understanding
- IWSDK MCP coding-agent tooling (separate from Director crew)

## Manual verify checklist

- [ ] Chrome Immersive Web Emulator: ENTER XR → screen tracks right grip
- [ ] EXIT XR button ends session without refresh
- [ ] Viewfinder shows studio CG / white bg (not black, not passthrough)
- [ ] Trigger toggles TAKE / REC — blinking red dot on LCD while rolling
- [ ] Cut → floating review screen appears, plays camera path on studio bg
- [ ] Review card is one rounded glass: no square tab, hint readable in the header, film corners follow the bezel, play + scrub on one line in the dock
- [ ] Review: B play/pause, hold B close, stick scrub, squeeze move, squeeze+stick Y scale
- [ ] Grip LCD stays live aim; review shows timeline playback
- [ ] Hold A → larger slate stays up with live STT; release keeps the line, then finals reach crew when server up
- [ ] Quest Browser: same, with passthrough on headset view only
