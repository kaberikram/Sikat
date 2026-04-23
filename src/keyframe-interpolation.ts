/**
 * Linear interpolation for vector keyframe tracks. Reused by Scene and exporter.
 */
export function interpolateKeyframes(
  keyframes: Array<{
    time: number
    property: string
    value: [number, number, number]
  }>,
  time: number,
  property: string,
  defaultValue: [number, number, number]
): [number, number, number] {
  const kf = keyframes.filter((k) => k.property === property)
  if (kf.length === 0) return defaultValue
  if (kf.length === 1) return kf[0].value

  const nextIdx = kf.findIndex((k) => k.time > time)
  if (nextIdx === -1) return kf[kf.length - 1].value
  if (nextIdx === 0) return kf[0].value

  const prev = kf[nextIdx - 1]
  const next = kf[nextIdx]

  const alpha = (time - prev.time) / (next.time - prev.time)
  return [
    prev.value[0] + (next.value[0] - prev.value[0]) * alpha,
    prev.value[1] + (next.value[1] - prev.value[1]) * alpha,
    prev.value[2] + (next.value[2] - prev.value[2]) * alpha,
  ]
}
