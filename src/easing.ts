import type { Easing } from './director/protocol'

const EASING: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t * t,
  easeOut: (t) => 1 - (1 - t) ** 3,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
}

export function ease(t: number, mode: Easing): number {
  return (EASING[mode] ?? EASING.easeInOut)(t)
}

export function getEaseFn(mode: Easing): (t: number) => number {
  return EASING[mode] ?? EASING.easeInOut
}
