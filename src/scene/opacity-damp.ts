/** Frame-rate-stable exponential approach toward a target value. */
export function dampToward(
  current: number,
  target: number,
  dtMs: number,
  tauMs: number
): number {
  if (tauMs <= 0) return target
  const dt = Math.max(0, dtMs)
  if (dt === 0) return current
  const alpha = 1 - Math.exp(-dt / tauMs)
  return current + (target - current) * alpha
}
