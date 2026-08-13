/**
 * LOCAL CREW grammar — deterministic, fully offline command parsing.
 *
 * Turns typed cues into the same CommandPackets the agent server emits, so
 * spawns, lighting moods, FX toggles, motions, and simple moves all work with
 * no server (and route through the same cursor theater + undo).
 *
 * Parsing is pure (no store access) so it's testable under node:test —
 * targets resolve later inside applyCommandPacket. The invariant guarded by
 * local-grammar.test.ts: every rotating pod placeholder must parse here (or be
 * a local transport/overlay command) — the app never suggests a cue that
 * fails offline.
 */
import { resolveMotionId, type MotionId } from '../motion-synth.ts'
import type { CommandPacket, UpdateLightsPayload, FxSection, Vec3 } from './protocol'

/** A packet body plus the crew member whose cursor performs it. */
export interface LocalPacketSpec {
  agent: 'AssetAnimator' | 'LightingTech' | 'VFXOperator'
  body: Omit<CommandPacket, 'timestamp' | 'commandId' | 'target_agent'>
}

/** Rotating pod input suggestions — every entry MUST work offline. */
export const PLACEHOLDERS = [
  'add a red box then dim the lights',
  'golden hour',
  'make the sphere bounce',
  'enable bloom',
  'move the box up 2 over 3 seconds',
  'show timeline',
]

/** Shown when LOCAL CREW can't parse a cue — keep in sync with the grammar. */
export const OFFLINE_SUGGESTIONS = ['add a red box', 'golden hour', 'make the sphere bounce']

/**
 * Words a person says before the actual cue. Stripped as a group so "okay, so
 * cut" lands on `cut`. Deliberately excludes `yes`/`yeah`/`sure` — those are
 * the suggestion-accept cue in local-commands.
 */
const LEADING_FILLERS = /^(?:(?:okay|ok|uh+|um+|erm|so|well|now|please|hey|alright|right)\b[,\s]+)+/i

/**
 * Speech engines punctuate. Deepgram runs with `punctuate` + `smart_format`, so
 * a spoken "cut" arrives as "Cut." — and every cue regex in local-commands is
 * anchored, so the trailing period alone kills the most-used cues on set.
 * Normalize once, here, before anything tries to match or send.
 *
 * Pure and export-only so local-grammar.test.ts can cover it. Case is
 * preserved — callers lowercase for matching, and the server's LLM reads better
 * prose with it intact.
 */
export function normalizeUtterance(text: string): string {
  const cleaned = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
  // Never normalize a cue out of existence — an all-filler utterance stays as-is.
  const stripped = cleaned.replace(LEADING_FILLERS, '').trim()
  return stripped || cleaned
}

const COLORS: Record<string, string> = {
  red: '#ff3b30',
  orange: '#ff9500',
  yellow: '#ffd60a',
  green: '#30d158',
  blue: '#0094ff',
  purple: '#bf5af2',
  violet: '#bf5af2',
  pink: '#ff5a8f',
  white: '#f5f2ea',
  black: '#1c1c1e',
  gray: '#8e8e93',
  grey: '#8e8e93',
  gold: '#ffcc55',
  teal: '#40c8e0',
  cyan: '#64d2ff',
}

const PRIMITIVES: Record<string, 'box' | 'sphere' | 'cone' | 'cylinder' | 'torus' | 'plane' | 'text' | 'sneaker'> = {
  box: 'box',
  cube: 'box',
  block: 'box',
  sphere: 'sphere',
  ball: 'sphere',
  orb: 'sphere',
  cone: 'cone',
  cylinder: 'cylinder',
  pedestal: 'cylinder',
  torus: 'torus',
  donut: 'torus',
  ring: 'torus',
  plane: 'plane',
  floor: 'plane',
  sneaker: 'sneaker',
  shoe: 'sneaker',
}

const FX_SECTIONS: Record<string, FxSection> = {
  bloom: 'bloom',
  glow: 'bloom',
  pixelate: 'pixelate',
  pixels: 'pixelate',
  'pixel art': 'pixelate',
  glitch: 'glitch',
  dither: 'dither',
  grain: 'dither',
  'cell shading': 'cellShading',
  cellshading: 'cellShading',
  'cel shading': 'cellShading',
  toon: 'cellShading',
  outline: 'cellShading',
  outlines: 'cellShading',
}

const MOTION_IDS = new Set<MotionId>([
  'bounce', 'float', 'drop', 'rise', 'pulse', 'sway', 'spin', 'orbit',
  'turnaround', 'wobble', 'drift', 'arc', 'pop', 'shake', 'figure8',
  'zigzag', 'spiral', 'launch', 'swing', 'wander', 'squash',
])

