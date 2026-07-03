/**
 * Streams a debounced scene snapshot to the server so agents can ground
 * parsing in real object names/transforms. Sent on socket open and whenever
 * the relevant slice of the store changes (300 ms debounce).
 */
import { useEditorStore } from '../store'
import type { DirectorSocket } from './socket'
import type { SceneSnapshot } from './protocol'

const DEBOUNCE_MS = 300

export function buildSceneSnapshot(): Omit<SceneSnapshot, 'type' | 'timestamp'> {
  const st = useEditorStore.getState()
  return {
    objects: st.objects.map((o) => ({
      id: o.id,
      name: o.name,
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      keyframedProperties: [...new Set(o.keyframes.map((k) => k.property))],
    })),
    camera: {
      position: st.virtualCamera.position,
      rotation: st.virtualCamera.rotation,
      fov: st.virtualCamera.fov,
    },
    duration: st.duration,
    isPlaying: st.isPlaying,
  }
}

let started = false

export function startSceneStateSync(socket: DirectorSocket): void {
  if (started) return
  started = true

  let lastSignature = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const send = () => {
    const snapshot = buildSceneSnapshot()
    const signature = JSON.stringify(snapshot)
    if (signature === lastSignature) return
    if (socket.sendSceneState(snapshot)) lastSignature = signature
  }

  socket.onOpen(() => {
    lastSignature = '' // reconnect: server state is gone, always resend
    send()
  })

  useEditorStore.subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(send, DEBOUNCE_MS)
  })
}
