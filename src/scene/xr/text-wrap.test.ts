import assert from 'node:assert/strict'
import test from 'node:test'

import { fitLine, wrapLines } from './text-wrap.ts'

/** Stub canvas: each character is 10px, matching a monospace measureText. */
function stubCtx(): CanvasRenderingContext2D {
  return {
    measureText: (s: string) => ({ width: s.length * 10 }),
  } as CanvasRenderingContext2D
}

test('a short crew say stays on one line', () => {
  const lines = wrapLines(stubCtx(), 'working the take', 400, 2)
  assert.deepEqual(lines, ['working the take'])
})

test('a long crew say wraps instead of overflowing the bubble', () => {
  const say = 'No blue ball on set — only CORE_SPHERE, PrimitiveCube'
  const maxW = 280
  const lines = wrapLines(stubCtx(), say, maxW, 2)
  assert.ok(lines.length >= 2, 'expected a wrap onto a second line')
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.ok(
      stubCtx().measureText(line).width <= maxW,
      `"${line}" is ${stubCtx().measureText(line).width}px, wider than ${maxW}`
    )
  }
  assert.ok(lines.some((line) => line.includes('CORE_SPHERE')))
})

test('an overlong token is ellipsized to maxW, never painted through the edge', () => {
  const maxW = 80
  const lines = wrapLines(stubCtx(), 'CORE_SPHERE_WITH_A_VERY_LONG_SUFFIX', maxW, 2)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].endsWith('…'))
  assert.ok(stubCtx().measureText(lines[0]).width <= maxW)
})

test('a third line is folded into an ellipsis on the last allowed line', () => {
  const maxW = 80
  const lines = wrapLines(stubCtx(), 'one two three four five six seven', maxW, 2)
  assert.equal(lines.length, 2)
  assert.ok(lines[1].endsWith('…'))
  for (const line of lines) {
    assert.ok(stubCtx().measureText(line).width <= maxW)
  }
})

test('fitLine never returns a string wider than maxW', () => {
  const fitted = fitLine(stubCtx(), 'abcdefghijklmnopqrstuvwxyz', 50)
  assert.ok(fitted.endsWith('…'))
  assert.ok(stubCtx().measureText(fitted).width <= 50)
})
