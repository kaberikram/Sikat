import React from 'react'
import { ChevronDown, ChevronRight, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { type PostProcessingStack, type VirtualCamera } from '../store'
import { patchCameraPostSection, type PostSectionId } from '../post-processing'
import { cn } from './cn'

const POST_STACK_SECTIONS: {
  id: PostSectionId
  label: string
  sliders: { key: string; label: string; min: number; max: number; step: number }[]
  toggles?: { key: string; label: string }[]
}[] = [
  {
    id: 'bloom',
    label: 'BLOOM',
    sliders: [
      { key: 'strength', label: 'Strength', min: 0, max: 2.5, step: 0.05 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.01 },
      { key: 'radius', label: 'Radius', min: 0, max: 1, step: 0.02 },
      { key: 'emissiveBoost', label: 'Surface glow', min: 0, max: 1.5, step: 0.05 },
      { key: 'emissiveIntensity', label: 'Glow intensity', min: 0, max: 3, step: 0.05 },
    ],
  },
  {
    id: 'pixelate',
    label: 'PIXELATE',
    sliders: [
      { key: 'pixelSize', label: 'Block size', min: 2, max: 24, step: 1 },
      { key: 'normalEdge', label: 'Normal edge', min: 0, max: 0.8, step: 0.05 },
      { key: 'depthEdge', label: 'Depth edge', min: 0, max: 0.8, step: 0.05 },
    ],
  },
  {
    id: 'cellShading',
    label: 'CELL_SHADING',
    sliders: [{ key: 'outlineScale', label: 'Outline inflate', min: 1, max: 1.18, step: 0.005 }],
  },
  {
    id: 'glitch',
    label: 'GLITCH',
    sliders: [
      { key: 'intensity', label: 'Jitter amount', min: 0, max: 0.5, step: 0.01 },
      { key: 'rate', label: 'Jitter rate', min: 0, max: 0.35, step: 0.01 },
    ],
  },
  {
    id: 'dither',
    label: 'DITHER',
    sliders: [
      { key: 'pixelSize', label: 'Dot size', min: 1, max: 10, step: 1 },
      { key: 'levels', label: 'Color levels', min: 2, max: 16, step: 1 },
      { key: 'strength', label: 'Mix', min: 0, max: 1, step: 0.05 },
    ],
    toggles: [{ key: 'monochrome', label: 'Monochrome' }],
  },
]

function PostFxCheckbox({ checked }: { checked: boolean }) {
  return (
    <span className={cn('fx-toggle pointer-events-none', checked && 'fx-toggle--on')} aria-hidden>
      {checked ? <Check size={13} strokeWidth={3} className="text-white" /> : null}
    </span>
  )
}

export function PostStackEditor({
  openSections,
  setOpenSections,
  selected,
  patchSection,
  updateSectionSlider,
  updateSectionToggle,
}: {
  openSections: Partial<Record<PostSectionId, boolean>>
  setOpenSections: React.Dispatch<React.SetStateAction<Partial<Record<PostSectionId, boolean>>>>
  selected: VirtualCamera
  patchSection: <S extends PostSectionId>(section: S, patch: Partial<PostProcessingStack[S]>) => void
  updateSectionSlider: (section: PostSectionId, key: string, v: number) => void
  updateSectionToggle: (section: PostSectionId, key: string) => void
}) {
  return (
    <>
      {POST_STACK_SECTIONS.map((section) => {
        const cfg = selected.postProcessing[section.id]
        const expanded = !!openSections[section.id]
        const numericCfg = cfg as unknown as Record<string, number | boolean>
        return (
          <div key={section.id} className="fx-row">
            <div className="flex items-center gap-1 justify-between">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpenSections((s) => ({ ...s, [section.id]: !s[section.id] }))}
                className="p-0.5 rounded-lg bg-white/80 hover:bg-candy-sun/60 transition-colors shrink-0"
              >
                {expanded ? <ChevronDown size={14} strokeWidth={2.5} /> : <ChevronRight size={14} strokeWidth={2.5} />}
              </button>
              <span className="text-[12px] font-semibold flex-1 truncate">{section.label}</span>
              <button
                type="button"
                aria-pressed={cfg.enabled}
                onClick={() => patchSection(section.id, { enabled: !cfg.enabled })}
                className="shrink-0 cursor-pointer border-0 bg-transparent p-0"
              >
                <PostFxCheckbox checked={cfg.enabled} />
              </button>
            </div>
            <AnimatePresence initial={false}>
              {expanded ? (
                <motion.div
                  key={`fx-${section.id}`}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 pt-2 border-t border-line space-y-3">
                    {section.sliders.map((sl) => {
                      const value = numericCfg[sl.key] as number
                      return (
                        <label key={sl.key} className="block">
                          <div className="flex justify-between text-[10px] font-mono font-bold mb-0.5">
                            <span>{sl.label}</span>
                            <span className="opacity-60">{value.toFixed(sl.step < 1 ? 2 : 0)}</span>
                          </div>
                          <input
                            type="range"
                            min={sl.min}
                            max={sl.max}
                            step={sl.step}
                            value={value}
                            onChange={(e) => updateSectionSlider(section.id, sl.key, parseFloat(e.target.value))}
                            className="w-full accent-[var(--color-candy-blue-deep)] h-2"
                          />
                        </label>
                      )
                    })}
                    {section.toggles?.map((tg) => {
                      const on = numericCfg[tg.key] as boolean
                      return (
                        <button
                          key={tg.key}
                          type="button"
                          onClick={() => updateSectionToggle(section.id, tg.key)}
                          className="flex w-full items-center justify-between gap-2 cursor-pointer border-0 bg-transparent p-0 text-left"
                        >
                          <span className="text-[10px] font-mono font-bold">{tg.label}</span>
                          <PostFxCheckbox checked={on} />
                        </button>
                      )
                    })}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        )
      })}
    </>
  )
}
