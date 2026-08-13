import React from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'dark' | 'ghost' | 'danger' | 'pink' | 'wash'
export type ButtonSize = 'sm' | 'md'

// Hover settles, press springs back — overshoot is only for the release of an
// actual press, never for a pointer drifting across the control.
const BASE =
  'inline-flex items-center justify-center gap-1 rounded-full font-sans font-semibold cursor-pointer select-none ' +
  'border border-transparent ' +
  'transition-[scale,background-color,color,box-shadow] duration-150 ease-[var(--ease-settle)] ' +
  'active:scale-[var(--press-scale)] active:ease-[var(--ease-spring)] ' +
  'disabled:opacity-50 disabled:pointer-events-none ui-hover-lift'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white shadow-[var(--shadow-chip)]',
  dark: 'bg-ink text-white shadow-[var(--shadow-chip)]',
  wash: 'bg-chip text-ink-soft shadow-none',
  ghost: 'bg-transparent shadow-none text-ink-soft',
  danger: 'bg-rec text-white shadow-[var(--shadow-chip)]',
  pink: 'bg-ink text-white shadow-[var(--shadow-chip)]',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-[30px] px-[13px] text-[12px]',
  md: 'h-[40px] px-[14px] text-[12.5px]',
}

/** Class string for pill buttons — for non-<button> elements (labels, links). */
export function buttonCn(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className)
}

interface ButtonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  title?: string
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  children?: React.ReactNode
}

export function Button({ variant = 'primary', size = 'md', className, type, ...rest }: ButtonProps) {
  return <button type={type ?? 'button'} className={buttonCn(variant, size, className)} {...rest} />
}