/** Canned lighting rigs — the same shape SET DAY's beats use. */
const MOODS: Record<string, UpdateLightsPayload> = {
  goldenHour: {
    ambient: { color: '#4a2f3a', intensity: 0.7 },
    key: { color: '#ffb36b', intensity: 1.45, position: [-2.5, 1.6, 2] },
    background: '#2b1b2e',
  },
  noir: {
    ambient: { color: '#1a1d26', intensity: 0.4 },
    key: { color: '#cdd6f4', intensity: 1.7, position: [3, 3.5, 1] },
    background: '#0d0f14',
  },
  neon: {
    ambient: { color: '#2d1b4e', intensity: 0.65 },
    key: { color: '#ff4fd8', intensity: 1.5, position: [-2, 2.5, 2.5] },
    background: '#16092b',
  },
  dim: {
    ambient: { color: '#2a2438', intensity: 0.55 },
    key: { color: '#ffd9a0', intensity: 1.25, position: [2, 3, 1.5] },
    background: '#171522',
  },
  studio: {
    ambient: { color: '#ffffff', intensity: 0.8 },
    key: { color: '#ffffff', intensity: 1.5, position: [2, 4, 2.8] },
    background: '#f2f2f2',
  },
}

const LIGHT_TRANSITION = { durationSec: 1.4, easing: 'easeInOut' as const }

function lightsSpec(payload: UpdateLightsPayload): LocalPacketSpec {
  return {
    agent: 'LightingTech',
    body: { command: 'UPDATE_LIGHTS', payload, transition: LIGHT_TRANSITION },
  }
}

function parseMood(t: string): LocalPacketSpec | null {
  if (/^(golden hour|sunset( mood| lighting)?|warm (mood|light(s|ing)?))$/.test(t)) return lightsSpec(MOODS.goldenHour)
  if (/^(noir( mood)?|film noir|moody|moonlight)$/.test(t)) return lightsSpec(MOODS.noir)
  if (/^(neon( night| mood)?|night mood|cyberpunk)$/.test(t)) return lightsSpec(MOODS.neon)
  if (/^(dim the lights|lights? down|darker|dim it)$/.test(t)) return lightsSpec(MOODS.dim)
  if (/^(studio( light(s|ing)?)?|lights? up|brighten|reset( the)? lights?|daylight)$/.test(t)) return lightsSpec(MOODS.studio)
  return null
}

function parseSpawn(t: string): LocalPacketSpec | null {
  const m = t.match(/^(?:add|spawn|drop|create|place)\s+(?:(?:a|an|the)\s+)?(?:(\w+)\s+)?(\w+)$/)
  if (!m) return null
  const [, modifier, noun] = m
  const primitive = PRIMITIVES[noun]
  if (!primitive) return null
  const color = modifier ? COLORS[modifier] ?? null : null
  if (modifier && !color) return null
  return {
    agent: 'AssetAnimator',
    body: {
      command: 'SPAWN_OBJECT',
      payload: { primitive, ...(color ? { color } : {}) },
    },
  }
}

function parseFx(t: string): LocalPacketSpec | null {
  const m = t.match(/^(enable|disable|turn on|turn off|add|remove|kill)\s+(?:the\s+)?(.+?)(?:\s+effect)?$/)
  if (!m) return null
  const section = FX_SECTIONS[m[2]]
  if (!section) return null
  const enabled = m[1] === 'enable' || m[1] === 'turn on' || m[1] === 'add'
  return {
    agent: 'VFXOperator',
    body: { command: 'UPDATE_FX', payload: { section, patch: { enabled } } },
  }
}

function parseMotion(t: string): LocalPacketSpec | null {
  // "make the sneaker float" / "have the box bounce" / "let the sphere spin"
  let target: string | null = null
  let motionWord: string | null = null
  let m = t.match(/^(?:make|have|let)\s+(?:the\s+)?(.+)\s+(\S+)$/)
  if (m) {
    target = m[1]
    motionWord = m[2]
  } else {
    // "bounce the sphere" / "spin the sneaker"
    m = t.match(/^(\S+)\s+(?:the\s+)?(.+)$/)
    if (m) {
      motionWord = m[1]
      target = m[2]
    }
  }
  if (!target || !motionWord) return null
  const motion = resolveMotionId(motionWord)
  if (!MOTION_IDS.has(motion)) return null
  return {
    agent: 'AssetAnimator',
    body: {
      command: 'ANIMATE_OBJECT',
      payload: { target: { name: target }, motion, repeat: true, params: {} },
    },
  }
}

const MOVE_DELTAS: Record<string, Vec3> = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  forward: [0, 0, -1],
  forwards: [0, 0, -1],
  back: [0, 0, 1],
  backward: [0, 0, 1],
  backwards: [0, 0, 1],
}

