/**
 * SET DAY — the guided demo shoot.
 *
 * One cue ("crew, set the stage") runs a fully deterministic, fully offline
 * build: the crew rolls in one by one, then constructs a product set —
 * pedestal, hero sneaker, sign, mood lighting, bloom, turntable spin —
 * through the SAME packet pipeline real commands use (enqueuePacket →
 * agent-runtime flight/work/settle theater). Nothing is faked; it just never
 * depends on a server.
 *
 * Afterward a shot list coaches the next voice cue (slate in XR, pod
 * placeholder on desktop) and advances as cues are spoken.
 */
import { enqueuePacket } from './agent-runtime'
import { getDirectorSocket } from './socket'
import { presenceStore, agentMetaFor } from './presence'
import { useEditorStore, defaultKeyLightPosition } from '../store'
import type { CommandPacket, Vec3 } from './protocol'

const DEMO_COMMAND_ID = 'demo-set-day'

const HERO = 'SNEAKER_ONE'
const PEDESTAL = 'PEDESTAL'
const SIGN = 'SET_SIGN'

const CREW = ['LightingTech', 'AssetAnimator', 'VFXOperator'] as const

interface DemoState {
  active: boolean
  /** 0 = building; 1..N = waiting for that beat's cue; -1 = inactive. */
  beat: number
}

const state: DemoState = { active: false, beat: -1 }

interface Beat {
  hint: string
  /** Advance when a submitted utterance matches. */
  cue: RegExp
  /** Applied locally when the Director server isn't connected. */
  offlineFallback?: () => void
}

const BEATS: Beat[] = [
  {
    hint: 'say “golden hour”',
    cue: /golden|sunset|warm/,
    offlineFallback: () => {
      enqueuePacket(packet('LightingTech', {
        command: 'UPDATE_LIGHTS',
        payload: {
          ambient: { color: '#4a2f3a', intensity: 0.7 },
          key: { color: '#ffb36b', intensity: 1.45, position: [-2.5, 1.6, 2] },
          background: '#2b1b2e',
        },
        transition: { durationSec: 1.6, easing: 'easeInOut' },
      }))
    },
  },
  {
    hint: 'say “make the sneaker float”',
    cue: /float|hover|levitate/,
    offlineFallback: () => {
      enqueuePacket(packet('AssetAnimator', {
        command: 'ANIMATE_OBJECT',
        payload: {
          target: { name: HERO },
          motion: 'float',
          durationSec: 6,
          repeat: true,
          params: {},
        },
      }))
    },
  },
  { hint: 'say “action” — then walk the set and film', cue: /\baction\b|rolling|roll camera/ },
  { hint: 'say “and cut” when you have the shot', cue: /\bcut\b|\bwrap\b/ },
  { hint: 'your take replays on the monitor — say “strike the set” to wrap', cue: /strike the set/ },
]

let timers: ReturnType<typeof setTimeout>[] = []

function at(ms: number, fn: () => void): void {
  timers.push(setTimeout(fn, ms))
}

function clearTimers(): void {
  for (const t of timers) clearTimeout(t)
  timers = []
}

export function isDemoActive(): boolean {
  return state.active
}

/** The current coaching line for the slate / pod, or null when not in demo. */
export function currentDemoHint(): string | null {
  if (!state.active) return null
  if (state.beat === 0) return null // building — crew narrates itself
  const beat = BEATS[state.beat - 1]
  return beat ? beat.hint : null
}

/** Called for every submitted command — advances the shot list. */
export function noteDemoUtterance(text: string): void {
  if (!state.active || state.beat < 1) return
  const beat = BEATS[state.beat - 1]
  if (beat && beat.cue.test(text.toLowerCase())) {
    // No server? The demo still delivers the beat itself.
    if (beat.offlineFallback && getDirectorSocket().status !== 'open') {
      beat.offlineFallback()
    }
    state.beat += 1
    if (state.beat > BEATS.length) state.beat = BEATS.length
  }
}

function packet(
  agent: string,
  body: Omit<CommandPacket, 'timestamp' | 'commandId' | 'target_agent'>
): CommandPacket {
  return {
    ...body,
    timestamp: Date.now() / 1000,
    commandId: DEMO_COMMAND_ID,
    target_agent: agent,
  } as CommandPacket
}

/** Roll call: each crew member flies in from the stage rim to their station. */
function rollCall(): void {
  const stage = useEditorStore.getState().stage
  CREW.forEach((agent, i) => {
    at(400 + i * 650, () => {
      const meta = agentMetaFor(agent)
      // Enter from the stage rim opposite the station, low — then rise to post.
      const entry: Vec3 = [
        stage.position[0] - (meta.station[0] - stage.position[0]) * 0.4,
        stage.position[1] + 0.4,
        stage.position[2] - (meta.station[2] - stage.position[2]) * 0.4,
      ]
      const p = presenceStore.getState()
      p.setActive(agent, true)
      p.appearAt(agent, entry)
      p.flyTo(agent, meta.station as Vec3, 'intent', 900)
      p.setNote(agent, 'on set', true)
    })
  })
}

