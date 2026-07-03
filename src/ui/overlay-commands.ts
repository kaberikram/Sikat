export type OverlayKey = 'timeline' | 'objects' | 'export'

export interface OverlayCommandDef {
  key: OverlayKey
  hotkey: string
  label: string
  openPhrases: RegExp[]
  closePhrases: RegExp[]
}

export const OVERLAY_COMMANDS: OverlayCommandDef[] = [
  {
    key: 'timeline',
    hotkey: 't',
    label: 'Timeline',
    openPhrases: [/^(show\s+)?timeline$/],
    closePhrases: [/^(hide|close)\s+timeline$/],
  },
  {
    key: 'objects',
    hotkey: 'o',
    label: 'Objects',
    openPhrases: [/^(show\s+)?objects?$/],
    closePhrases: [/^(hide|close)\s+objects?$/],
  },
  {
    key: 'export',
    hotkey: 'e',
    label: 'Export',
    openPhrases: [/^export$/],
    closePhrases: [],
  },
]

export function overlayFromHotkey(key: string): OverlayKey | null {
  const lower = key.toLowerCase()
  return OVERLAY_COMMANDS.find((c) => c.hotkey === lower)?.key ?? null
}
