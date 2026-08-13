/** ANIMATE_OBJECT (catalog synth) and SET_KEYFRAMES (authored path) are one
 *  motion family — a newer packet on the same object replaces the other. */
const MOTION_COMMANDS = new Set(['ANIMATE_OBJECT', 'SET_KEYFRAMES'])

export function sameMotionFamily(a: string, b: string): boolean {
  if (a === b) return true
  return MOTION_COMMANDS.has(a) && MOTION_COMMANDS.has(b)
}
