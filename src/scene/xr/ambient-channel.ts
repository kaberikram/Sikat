/**
 * The ambient channel — one place that decides where an answer lands.
 *
 * The set answers by changing, not by captioning. Every system response goes
 * through `respond()`, which routes it to the world (the object lights up), the
 * room (the stage ring hears and thinks), or — only when neither can carry it —
 * the slate. Keeping that policy in one module is what stops "slate as
 * fallback" from decaying back into "slate for everything" one call site at a
 * time.
 *
 * Two rules do most of the work:
 *
 * 1. **A miss is a pulse; two in a row is text.** The world channel is genuinely
 *    worse than words at explaining a failure, so the second consecutive miss
 *    escalates and shows the crew's own redirect.
 *
 * 2. **The crew's words only appear when the change didn't already say it.** If
 *    a packet lands within the grace window, the scene change *is* the reply and
 *    printing it too is captioning. If nothing changed — a question, a refusal,
 *    chitchat — the words are the whole answer and they belong on the slate.
 */
import { beatTick, cutTick, listenEnd, listenStart, missedBuzz, replyChime } from '../../director/sound'
import { useEditorStore } from '../../store'
import { attendTo, clearAttention, pulseAttention } from './attention-field'
import type { DirectorSlate } from './director-slate'
import { setRoomAccent, setRoomLevel, setRoomState } from './room-response'

export type Response =
  /** Aim moved. `objectId` null means the ray left everything. */
  | { kind: 'aimed'; objectId: string | null; name?: string | null }
  /** A command is about to change this object — attention travels ahead of the act. */
  | { kind: 'addressed'; objectId: string }
  /**
   * Push-to-talk opened / closed. `silent` skips the earcon for a press that
   * never actually opened a session — the release whoosh means "that went to
   * the crew", and playing it when nothing was sent is a small lie.
   */
  | { kind: 'heard'; on: boolean; silent?: boolean }
  /** Live mic RMS while listening. */
  | { kind: 'level'; rms: number }
  /** The crew is working on it. */
  | { kind: 'working'; on: boolean }
  /** The set visibly changed. */
  | { kind: 'landed'; objectId?: string | null }
  /** Didn't catch it. `text` is the crew's own redirect when the server sent one. */
  | { kind: 'missed'; text?: string | null }
  /** The crew's own words. */
  | { kind: 'said'; text: string }
  /** Something is wrong and the world cannot explain it — always text. */
  | { kind: 'blocked'; text: string }
  /** Plain information the world has no way to carry ("export on desktop"). */
  | { kind: 'status'; text: string }
  /**
   * The crew is offering something unprompted. `spatial` means a ghost of the
   * outcome is already standing on the set, so the words would be redundant;
   * when it's false there is nothing to look at and the offer needs saying.
   */
  | { kind: 'proposed'; text: string; color: string; spatial: boolean }
  /** Sticky guidance ("pick up the right controller"). Always text; null clears. */
  | { kind: 'notice'; text: string | null }
  /** Link state. */
  | { kind: 'offline'; on: boolean }

/** How long a reply waits to see whether the scene answers for it. */
const REPLY_GRACE_MS = 1200
/** Misses beyond this many in a row stop being ambient and become words. */
const MISS_ESCALATE_AT = 2
/** How long the room wears a proposing crew member's colour. */
const PROPOSAL_ACCENT_MS = 2200
const PROPOSAL_ACCENT_WEIGHT = 0.45

let slate: DirectorSlate | null = null

let consecutiveMisses = 0
let lastLandedAt = 0
let pendingReply: { text: string; at: number; timer: ReturnType<typeof setTimeout> } | null = null
let proposalAccentTimer: ReturnType<typeof setTimeout> | null = null
/** The object the aim is resting on — what a miss or a landing pulses. */
let aimedId: string | null = null

export function bindAmbientChannel(next: DirectorSlate | null): void {
  slate = next
  consecutiveMisses = 0
  lastLandedAt = 0
  clearPendingReply()
}

function clearPendingReply(): void {
  if (!pendingReply) return
  clearTimeout(pendingReply.timer)
  pendingReply = null
}

