import React from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'dark' | 'ghost' | 'danger' | 'pink'
export type ButtonSize = 'sm' | 'md'

const BASE =
  'inline-flex items-center justify-center gap-1 rounded-full font-sans font-semibold cursor-pointer select-none ' +
  'shadow-[var(--shadow-chip)] border border-[rgba(59,58,72,0.06)] ' +
  'transition-[transform,background-color,color,box-shadow] duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)] ' +
  'hover:-translate-y-px hover:shadow-[var(--shadow-soft)] active:scale-95 active:translate-y-0 ' +
  'disabled:opacity-50 disabled:pointer-events-none'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-candy-sun text-ink hover:bg-candy-sun-deep',
  dark: 'bg-ink text-white hover:bg-candy-sun-deep hover:text-ink',
  ghost: 'bg-transparent border-transparent shadow-none text-ink-soft hover:bg-[rgba(59,58,72,0.08)] hover:text-ink hover:shadow-none',
  danger: 'bg-rec text-white hover:bg-[#f2536b]',
  pink: 'bg-candy-pink-deep text-white hover:bg-[#e9639c]',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1 text-[11px]',
  md: 'px-4 py-1.5 text-[12px]',
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
