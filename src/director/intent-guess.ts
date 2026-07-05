/**
 * Lightweight client-side intent guess — instant cursor reaction before the
 * server parse completes. Heuristic only; server preview overrides when it lands.
 */
import { useEditorStore } from '../store'
import type { Vec3 } from './protocol'

export interface IntentGuess {
  agent: string
  targetObjectId?: string
  targetName?: string
  roughAction?: string
  motion?: string
  note: string
  targetPosition?: Vec3
}

const AGENT_RE = /\bagent\s*([1-4])\b/i
const PRONOUN_RE = /\b(it|that|this one|the selected)\b/i

const MOTION_WORDS = [
  'arc', 'bounce', 'float', 'drop', 'spin', 'orbit', 'wander', 'pulse',
  'sway', 'drift', 'figure8', 'zigzag', 'spiral', 'launch', 'swing', 'shake',
]

const ACTION_HINTS: Array<{ re: RegExp; action: string; note: string; agent?: string }> = [
  { re: /\b(dim|darken|warm|brighten|light)\b/i, action: 'update_lights', note: 'checking the light', agent: 'LightingTech' },
  { re: /\b(bloom|pixelate|glitch|dither|fx)\b/i, action: 'update_fx', note: 'on the comp', agent: 'VFXOperator' },
  { re: /\b(add|spawn|drop in|reveal)\b/i, action: 'spawn', note: 'bringing something in', agent: 'AssetAnimator' },
  { re: /\b(remove|delete|clear|hide)\b/i, action: 'remove', note: 'clearing it', agent: 'AssetAnimator' },
  { re: /\b(camera|frame|look at|zoom|dolly)\b/i, action: 'move_camera', note: 'reframing', agent: 'AssetAnimator' },
  { re: /\b(hold|pause|cut|play|action|record|loop)\b/i, action: 'playback', note: 'on transport', agent: 'Producer' },
]

function findObjectInText(text: string): { id: string; name: string; position: Vec3 } | null {
  const st = useEditorStore.getState()
  const lower = text.toLowerCase()

  if (PRONOUN_RE.test(lower) && st.selectedId) {
    const sel = st.objects.find((o) => o.id === st.selectedId)
    if (sel) return { id: sel.id, name: sel.name, position: sel.position }
  }

  const ballLike = /\b(ball|sphere|orb)\b/i.test(lower)
  if (ballLike) {
    const obj = st.objects.find((o) => {
      const n = o.name.toLowerCase()
      return n.includes('sphere') || n.includes('ball') || n.includes('orb')
    })
    if (obj) return { id: obj.id, name: obj.name, position: obj.position }
  }

  let best: { id: string; name: string; position: Vec3; score: number } | null = null
  for (const obj of st.objects) {
    const name = obj.name.toLowerCase()
    if (name.length < 2) continue
    if (lower.includes(name)) {
      const score = name.length
      if (!best || score > best.score) best = { id: obj.id, name: obj.name, position: obj.position, score }
    }
  }
  return best ? { id: best.id, name: best.name, position: best.position } : null
}

function findMotion(text: string): string | undefined {
  const lower = text.toLowerCase()
  for (const word of MOTION_WORDS) {
    if (lower.includes(word)) return word
  }
  if (/\b(loop|repeat|ping[- ]?pong)\b/i.test(lower)) return 'arc'
  return undefined
}

function resolveAgent(text: string, fallback: string): string {
  const m = text.match(AGENT_RE)
  if (m) return `Agent${m[1]}`
  return fallback
}

function buildNote(objName: string | undefined, motion: string | undefined, action?: string): string {
  if (objName && motion) return `on ${objName}, ${motion}`
  if (objName) return `heading to ${objName}`
  if (motion) return `${motion} incoming`
  if (action === 'update_lights') return 'checking the light'
  if (action === 'update_fx') return 'on the comp'
  if (action === 'playback') return 'on transport'
  return 'on it'
}

/** Synchronous guess from command text + live store. Returns null when nothing to react to. */
export function guessIntent(text: string): IntentGuess | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const obj = findObjectInText(trimmed)
  const motion = findMotion(trimmed)

  let roughAction: string | undefined
  let defaultAgent = 'AssetAnimator'
  for (const hint of ACTION_HINTS) {
    if (hint.re.test(trimmed)) {
      roughAction = hint.action
      if (hint.agent) defaultAgent = hint.agent
      break
    }
  }

  if (motion || /\b(animate|move|take|give|make)\b/i.test(trimmed)) {
    roughAction = roughAction ?? 'animate'
    defaultAgent = 'AssetAnimator'
  }

  const agent = resolveAgent(trimmed, defaultAgent)
  const note = buildNote(obj?.name, motion, roughAction)

  if (!obj && !motion && !roughAction && !AGENT_RE.test(trimmed)) {
    return null
  }

  return {
    agent,
    targetObjectId: obj?.id,
    targetName: obj?.name,
    roughAction,
    motion,
    note,
    targetPosition: obj?.position,
  }
}
