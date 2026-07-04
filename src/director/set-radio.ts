/**
 * Set radio — short verbal ACKs when crew agents pick up work.
 * Uses window.speechSynthesis; no React imports.
 */

const AGENT_ACKS: Record<string, string> = {
  Producer: 'Copy.',
  DirectorsAssistant: 'On it.',
  LightingTech: 'Lighting.',
  AssetAnimator: 'Moving.',
  VFXOperator: 'FX.',
}

const MAX_TRACKED_COMMANDS = 24

let radioEnabled = true
const spokenByCommand = new Map<string, Set<string>>()

export function isRadioEnabled(): boolean {
  return radioEnabled
}

export function setRadioEnabled(enabled: boolean): void {
  radioEnabled = enabled
  if (!enabled && typeof window !== 'undefined') window.speechSynthesis?.cancel()
}

function synthesisAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

function trackAgentSpoken(forCommandId: string, agent: string): boolean {
  let spoken = spokenByCommand.get(forCommandId)
  if (!spoken) {
    spoken = new Set()
    spokenByCommand.set(forCommandId, spoken)
    if (spokenByCommand.size > MAX_TRACKED_COMMANDS) {
      const oldest = spokenByCommand.keys().next().value
      if (oldest) spokenByCommand.delete(oldest)
    }
  }
  if (spoken.has(agent)) return false
  spoken.add(agent)
  return true
}

/**
 * Speak a one-word ACK when an agent goes active. Each agent speaks at most
 * once per `forCommandId`. No-op when radio is muted or speech API unavailable.
 */
export function speakAck(
  agent: string,
  _note?: string,
  forCommandId?: string | null
): void {
  if (!radioEnabled || !synthesisAvailable()) return
  if (forCommandId && !trackAgentSpoken(forCommandId, agent)) return

  const perfMatch = agent.match(/^Agent(\d)$/i)
  if (perfMatch) {
    const phrase = `Agent ${perfMatch[1]}, copy.`
    const utterance = new SpeechSynthesisUtterance(phrase)
    utterance.rate = 1.05
    utterance.pitch = 0.95
    utterance.volume = 0.85
    window.speechSynthesis.speak(utterance)
    return
  }

  const phrase = AGENT_ACKS[agent] ?? 'Copy.'
  const utterance = new SpeechSynthesisUtterance(phrase)
  utterance.rate = 1.05
  utterance.pitch = 0.95
  utterance.volume = 0.85
  window.speechSynthesis.speak(utterance)
}

/** Test helper — reset module state between unit checks. */
export function resetSetRadioForTests(): void {
  radioEnabled = true
  spokenByCommand.clear()
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
}
