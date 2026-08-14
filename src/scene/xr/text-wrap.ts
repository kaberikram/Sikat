/** Trim `text` so `text + suffix` measures at or under `maxW`. */
export function fitLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  suffix = '…'
): string {
  if (ctx.measureText(text).width <= maxW) return text
  let value = text
  while (value.length > 0 && ctx.measureText(`${value}${suffix}`).width > maxW) {
    value = value.slice(0, -1)
  }
  return value.length > 0 ? `${value}${suffix}` : suffix
}

/**
 * Wrap into at most `maxLines` and never let a measured line exceed `maxW`.
 * Overlong tokens (CORE_SPHERE, PrimitiveCube, …) are ellipsized in place
 * rather than painted through the bubble's right edge.
 */
export function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0 || maxLines < 1) return []
  const rows: string[] = []
  let row = ''
  for (const word of words) {
    const piece = ctx.measureText(word).width > maxW ? fitLine(ctx, word, maxW) : word
    if (!row) {
      row = piece
      continue
    }
    const next = `${row} ${piece}`
    if (ctx.measureText(next).width <= maxW) {
      row = next
      continue
    }
    if (rows.length + 1 >= maxLines) {
      // Fold the leftover word into this last line and ellipsize, so
      // "CORE_SPHERE, Primitive…" still shows instead of dropping it.
      row = fitLine(ctx, next, maxW)
      break
    }
    rows.push(row)
    row = piece
  }
  if (row && rows.length < maxLines) rows.push(row)
  if (rows.length === 0) return [fitLine(ctx, words[0], maxW)]
  return rows.map((line) =>
    ctx.measureText(line).width > maxW ? fitLine(ctx, line, maxW) : line
  )
}