export function startSetDay(): string {
  if (state.active) return 'set day already running'
  state.active = true
  state.beat = 0
  clearTimers()

  const stage = useEditorStore.getState().stage
  const [cx, cy, cz] = stage.position

  rollCall()

  // Clear center stage: anything already sitting where the set goes gets
  // slid out to the rim — the crew makes room, it never deletes your work.
  at(2000, () => {
    const objects = useEditorStore.getState().objects
    let cleared = 0
    for (const obj of objects) {
      const dx = obj.position[0] - cx
      const dz = obj.position[2] - cz
      if (Math.hypot(dx, dz) > 0.35) continue
      const angle = Math.PI * 0.75 + cleared * 0.6
      cleared += 1
      enqueuePacket(packet('AssetAnimator', {
        command: 'TRANSFORM_OBJECT',
        payload: {
          target: { id: obj.id },
          position: [
            cx + Math.cos(angle) * (stage.radius + 0.25),
            obj.position[1],
            cz + Math.sin(angle) * (stage.radius + 0.25),
          ],
          mode: 'absolute',
        },
        transition: { durationSec: 0.9, easing: 'easeInOut' },
      }))
    }
  })

  // Mood base — the room dims into a shoot.
  at(2400, () => {
    enqueuePacket(packet('LightingTech', {
      command: 'UPDATE_LIGHTS',
      payload: {
        ambient: { color: '#2a2438', intensity: 0.55 },
        key: { color: '#ffd9a0', intensity: 1.25, position: [2, 3, 1.5] },
        background: '#171522',
      },
      transition: { durationSec: 1.4, easing: 'easeInOut' },
    }))
  })

  // Pedestal.
  at(3400, () => {
    enqueuePacket(packet('AssetAnimator', {
      command: 'SPAWN_OBJECT',
      payload: {
        primitive: 'cylinder',
        name: PEDESTAL,
        color: '#F5F2EA',
        position: [cx, cy + 0.21, cz],
        scale: [0.9, 1.4, 0.9],
      },
    }))
  })

  // The hero.
  at(4600, () => {
    enqueuePacket(packet('AssetAnimator', {
      command: 'SPAWN_OBJECT',
      payload: {
        primitive: 'sneaker',
        name: HERO,
        position: [cx, cy + 0.43, cz],
      },
    }))
  })

  // Sign behind the stage.
  at(5800, () => {
    enqueuePacket(packet('AssetAnimator', {
      command: 'SPAWN_OBJECT',
      payload: {
        primitive: 'text',
        name: SIGN,
        text: 'SET DAY',
        color: '#FFE092',
        position: [cx, cy + 0.85, cz - 0.9],
      },
    }))
  })

  // Hero glow — threshold stays above the darkened set so only the emissive
  // hero blooms, not the whole viewfinder frame.
  at(6800, () => {
    enqueuePacket(packet('VFXOperator', {
      command: 'UPDATE_FX',
      payload: {
        section: 'bloom',
        // Bloom "surface glow" boosts EVERY material's emissive by
        // color × boost at this intensity (viewfinder-mesh-fx) — keep both
        // low or the lit whites wash the whole frame out.
        patch: { enabled: true, strength: 0.5, threshold: 0.9, emissiveBoost: 0.7, emissiveIntensity: 0.45 },
      },
    }))
    enqueuePacket(packet('VFXOperator', {
      command: 'SET_MATERIAL',
      payload: { target: { name: HERO }, emissive: '#ff5a5f', emissiveIntensity: 0.12 },
    }))
  })

  // Turntable.
  at(7800, () => {
    enqueuePacket(packet('AssetAnimator', {
      command: 'ANIMATE_OBJECT',
      payload: {
        target: { name: HERO },
        motion: 'spin',
        durationSec: 10,
        repeat: true,
        params: {},
      },
    }))
  })

  // Frame the hero for the viewfinder (in XR the handheld camcorder pose
  // takes over live — this sets the desktop money shot).
  at(8800, () => {
    enqueuePacket(packet('Producer', {
      command: 'MOVE_CAMERA',
      payload: {
        position: [cx + 0.55, cy + 0.55, cz + 0.75],
        lookAtTarget: { name: HERO },
      },
      transition: { durationSec: 1.2, easing: 'easeInOut' },
    }))
  })

  // Hand over to the shot list.
  at(9600, () => {
    state.beat = 1
  })

  return 'crew rolling in — set day is on'
}

export function strikeSet(): string {
  if (!state.active) return 'no set to strike'
  clearTimers()
  state.active = false
  state.beat = -1

  for (const name of [SIGN, HERO, PEDESTAL]) {
    enqueuePacket(packet('AssetAnimator', {
      command: 'REMOVE_OBJECT',
      payload: { target: { name } },
    }))
  }
  enqueuePacket(packet('VFXOperator', {
    command: 'UPDATE_FX',
    payload: { section: 'bloom', patch: { enabled: false } },
  }))
  enqueuePacket(packet('LightingTech', {
    command: 'UPDATE_LIGHTS',
    payload: {
      // Editor defaults (store.ts createDefault lighting).
      ambient: { color: '#ffffff', intensity: 0.8 },
      key: { color: '#ffffff', intensity: 1.5, position: defaultKeyLightPosition() },
      background: '#f2f2f2',
    },
    transition: { durationSec: 1.2, easing: 'easeInOut' },
  }))
  return "that's a wrap — striking the set"
}
