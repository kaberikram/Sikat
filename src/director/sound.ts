/**
 * The set's sound design — fully synthesized (oscillators + filtered noise),
 * no audio files, no voices. Rides the shared AudioContext so it never fights
 * the mic capture graph for a context slot.
 *
 * Every trigger is fire-and-forget and no-ops when sound is disabled or the
 * context can't run yet (autoplay policy) — callers never need to care.
 */
import { getSharedAudioContext } from './voice-session'

const STORAGE_KEY = 'sikat.soundEnabled'

let enabled = ((): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
})()

let master: GainNode | null = null
let noiseBuffer: AudioBuffer | null = null

export function isSoundEnabled(): boolean {
  return enabled
}

export function setSoundEnabled(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(STORAGE_KEY, String(on))
  } catch { /* private mode */ }
}

/** Returns a ready context+master, or null when sound can't/shouldn't play. */
function ready(): { ctx: AudioContext; out: GainNode } | null {
  if (!enabled) return null
  try {
    const ctx = getSharedAudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    if (ctx.state !== 'running') return null
    if (!master) {
      master = ctx.createGain()
      master.gain.value = 0.25
      master.connect(ctx.destination)
    }
    return { ctx, out: master }
  } catch {
    return null
  }
}

function getNoise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return noiseBuffer
}

function envGain(ctx: AudioContext, out: AudioNode, t0: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
  g.connect(out)
  return g
}

function noiseVoice(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  opts: { type: BiquadFilterType; from: number; to: number; q?: number; peak: number; attack: number; decay: number }
): void {
  const src = ctx.createBufferSource()
  src.buffer = getNoise(ctx)
  src.loop = true
  const filter = ctx.createBiquadFilter()
  filter.type = opts.type
  filter.Q.value = opts.q ?? 1
  filter.frequency.setValueAtTime(opts.from, t0)
  filter.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.attack + opts.decay)
  const g = envGain(ctx, out, t0, opts.peak, opts.attack, opts.decay)
  src.connect(filter)
  filter.connect(g)
  src.start(t0)
  src.stop(t0 + opts.attack + opts.decay + 0.05)
}

function toneVoice(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  opts: { type: OscillatorType; from: number; to?: number; detune?: number; peak: number; attack: number; decay: number }
): void {
  const osc = ctx.createOscillator()
  osc.type = opts.type
  if (opts.detune) osc.detune.value = opts.detune
  osc.frequency.setValueAtTime(opts.from, t0)
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.attack + opts.decay)
  const g = envGain(ctx, out, t0, opts.peak, opts.attack, opts.decay)
  osc.connect(g)
  osc.start(t0)
  osc.stop(t0 + opts.attack + opts.decay + 0.05)
}

/** Entry beat: a 2s rising pad as the room dims and the stage materializes. */
export function entrySwell(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  toneVoice(s.ctx, s.out, t0, { type: 'sine', from: 110, to: 220, peak: 0.28, attack: 1.3, decay: 1.0 })
  toneVoice(s.ctx, s.out, t0, { type: 'sine', from: 165, to: 330, detune: 7, peak: 0.18, attack: 1.4, decay: 1.0 })
  noiseVoice(s.ctx, s.out, t0, { type: 'lowpass', from: 300, to: 2400, peak: 0.1, attack: 1.6, decay: 0.9 })
}

/** A crew member glides in — soft airy sweep, panned to their station. */
export function crewWhoosh(panX = 0): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  const pan = s.ctx.createStereoPanner()
  pan.pan.value = Math.max(-1, Math.min(1, panX / 3))
  pan.connect(s.out)
  noiseVoice(s.ctx, pan, t0, { type: 'bandpass', from: 400, to: 1800, q: 2, peak: 0.22, attack: 0.08, decay: 0.28 })
}

/** A prop pops onto the set — synced with the spawn scale-in. */
export function spawnPop(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  toneVoice(s.ctx, s.out, t0, { type: 'triangle', from: 520, to: 260, peak: 0.22, attack: 0.012, decay: 0.16 })
  noiseVoice(s.ctx, s.out, t0, { type: 'highpass', from: 3000, to: 5000, peak: 0.05, attack: 0.005, decay: 0.06 })
}

/** Clap sticks — take starts. */
export function slateClap(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  noiseVoice(s.ctx, s.out, t0, { type: 'bandpass', from: 2200, to: 1400, q: 1.5, peak: 0.4, attack: 0.004, decay: 0.07 })
  noiseVoice(s.ctx, s.out, t0 + 0.045, { type: 'bandpass', from: 1800, to: 1000, q: 1.5, peak: 0.3, attack: 0.004, decay: 0.1 })
}

/** Soft resolve — take cut. */
export function cutTick(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  toneVoice(s.ctx, s.out, t0, { type: 'sine', from: 660, to: 440, peak: 0.18, attack: 0.01, decay: 0.18 })
}

/** Tiny glass tick — shot list advance, point lock-on. */
export function beatTick(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  toneVoice(s.ctx, s.out, t0, { type: 'sine', from: 1320, peak: 0.1, attack: 0.005, decay: 0.09 })
}

/** Warm three-note resolve — that's a wrap. */
export function wrapChord(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  const notes = [262, 330, 392] // C4 E4 G4
  notes.forEach((freq, i) => {
    toneVoice(s.ctx, s.out, t0 + i * 0.12, { type: 'sine', from: freq, peak: 0.16, attack: 0.04, decay: 0.9 })
  })
}

/** Push-to-talk opens — two quick rising notes, quiet and close. */
export function listenStart(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  toneVoice(s.ctx, s.out, t0, { type: 'sine', from: 660, peak: 0.09, attack: 0.008, decay: 0.07 })
  toneVoice(s.ctx, s.out, t0 + 0.09, { type: 'sine', from: 880, peak: 0.11, attack: 0.008, decay: 0.09 })
}

/** Release-to-send — a soft falling whoosh as the line goes to the crew. */
export function listenEnd(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  noiseVoice(s.ctx, s.out, t0, { type: 'bandpass', from: 1600, to: 500, q: 2, peak: 0.14, attack: 0.02, decay: 0.22 })
}

/** The director answered — mint two-note ding, distinct from beatTick. */
export function replyChime(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  toneVoice(s.ctx, s.out, t0, { type: 'sine', from: 880, peak: 0.12, attack: 0.008, decay: 0.18 })
  toneVoice(s.ctx, s.out, t0 + 0.09, { type: 'sine', from: 1175, peak: 0.1, attack: 0.008, decay: 0.22 })
}

/** Didn't catch that — one gentle low note, never punitive. */
export function missedBuzz(): void {
  const s = ready()
  if (!s) return
  const t0 = s.ctx.currentTime
  toneVoice(s.ctx, s.out, t0, { type: 'triangle', from: 220, to: 180, peak: 0.1, attack: 0.015, decay: 0.2 })
}
