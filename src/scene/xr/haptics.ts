/**
 * Controller haptics — one tiny fire-and-forget helper. Quest Browser exposes
 * the legacy GamepadHapticActuator.pulse(); newer UAs may only have
 * playEffect('dual-rumble'). Everything is optional-chained so emulators and
 * desktops silently no-op.
 */

interface AnyHapticActuator {
  pulse?: (intensity: number, durationMs: number) => Promise<boolean> | boolean
  playEffect?: (type: string, params: Record<string, number>) => Promise<string> | string
}

interface PadLike {
  gamepad?: Gamepad
}

export function pulse(pad: PadLike | null | undefined, intensity: number, durationMs: number): void {
  try {
    const actuator = pad?.gamepad?.hapticActuators?.[0] as AnyHapticActuator | undefined
    if (!actuator) return
    if (typeof actuator.pulse === 'function') {
      void actuator.pulse(intensity, durationMs)
    } else if (typeof actuator.playEffect === 'function') {
      void actuator.playEffect('dual-rumble', {
        duration: durationMs,
        strongMagnitude: intensity,
        weakMagnitude: intensity * 0.6,
      })
    }
  } catch {
    // haptics are garnish — never let them throw on the frame path
  }
}

/** Two quick taps — REC stop, distinct from the single REC-start thump. */
export function doublePulse(pad: PadLike | null | undefined, intensity: number, durationMs: number): void {
  pulse(pad, intensity, durationMs)
  setTimeout(() => pulse(pad, intensity, durationMs), durationMs + 60)
}
