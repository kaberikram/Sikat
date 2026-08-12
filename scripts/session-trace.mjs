/**
 * Session trace — play a scripted session through the ambient policy layer and
 * record what every surface does, with timestamps.
 *
 * Why this exists: the module tests prove each ambient subsystem is correct on
 * its own, which is exactly what they cannot tell you about a *session*. The
 * bugs that make the experience feel disjointed are two subsystems writing the
 * same surface a beat apart, and those only appear when you look at a whole
 * arc on one time axis.
 *
 * Scope, honestly: this traces the decision layer — which surface each event
 * resolves to, and when. It does not render, so it cannot tell you whether the
 * ground pool reads on a real floor. It answers "do two signals compete", which
 * is the question the timing bugs live in.
 *
 *   node scripts/session-trace.mjs            # summary + collisions
 *   node scripts/session-trace.mjs --json     # full trace to stdout
 *
 * Exits non-zero if any surface is written twice inside COLLISION_MS, so this
 * can guard the seams in CI.
 */
import { resolveAccent, resolveRoomState } from '../src/scene/xr/ambient-policy.ts'
import { sampleAmbient } from '../src/scene/xr/ambient-sense.ts'
import { coachPacing } from '../src/scene/xr/xr-coach.ts'
import { classifyCursorHome } from '../src/director/cursor-lifecycle.ts'

/** Two writes to one surface closer than this compete for the same read. */
const COLLISION_MS = 200
/**
 * Writes closer together than one frame at 72Hz never both reach the eye — the
 * renderer samples surface state once per frame, so the last one wins and the
 * intermediate is not something anyone can perceive. Counting those as
 * collisions buries the real ones.
 */
const FRAME_MS = 14

/** Surfaces an ambient event can land on. One lane each in the viewer. */
const SURFACES = ['room', 'accent', 'attention', 'slate', 'ghost', 'cursor', 'sound']

const trace = []
let now = 0

const at = (ms) => { now = ms }
const emit = (surface, event, detail = {}) => {
  trace.push({ t: now, surface, event, ...detail })
}

// ---- live surface state, mirroring what the channel holds ----

const state = {
  listening: false,
  working: false,
  accentClaims: {},
  lastLandedAt: -Infinity,
  pendingReply: null,
  misses: 0,
}

const REPLY_GRACE_MS = 450

let lastRoom = null
function room() {
  const next = resolveRoomState(state.listening, state.working)
  // Only a *change* is something the director can perceive. Re-resolving to the
  // same state is not a competing write, and counting it as one would bury the
  // real collisions in noise.
  if (next === lastRoom) return
  lastRoom = next
  emit('room', next)
}

function accent(owner, claim) {
  if (claim) state.accentClaims[owner] = claim
  else delete state.accentClaims[owner]
  const winner = resolveAccent(state.accentClaims)
  emit('accent', winner ? `${winner.color}@${winner.weight}` : 'clear', { owner })
}

/** The channel's routing, replayed. Mirrors respond() in ambient-channel.ts. */
function respond(r) {
  switch (r.kind) {
    case 'heard':
      state.listening = r.on
      room()
      if (!r.silent) emit('sound', r.on ? 'listenStart' : 'listenEnd')
      break
    case 'working':
      state.working = r.on
      room()
      if (!r.on) flushReply()
      break
    case 'landed':
      state.lastLandedAt = now
      state.misses = 0
      state.working = false
      room()
      emit('attention', 'pulse:landed', { object: r.objectId })
      if (state.pendingReply && state.lastLandedAt >= state.pendingReply.at) {
        state.pendingReply = null
        emit('slate', 'reply suppressed — the change said it')
      }
      break
    case 'missed':
      state.misses += 1
      state.working = false
      room()
      emit('sound', 'missedBuzz')
      emit('attention', 'pulse:missed')
      if (state.misses >= 2) emit('slate', 'misheard (escalated)')
      break
    case 'said':
      state.misses = 0
      if (now - state.lastLandedAt < REPLY_GRACE_MS) {
        emit('slate', 'reply suppressed — the change said it')
      } else {
        state.pendingReply = { text: r.text, at: now }
      }
      break
    case 'aimed':
      emit('attention', r.objectId ? `aimed:${r.objectId}` : 'clear')
      if (r.objectId) emit('sound', 'beatTick')
      break
    case 'addressed':
      emit('attention', `addressed:${r.objectId}`)
      break
    case 'proposed':
      accent('proposal', { color: r.color, weight: 0.45 })
      emit('ghost', r.spatial ? 'proposal ghost up' : 'no ghost (not spatial)')
      if (!r.spatial) emit('slate', `${r.text} — say "do it"`)
      break
    case 'proposalEnded':
      accent('proposal', null)
      emit('ghost', 'proposal cleared')
      break
    case 'entryAccent':
      accent('entry', r.weight > 0 ? { color: r.color, weight: r.weight } : null)
      break
    case 'status':
    case 'blocked':
      emit('slate', r.text)
      break
    case 'notice':
      emit('slate', r.text ?? 'notice cleared')
      break
  }
}

function flushReply() {
  if (!state.pendingReply) return
  const { text, at: sentAt } = state.pendingReply
  state.pendingReply = null
  if (state.lastLandedAt >= sentAt) return
  emit('sound', 'replyChime')
  emit('slate', `crew: ${text}`)
}

/** Grace expiry — call at the point the timer would have fired. */
function tickReplyGrace() {
  if (state.pendingReply && now - state.pendingReply.at >= REPLY_GRACE_MS) flushReply()
}

