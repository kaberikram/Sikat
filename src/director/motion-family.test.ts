import assert from 'node:assert/strict'
import test from 'node:test'

import { sameMotionFamily } from './motion-family.ts'

test('SET_KEYFRAMES and ANIMATE_OBJECT are one motion family', () => {
  assert.equal(sameMotionFamily('SET_KEYFRAMES', 'ANIMATE_OBJECT'), true)
  assert.equal(sameMotionFamily('ANIMATE_OBJECT', 'SET_KEYFRAMES'), true)
  assert.equal(sameMotionFamily('SET_KEYFRAMES', 'SET_KEYFRAMES'), true)
  assert.equal(sameMotionFamily('ANIMATE_OBJECT', 'TRANSFORM_OBJECT'), false)
  assert.equal(sameMotionFamily('SET_MATERIAL', 'SET_KEYFRAMES'), false)
})