/** The slate only speaks for things the world can't say. */
function toSlate(fn: (s: DirectorSlate) => void): void {
  if (slate) fn(slate)
}

function flushReply(): void {
  if (!pendingReply) return
  const { text, at } = pendingReply
  pendingReply = null
  // The set changed while we waited — the change was the answer.
  if (lastLandedAt >= at) return
  replyChime()
  toSlate((s) => s.setReply(text))
}

export function respond(r: Response): void {
  switch (r.kind) {
    case 'aimed': {
      aimedId = r.objectId
      if (r.objectId) {
        attendTo(r.objectId, 'aimed')
        beatTick()
      } else {
        clearAttention()
      }
      return
    }

    case 'addressed': {
      // Attention travels to the target before the change lands, so you can
      // see what the crew is about to touch while there is still time to speak.
      attendTo(r.objectId, 'addressed')
      return
    }

    case 'heard': {
      setRoomState(r.on ? 'listening' : 'idle')
      if (!r.silent) {
        if (r.on) listenStart()
        else listenEnd()
      }
      toSlate((s) => s.setListening(r.on))
      return
    }

    case 'level': {
      setRoomLevel(r.rms)
      return
    }

    case 'working': {
      setRoomState(r.on ? 'working' : 'idle')
      toSlate((s) => s.setThinking(r.on))
      return
    }

    case 'landed': {
      lastLandedAt = Date.now()
      consecutiveMisses = 0
      setRoomState('idle')
      const id = r.objectId ?? aimedId
      if (id) pulseAttention(id, 'landed')
      else cutTick()
      // A reply already waiting has just been answered by the scene itself.
      if (pendingReply && lastLandedAt >= pendingReply.at) clearPendingReply()
      toSlate((s) => s.setThinking(false))
      return
    }

    case 'missed': {
      consecutiveMisses += 1
      setRoomState('idle')
      missedBuzz()
      if (aimedId) pulseAttention(aimedId, 'missed')
      // One miss reads fine as a pulse. Two in a row means the ambient channel
      // isn't landing, so say it in words.
      if (consecutiveMisses >= MISS_ESCALATE_AT) {
        toSlate((s) => s.setMisheard(r.text ?? undefined))
      } else {
        toSlate((s) => s.setThinking(false))
      }
      return
    }

    case 'said': {
      consecutiveMisses = 0
      clearPendingReply()
      const at = Date.now()
      // Already answered by a change that landed a moment ago.
      if (at - lastLandedAt < REPLY_GRACE_MS) {
        toSlate((s) => s.setThinking(false))
        return
      }
      pendingReply = { text: r.text, at, timer: setTimeout(flushReply, REPLY_GRACE_MS) }
      return
    }

    case 'blocked': {
      setRoomState('idle')
      toSlate((s) => s.setLastSent(r.text))
      return
    }

    case 'status': {
      toSlate((s) => s.setLastSent(r.text))
      return
    }

    case 'proposed': {
      // Either way the room takes on the proposing crew member's colour for a
      // moment, so an offer is attributable at a glance.
      setRoomAccent(r.color, PROPOSAL_ACCENT_WEIGHT)
      if (proposalAccentTimer) clearTimeout(proposalAccentTimer)
      proposalAccentTimer = setTimeout(() => {
        setRoomAccent(null)
        proposalAccentTimer = null
      }, PROPOSAL_ACCENT_MS)
      // A relight or an FX tweak has no silhouette to stand in for it, and
      // inventing one would be a lie — so those still need words.
      if (!r.spatial) toSlate((s) => s.setLastSent(`${r.text} — say “do it”`))
      return
    }

    case 'notice': {
      toSlate((s) => s.setNotice(r.text))
      return
    }

    case 'offline': {
      toSlate((s) => s.setOffline(r.on))
      return
    }
  }
}

/** True while the headset is presenting — call sites that ride the socket guard on this. */
export function isXrActive(): boolean {
  return useEditorStore.getState().xrActive
}

export function resetAmbientChannel(): void {
  consecutiveMisses = 0
  lastLandedAt = 0
  aimedId = null
  clearPendingReply()
  if (proposalAccentTimer) {
    clearTimeout(proposalAccentTimer)
    proposalAccentTimer = null
    setRoomAccent(null)
  }
}
