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
| Chrome emulator Layers compat | [`xr-compat.ts`](./xr-compat.ts) |
| Grip / ray / head spaces + controller GLTF | `@iwsdk/xr-input` `XRInputManager` |
| Camcorder screen + virt cam pose + REC | [`camcorder-rig.ts`](./camcorder-rig.ts) |
| Viewfinder RT (same FX as desktop PiP) | [`xr-viewfinder.ts`](./xr-viewfinder.ts) + `viewfinder-pass.ts` |

## Wiring

1. `bootstrap.ts` — `createCamcorderRig(scene, userCamera, virtCamera)` creates `XRInputManager`, adds `xrOrigin` to the scene.
2. `animate-loop.ts` (XR frames) — `camcorderRig.update(delta, timeSec, mainRenderer.xr)` **before** the viewfinder RT pass.
3. Camcorder group is parented to `xrOrigin.gripSpaces.right`.
4. REC: `gamepads.right.getButtonDown(InputComponent.Trigger)` or `getSelectStart()`.
5. Controller/hand meshes forced to **EDITOR_LAYER (3)** so they never appear in the virtual cam film.
   **Do not use layers 1 or 2** — Three.js WebXR reserves those for left/right eye cameras; objects on layer 1 only draw in the left eye.

## Peers / versions

- `@iwsdk/xr-input@0.4.2` peer: `three >= 0.160` (Sikat: `three@^0.184`)
- Node engines on the package prefer Node 20.19+ / 22.12+ / 24+
- Bundle cost: XR input + visuals add ~300KB gzip to the main chunk; acceptable for Quest

## Out of scope (for now)

- Ray/grab pointers (`pointerSettings.enabled: false`)
- UIKitML spatial UI
- Locomotion / physics / scene understanding
- IWSDK MCP coding-agent tooling (separate from Director crew)

## Manual verify checklist

- [ ] Chrome Immersive Web Emulator: ENTER XR → screen tracks right grip
- [ ] Viewfinder shows studio CG (not headset passthrough)
- [ ] Trigger toggles TAKE / REC
- [ ] Quest Browser: same, with passthrough on headset view only
