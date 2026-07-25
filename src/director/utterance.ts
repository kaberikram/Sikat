/**
 * Utterance normalization — the gap between what a director SAYS and what the
 * grammar reads.
 *
 * Typed cues arrive clean ("golden hour"). Spoken ones do not: Deepgram's
 * smart_format capitalizes and punctuates ("Golden hour."), people open with
 * fillers ("okay, golden hour"), wrap requests in politeness ("can you dim the
 * lights?"), address the crew ("crew, golden hour"), trail off with courtesy
 * ("enable bloom, thanks"), restart mid-sentence ("add a, add a red box"), and
 * say numbers as words ("up two over three seconds"). Every one of those used
 * to land as "didn't catch that".
 *
 * Rather than loosening every regex in the grammar — which would make near
 * misses match the wrong command — this produces an ordered list of readings
 * of one utterance, most faithful first. Callers try each in turn and take the
 * first that resolves. The verbatim text is always candidate 0, so nothing
 * that works today can regress, and cues whose literal wording matters ("back
 * to one", "play once") still win before any rewriting happens.
 */

/** Straighten smart punctuation so `don'?t`-style patterns match dictation. */
function unifyPunctuation(text: string): string {
  return text
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, ' ')
}

/**
 * Punctuation + whitespace cleanup. Commas survive — they carry clause
 * structure the later passes read.
 */
export function tidyUtterance(text: string): string {
  return unifyPunctuation(text)
    .replace(/[.!?;:]+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,'"-]+/, '')
    .replace(/[\s,'"-]+$/, '')
    .trim()
}

/**
 * Discourse openers people can't help saying. Stripped only from the front, so
 * "move the box right" keeps its direction and "yes" alone still reads as the
 * suggestion-accept cue (verbatim runs first).
 */
const LEAD_FILLER =
  /^(?:and|but|so|then|um+|uh+|er+|ah+|oh|hm+|mm+|okay|ok|well|alright|all right|right|yeah|yep|yup|sure|now|hey|hi|like|actually|basically|just|please|listen|look|see)\b[,\s]+/i

/** "crew, …", "hey director, …" — addressing the set before the cue. */
const LEAD_ADDRESS = /^(?:hey\s+|ok\s+|okay\s+)?(?:crew|director|sikat|computer|assistant)\b[,\s]+/i

/** Request framing that wraps the real instruction. */
const LEAD_REQUEST: RegExp[] = [
  /^(?:do me a favor and|go ahead and|why don'?t you|why don'?t we|how about you|how about we|how about)\s+/i,
  /^(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?(?:go ahead and\s+)?/i,
  /^(?:let'?s|let us)\s+(?:please\s+)?(?:do|go with|try|have|make it|see)?\s*/i,
  /^(?:i|we)\s+(?:want|need)\s+(?:you\s+to|to)\s+/i,
  /^(?:i|we)'?d?\s+(?:would\s+)?like\s+(?:you\s+to|to)\s+/i,
  /^(?:you\s+)?(?:should|could|can)\s+/i,
  /^(?:please)\s+/i,
]

/**
 * "give me a red box" / "i want a red box" — a wish for an object is a spawn.
 * Rewritten rather than stripped so the noun phrase keeps a verb.
 */
const WISH_SPAWN =
  /^(?:(?:i|we)\s+(?:want|need)|(?:i|we)'?d?\s+(?:would\s+)?like|give me|get me|gimme|bring me|throw in|put in)\s+(?=(?:a|an|the|some)\s+)/i

/** Courtesy and hedges that trail the instruction. */
const TRAIL_COURTESY =
  /[,\s]+(?:please|thanks|thank you|thank you very much|cheers|for me|for us|now|real quick|quick|if you can|if you could|would you|will you|okay|ok|alright|yeah)$/i

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  thirty: '30', forty: '40', fifty: '50', sixty: '60', ninety: '90',
}

const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi')

/** "up two over three seconds" → "up 2 over 3 seconds". */
function digitizeNumbers(text: string): string {
  return text.replace(NUMBER_WORD_RE, (word) => NUMBER_WORDS[word.toLowerCase()] ?? word)
}

/** Peel leading fillers / address / request framing until nothing more comes off. */
function stripLeadIns(text: string): string {
  let out = text
  for (let pass = 0; pass < 6; pass++) {
    const before = out
    out = out.replace(LEAD_ADDRESS, '').replace(LEAD_FILLER, '')
    for (const re of LEAD_REQUEST) {
      const next = out.replace(re, '')
      // A wrapper that eats the whole utterance wasn't a wrapper.
      if (next.trim()) out = next
    }
    out = out.replace(WISH_SPAWN, 'add ')
    out = out.trim()
    if (out === before || !out) break
  }
  return out || text
}

function stripTrailers(text: string): string {
  let out = text
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(TRAIL_COURTESY, '').trim()
    if (next === out || !next) break
    out = next
  }
  return out || text
}

function push(list: string[], seen: Set<string>, candidate: string): void {
  const value = candidate.trim()
  if (!value) return
  const key = value.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  list.push(value)
}

/**
 * Readings of one utterance, most faithful first. Always non-empty for
 * non-blank input, and `[0]` is always the caller's own trimmed text.
 */
export function utteranceCandidates(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const verbatim = raw.trim()
  if (!verbatim) return out
  push(out, seen, verbatim)

  const tidy = tidyUtterance(verbatim)
  push(out, seen, tidy)

  const stripped = stripTrailers(stripLeadIns(tidy))
  push(out, seen, stripped)
  push(out, seen, digitizeNumbers(stripped))

  // Mid-utterance restarts ("add a, add a red box") and any opener the lists
  // above don't know: try each comma-delimited tail, longest first.
  const parts = stripped.split(',').map((p) => p.trim()).filter(Boolean)
  for (let i = 1; i < parts.length; i++) {
    const tail = stripTrailers(stripLeadIns(parts.slice(i).join(', ')))
    push(out, seen, tail)
    push(out, seen, digitizeNumbers(tail))
  }

  return out
}

/**
 * The single best reading — what to show back to the director and hand to the
 * server. Keeps the words they actually said; only cleans up the dictation.
 */
export function cleanUtterance(raw: string): string {
  return tidyUtterance(raw) || raw.trim()
}