function parseMove(t: string): LocalPacketSpec | null {
  const m = t.match(
    /^(?:move|slide|push|shift)\s+(?:the\s+)?(.+?)\s+(up|down|left|right|forwards?|backwards?|back)(?:\s+(?:by\s+)?(\d+(?:\.\d+)?))?(?:\s+over\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?)?$/
  )
  if (!m) return null
  const [, target, direction, amountRaw, overRaw] = m
  const unit = MOVE_DELTAS[direction]
  if (!unit) return null
  const amount = amountRaw ? parseFloat(amountRaw) : 0.5
  const durationSec = overRaw ? parseFloat(overRaw) : 0.8
  return {
    agent: 'AssetAnimator',
    body: {
      command: 'TRANSFORM_OBJECT',
      payload: {
        target: { name: target },
        mode: 'relative',
        position: [unit[0] * amount, unit[1] * amount, unit[2] * amount],
      },
      transition: { durationSec, easing: 'easeInOut' },
    },
  }
}

function parseClause(t: string): LocalPacketSpec | null {
  return parseMood(t) ?? parseSpawn(t) ?? parseFx(t) ?? parseMove(t) ?? parseMotion(t)
}

/**
 * Parse a full cue, splitting "… then …" chains. Returns null unless EVERY
 * clause parses — a half-understood compound must fall through to the server.
 */
export function parseOfflineClauses(text: string): LocalPacketSpec[] | null {
  const clauses = text
    .trim()
    .toLowerCase()
    .replace(/[!.]+$/, '')
    .split(/\s*(?:,\s*then|then|,\s*and then|and then)\s+/)
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.length === 0) return null
  const specs: LocalPacketSpec[] = []
  for (const clause of clauses) {
    const spec = parseClause(clause)
    if (!spec) return null
    specs.push(spec)
  }
  return specs
}

/**
 * Vocabulary to boost in the speech engine (Deepgram keyterm prompting).
 * Deliberately short: only the words a general model actually gets wrong on a
 * set — FX names, motion jargon, and cues that mean nothing outside a shoot.
 * Everyday words the grammar also accepts ("box", "cut", "take") are left off;
 * they already transcribe fine, and padding the prompt dilutes it.
 */
export const DIRECTOR_KEYTERMS: string[] = [
  // FX names — the worst offenders, and all of them are load-bearing.
  'bloom',
  'pixelate',
  'glitch',
  'dither',
  'cell shading',
  'toon',
  // Motion words a general model doesn't expect as verbs.
  'turnaround',
  'wobble',
  'squash',
  'zigzag',
  'spiral',
  // Set nouns.
  'pedestal',
  'torus',
  'sneaker',
  'viewfinder',
  'camcorder',
  'gaffer',
  'slate',
  // Multi-word cues that only mean something on a set.
  'golden hour',
  'film noir',
  'neon night',
  'strike the set',
  "that's a wrap",
  'back to one',
  'top of scene',
]

/**
 * In-headset session cues — kept here (pure) so tests can cover them.
 * "that's a wrap" ends the XR session; the monitor cue recalls the take review.
 */
/**
 * Take cues. These live with the rest of the grammar rather than in
 * local-commands so they are reachable from a node test — the asymmetry between
 * them was a real bug (`and action` matched, `and cut` did not), and the SET DAY
 * shot list coaches both phrasings, so they need to stay in step.
 */
export const START_CUES = [
  /^(?:and\s+)?action$/,
  /^camera'?s?\s+(?:is\s+)?rolling$/,
  /^start\s+recording$/,
  /^we'?re\s+rolling$/,
  /^roll\s+(?:camera|sound|it)$/,
]

export const STOP_CUES = [
  /^(?:and\s+)?cut$/,
  /^that'?s\s+a\s+cut$/,
  /^stop\s+recording$/,
]

/**
 * An open-ended creative brief — the director wants movement but hasn't said
 * what or to which object. These have no grammar match by definition, so they
 * used to go straight to the server and leave the set still until it answered.
 * Matching them lets the crew start improvising in the same frame.
 */
export const CREATIVE_BRIEF_RE =
  /\b(?:surprise(?:\s+me)?|impress\s+me|wow\s+me|blow\s+my\s+mind|go\s+wild|go\s+crazy|go\s+nuts|go\s+off|do\s+something(?:\s+cool)?|something\s+(?:cool|wild|crazy|interesting)|make\s+it\s+(?:cool|wild|crazy|interesting|pop|insane)|i\s+trust\s+you|trust\s+you|your\s+call|do\s+your\s+thing|motion\s+graphics|choreograph|freestyle|neon\s+tokyo|music\s+video|feel(?:s)?\s+like|feeling\s+like)\b/i

export function isCreativeBrief(text: string): boolean {
  return CREATIVE_BRIEF_RE.test(text)
}

export const WRAP_CUE_RE =
  /^(that'?s\s+a\s+wrap|wrap\s+it\s+up|wrap\s+for\s+today|exit\s+(?:xr|the\s+headset|headset|the\s+set)|leave\s+the\s+set)[!.]?$/

export const MONITOR_RECALL_RE =
  /^(?:where'?s|where\s+is|show(?:\s+me)?|bring(?:\s+back)?)\s+(?:the\s+)?(?:monitor|review|take|replay)[?!.]?$/