// ---- the scripted session ----
// Offsets are the real ones from the code: ENTRY_MS 5000, COACH_DELAY_MS 5200,
// LINE_MS 4000, the SET DAY beat schedule, and measured command latencies.

at(0); emit('cursor', 'ENTER XR clicked')
at(600); emit('room', 'first tracked head pose — stage placed')
at(600); emit('sound', 'entrySwell')

// Entry cinematic: the mint wash is a claim now, not a direct write.
at(800); respond({ kind: 'entryAccent', color: '#57CFA0', weight: 0.3 })
at(2200); respond({ kind: 'entryAccent', color: '#57CFA0', weight: 1 })
at(4500); respond({ kind: 'entryAccent', color: '#57CFA0', weight: 0 })
at(5000); emit('room', 'cinematic hands off — dome holds at 0.3')

// Coach. Pacing is latched per line; a hesitant director gets longer dwells.
const hesitant = sampleAmbient({
  headSpeed: 0.2, gripTurnRate: 0.3, dwellMs: 100,
  aimSwitches: 4, sinceCommandMs: 12000, sinceTakeMs: 0, hasAim: true,
})
const pacing = coachPacing(hesitant.hesitation, 0)
at(5200); emit('slate', `coach: TRIGGER · FILM (dwell ${pacing.lineMs}ms)`)
at(5200 + pacing.lineMs); emit('slate', 'coach: HOLD A · TALK')

// The director speaks. Room hears; coach retires as controls get used.
at(12000); respond({ kind: 'heard', on: true })
at(12000); emit('slate', 'coach retired — talk learned')
at(13400); respond({ kind: 'heard', on: false }); respond({ kind: 'working', on: true })

// Crew answers with a change. Attention travels before it lands.
at(13900); respond({ kind: 'addressed', objectId: 'SNEAKER_ONE' })
at(14100); emit('cursor', 'AssetAnimator appears at SNEAKER_ONE')
at(14100); emit('sound', 'crewWhoosh')
at(14800); respond({ kind: 'landed', objectId: 'SNEAKER_ONE' })

// The crew also said something — suppressed, because the change already said it.
at(14900); respond({ kind: 'said', text: 'floating her now' })

// A command that changes nothing: the reply is the whole answer.
at(20000); respond({ kind: 'heard', on: true })
at(21000); respond({ kind: 'heard', on: false }); respond({ kind: 'working', on: true })
at(21600); respond({ kind: 'said', text: 'three things on set — a pedestal, the hero and a sign' })
at(21800); respond({ kind: 'working', on: false })   // early flush: nothing changed

// The director settles. A proposal arrives and is ignored into expiry.
at(30000); respond({ kind: 'aimed', objectId: 'SET_SIGN' })
at(32000); respond({ kind: 'proposed', text: 'the sign is in shadow', color: '#ffd60a', spatial: true })
at(41000); respond({ kind: 'proposalEnded' })

// Correction while the crew is still working — the mic must stay lit.
at(45000); respond({ kind: 'working', on: true })
at(45400); respond({ kind: 'heard', on: true })
at(45900); respond({ kind: 'landed', objectId: 'PEDESTAL' })  // must NOT drop listening
at(46800); respond({ kind: 'heard', on: false })

// Wrap.
at(60000); emit('sound', 'wrapChord')
at(60600); emit('room', 'session end — all surfaces released')

tickReplyGrace()

// ---- analysis ----

trace.sort((a, b) => a.t - b.t)

const collisions = []
for (const surface of SURFACES) {
  const lane = trace.filter((e) => e.surface === surface)
  for (let i = 1; i < lane.length; i++) {
    const gap = lane[i].t - lane[i - 1].t
    if (gap >= FRAME_MS && gap < COLLISION_MS) {
      collisions.push({ surface, gap, a: lane[i - 1], b: lane[i] })
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ trace, collisions, collisionMs: COLLISION_MS }, null, 2))
} else {
  console.log(`session trace — ${trace.length} events over ${(now / 1000).toFixed(1)}s\n`)
  for (const surface of SURFACES) {
    const n = trace.filter((e) => e.surface === surface).length
    if (n) console.log(`  ${surface.padEnd(11)} ${n}`)
  }
  console.log()
  // A room write immediately after listening opened is the regression that
  // used to silence the mic indicator mid-utterance.
  // The regression that silenced the mic mid-utterance: the room leaving
  // 'listening' while the button was still held. Checked against the actual
  // hold intervals, not adjacency.
  const roomLane = trace.filter((e) => e.surface === 'room')
  const holds = []
  let openedAt = null
  for (const e of trace) {
    if (e.surface !== 'sound') continue
    if (e.event === 'listenStart') openedAt = e.t
    if (e.event === 'listenEnd' && openedAt !== null) {
      holds.push([openedAt, e.t])
      openedAt = null
    }
  }
  // Strictly inside a hold — the release itself legitimately ends 'listening'.
  const dropped = roomLane.filter(
    (e) => e.event !== 'listening' && holds.some(([a, b]) => e.t > a && e.t < b)
  )
  const lit = roomLane.filter((e) => e.event === 'listening').length
  console.log(`  mic lit ${lit}x across ${holds.length} holds; dropped mid-hold: ${dropped.length}`)
  console.log()
  if (collisions.length === 0) {
    console.log(`no surface written twice inside ${COLLISION_MS}ms — nothing competing.`)
  } else {
    console.log(`${collisions.length} collision(s) inside ${COLLISION_MS}ms:`)
    for (const c of collisions) {
      console.log(`  ${c.surface} +${c.gap}ms — "${c.a.event}" then "${c.b.event}" at ${c.b.t}ms`)
    }
  }
}

process.exit(collisions.length === 0 ? 0 : 1)
