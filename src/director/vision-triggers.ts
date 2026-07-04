/**
 * Heuristic: attach a viewfinder JPEG when the director's words imply visual judgment.
 * Never used on heartbeat — only when sending a user_command.
 */

const VISION_PREFIX = /^\?(look|vision)\b/i

const VISION_PATTERNS: RegExp[] = [
  VISION_PREFIX,
  /\blook at\b/i,
  /\b(check|see) (the )?(shot|frame|viewfinder|composition)\b/i,
  /\bhow does (this|it) look\b/i,
  /\btoo (dark|bright|moody|flat)\b/i,
  /\bcomposition\b/i,
  /\bviewfinder\b/i,
  /\b(check|see) (this|it|the scene)\b/i,
  /\bframe (this|the shot|it)\b/i,
]

export function shouldAttachVision(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return VISION_PATTERNS.some((re) => re.test(trimmed))
}
