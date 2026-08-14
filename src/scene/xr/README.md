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
| Grip / ray / head spaces (controller/hand GLTFs hidden) | `@iwsdk/xr-input` `XRInputManager` |
| Camcorder screen + virt cam pose + REC + take review | [`camcorder-rig.ts`](./camcorder-rig.ts) |
| Viewfinder RT (same FX as desktop PiP) | [`xr-viewfinder.ts`](./xr-viewfinder.ts) + `viewfinder-pass.ts` |
| Take playback (timeline cam → grip well) | [`take-playback.ts`](./take-playback.ts) |

## Wiring

1. `bootstrap.ts` — `createCamcorderRig(scene, userCamera, virtCamera, mainRenderer)`; cut enters grip review.
2. `animate-loop.ts` (XR frames) — camcorder update → live grip LCD **or** take playback into the same well.
3. Camcorder group is parented to `xrOrigin.gripSpaces.right`.
4. REC: `gamepads.right.getButtonDown(InputComponent.Trigger)` or `getSelectStart()` (suppressed while reviewing).
5. Grip origin forced to **EDITOR_LAYER (3)** so editor chrome never appears in the virtual cam film.
   **Do not use layers 1 or 2** — Three.js WebXR reserves those for left/right eye cameras; objects on layer 1 only draw in the left eye.

## Grip LCD

One well, two feeds. The 16:9 cutout on the director card does not move when the card grows.

| Mode | Camera source | Purpose |
|------|---------------|---------|
| Live aim | Right-grip pose | Record / frame |
| Take review | Timeline keyframes (`playbackCam`) | Watch the take after cut |

Both film **studio CG** (white `#f2f2f2`), never passthrough. Passthrough is headset eyes only. There is no second world-space monitor.

**UI chrome:** XR panels use the same desktop Figma tokens (ink `#17171a`, accent `#2c6bf5`, white floating cards) via canvas textures in [`xr-ui-chrome.ts`](./xr-ui-chrome.ts) — Three.js meshes can't use CSS. Cards are visionOS-style faux frost drawn by `drawGlassCard`: rounded translucent fill + painted soft shadow, so every texture reserves a transparent `pad` margin for shadow bleed and its material must stay `transparent: true`. Buttons are wash/ink pills whose hover is a soft glow + lighten (never inversion); labels render in Nunito, preloaded via `preloadXrUiFonts()` at app boot so canvases don't rasterize the fallback font.

## Exit XR (emulator)

- In-app **EXIT XR** button (top-left) while presenting — calls `session.end()`.
- Emulator panel Exit / End session, or **Esc**, also works.

## Right-hand controls

| Input | Action |
|-------|--------|
| **Trigger** | REC / cut take (blocked while reviewing) |
| **Hold A** | Push-to-talk → Director crew (Web Speech → `user_command`) |

A larger DIRECTOR slate hangs under the grip LCD: status (`DIRECTOR` / `LISTENING` / `OFFLINE` / `Take review`) + live transcript while holding A (ambient mode no longer hides listening/sending). Release keeps the captured line until the final lands. Reuses [`voice-session.ts`](../../director/voice-session.ts) + [`director-command.ts`](../../director/director-command.ts) — same path as the desktop mic, not a separate realtime voice API.

## Take review (same card)

After cut, the grip well swaps from live aim to timeline playback of that take and auto-plays once. Transport (play pill + scrub) grows in above the well as a slate body — existing ~190 ms dip/settle; the well stays put. The card eases to ~1.15× so the take is readable. No second compositor, no floating panel.

| Input | Action |
|-------|--------|
| **B tap** | Play / pause |
| **Hold B** (~400ms) | Exit review → live aim, scale back to 1 |
| **Thumbstick X** | Scrub within the take |
| **Thumbstick Y** | Scale the grip card (1.0–1.75×) |

Trigger stays REC (still suppressed while reviewing). Hold A stays PTT. Voice `play` / `pause` / `where's the monitor` still work — recall pulses the card if already reviewing, or re-enters the last take on the grip (no teleport).

## Review chrome

Transport metrics live in [`director-slate.ts`](./director-slate.ts) next to `PROCESSING_H_U` so they fit `MAX_BODY_H_U`. Header copy is `Take review` / `Hold B to close` — the same Nunito hint as `Hold A to talk`, not a mono shout. Play + scrub paint into the card; the playhead is the only extra mesh (two opaque discs). Scale the **panel** group, not the whole rig, so the well stays in the cutout.

## Peers / versions

- `@iwsdk/xr-input@0.4.2` peer: `three >= 0.160` (Sikat: `three@^0.184`)
- Node engines on the package prefer Node 20.19+ / 22.12+ / 24+
- Bundle cost: XR input + visuals add ~300KB gzip to the main chunk; acceptable for Quest

## Out of scope (for now)

- Full desktop timeline UI in XR
- Ray/grab pointers (`pointerSettings.enabled: false`) — no controller laser; review is button-driven
- Detaching the card from the grip / floating “lift off”
- Aim-pick / point-and-speak deictics (removed with the pointer)
- UIKitML spatial UI
- Locomotion / physics / scene understanding
- IWSDK MCP coding-agent tooling (separate from Director crew)

## Manual verify checklist

- [ ] Chrome Immersive Web Emulator: ENTER XR → screen tracks right grip
- [ ] EXIT XR button ends session without refresh
- [ ] Viewfinder shows studio CG / white bg (not black, not passthrough)
- [ ] Trigger toggles TAKE / REC — blinking red dot on LCD while rolling
- [ ] Cut → grip well swaps to the take, transport grows in, card eases to ~1.15×
- [ ] Review: B play/pause, hold B back to live, stick X scrub, stick Y scale (1.0–1.75×)
- [ ] While reviewing, well shows timeline playback (not live aim); Hold A still PTT; trigger blocked
- [ ] Hold A → larger slate stays up with live STT; release keeps the line, then finals reach crew when server up
- [ ] Quest Browser: same, with passthrough on headset view only
