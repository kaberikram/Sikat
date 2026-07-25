/**
 * Voice smoke test — drives the REAL voice pipeline end to end.
 *
 * Speech recognition can't be exercised for real in headless Chromium (no
 * Google backend, no Deepgram key), so this stands in an engine at each of the
 * two seams the app actually supports and runs everything downstream for real:
 * voice-session's drain/settle state machine, utterance normalization, the
 * LOCAL CREW grammar, the packet pipeline, and the pod UI.
 *
 *   PART A — native path. A fake `window.SpeechRecognition` dictates the way
 *   Chrome does (interim results, a final, then onend after stop()). Every cue
 *   is phrased the way a person actually speaks it — capitalized, punctuated,
 *   hedged — not the way the docs write it.
 *
 *   PART B — Deepgram path. The wss://api.deepgram.com socket is intercepted
 *   and replays Deepgram's real release sequence: finals, then CloseStream is
 *   answered by closing the socket with NO UtteranceEnd. That is the common
 *   case when a director releases the button the instant they stop talking,
 *   and it used to drop the command on the floor.
 *
 * Prereqs: `npm run dev` on :3000 (PART A) and, for PART B, a second dev
 * server with VITE_DEEPGRAM_API_KEY + VITE_DISABLE_WEBSREECH=true — see
 * SMOKE_URL / VOICE_DG_URL below. Run: `node scripts/voice-smoke.mjs`
 */
import { chromium } from 'playwright-core'

const BASE_URL = process.env.SMOKE_URL ?? 'http://localhost:3000'
const DG_URL = process.env.VOICE_DG_URL ?? 'http://localhost:3001'
const executablePath = process.env.CHROMIUM_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_PATH ?? undefined

const failures = []
const check = (ok, label) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) failures.push(label)
}

/** Chrome-shaped SpeechRecognition, driven from the test. */
const FAKE_SPEECH = () => {
  let live = null
  class FakeSpeechRecognition {
    constructor() {
      this.lang = 'en-US'
      this.continuous = false
      this.interimResults = false
      this.maxAlternatives = 1
      this.onresult = null
      this.onend = null
      this.onerror = null
      this._results = []
    }
    start() {
      live = this
      window.__fakeSpeech.started += 1
    }
    stop() {
      if (live !== this) return
      live = null
      // Chrome flushes a trailing final before ending.
      const pending = window.__fakeSpeech.pendingFinal
      window.__fakeSpeech.pendingFinal = null
      if (pending) this._emit(pending, true)
      setTimeout(() => this.onend?.(), 0)
    }
    _emit(transcript, isFinal) {
      const resultIndex = this._results.length
      this._results.push({ isFinal, 0: { transcript } })
      this.onresult?.({ resultIndex, results: this._results })
      if (!isFinal) this._results.pop()
    }
  }
  window.SpeechRecognition = FakeSpeechRecognition
  window.webkitSpeechRecognition = FakeSpeechRecognition
  window.__fakeSpeech = {
    started: 0,
    pendingFinal: null,
    isLive: () => live !== null,
    interim: (text) => live?._emit(text, false),
    final: (text) => live?._emit(text, true),
    /** Held until stop(), like a word still being spoken on release. */
    trail: (text) => { window.__fakeSpeech.pendingFinal = text },
    error: (code) => live?.onerror?.({ error: code }),
  }
}

const browser = await chromium.launch({
  executablePath,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

// ---------------------------------------------------------------- PART A ----

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['microphone'],
})
await context.addInitScript(FAKE_SPEECH)
const page = await context.newPage()

const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

await page.goto(BASE_URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)

const store = (fn) => page.evaluate(fn)
const mic = page.locator('button[title*="voice direction"]')

/** Press the mic, dictate, release — the whole hold, as a user performs it. */
async function speak(text, { trailing = null, settle = 2500 } = {}) {
  await mic.click()
  await page.waitForFunction(() => window.__fakeSpeech.isLive(), null, { timeout: 4000 })
  await page.evaluate((t) => window.__fakeSpeech.interim(t.slice(0, Math.ceil(t.length / 2))), text)
  await page.waitForTimeout(120)
  await page.evaluate((t) => window.__fakeSpeech.final(t), text)
  if (trailing) await page.evaluate((t) => window.__fakeSpeech.trail(t), trailing)
  await page.waitForTimeout(120)
  await mic.click() // release → drain → submit
  await page.waitForTimeout(settle)
}

console.log('PART A — native speech path\n')
console.log('mic is reachable')
check(await mic.count() > 0, 'mic button is present')

console.log('\nlisting state is visible while held')
await mic.click()
await page.waitForFunction(() => window.__fakeSpeech.isLive(), null, { timeout: 4000 })
check(await mic.getAttribute('aria-pressed') === 'true', 'mic reads as pressed while listening')
await page.evaluate(() => window.__fakeSpeech.interim('add a red'))
await page.waitForTimeout(150)
const shownInterim = await page.locator('form input[type="text"]').getAttribute('placeholder')
check(/add a red/i.test(shownInterim ?? ''), `live transcript is shown back (“${shownInterim}”)`)
await page.evaluate(() => window.__fakeSpeech.final('add a red box'))
await page.waitForTimeout(100)
await mic.click()
await page.waitForTimeout(2500)
check(
  await store(() => window.__editorStore.getState().objects.some((o) => /BOX/i.test(o.name))),
  'released hold spawned the box',
)
check(await mic.getAttribute('aria-pressed') === 'false', 'mic releases back to idle')

// The words a director actually says — dictated the way an engine writes them.
console.log('\ndictated cues, spoken naturally')
const SPOKEN = [
  {
    say: 'Okay, golden hour.',
    label: 'filler + punctuation → relight',
    assert: () => window.__editorStore.getState().lighting.key.color.toLowerCase() === '#ffb36b',
  },
  {
    say: 'Can you enable bloom?',
    label: 'polite question → FX on',
    assert: () => window.__editorStore.getState().virtualCamera.postProcessing.bloom.enabled,
  },
  {
    say: 'Um, add a blue sphere, please.',
    label: 'filler + courtesy → spawn',
    assert: () => window.__editorStore.getState().objects.some((o) => /SPHERE/i.test(o.name)),
  },
  {
    say: 'Crew, make the sphere bounce.',
    label: 'addressed cue → motion keyframes',
    assert: () => {
      const s = window.__editorStore.getState().objects.find((o) => /SPHERE/i.test(o.name))
      return Boolean(s && s.keyframes.length > 0)
    },
  },
  {
    say: 'Show timeline.',
    label: 'overlay cue → timeline opens',
    assert: () => window.__editorStore.getState().overlayTimeline === true,
  },
  {
    say: 'Action!',
    label: 'take cue → rolling',
    assert: () => window.__editorStore.getState().isRolling === true,
  },
  {
    say: 'And cut.',
    label: '“and cut” → take ends',
    assert: () => window.__editorStore.getState().isRolling === false,
  },
]

for (const step of SPOKEN) {
  await speak(step.say)
  check(await store(step.assert), `“${step.say}” — ${step.label}`)
}

console.log('\nspoken numbers drive a timed move')
const boxYBefore = await store(() => {
  const b = window.__editorStore.getState().objects.find((o) => /BOX/i.test(o.name))
  return b ? b.position[1] : null
})
await speak('Move the box up two over three seconds.', { settle: 4500 })
const boxYAfter = await store(() => {
  const b = window.__editorStore.getState().objects.find((o) => /BOX/i.test(o.name))
  return b ? b.position[1] : null
})
check(
  boxYBefore !== null && boxYAfter !== null && boxYAfter - boxYBefore > 1.5,
  `“up two over three seconds” raised the box (${boxYBefore} → ${boxYAfter})`,
)

console.log('\ntrailing word spoken at the moment of release is not lost')
const objectsBeforeTrail = await store(() => window.__editorStore.getState().objects.length)
await speak('add a green', { trailing: 'cone' })
check(
  await store(() => window.__editorStore.getState().objects.length) === objectsBeforeTrail + 1,
  'the final flushed by stop() still ran',
)

console.log('\nnothing an engine does leaves the mic stuck on')
await mic.click()
await page.waitForFunction(() => window.__fakeSpeech.isLive(), null, { timeout: 4000 })
await page.evaluate(() => window.__fakeSpeech.error('network'))
await page.waitForTimeout(600)
check(await mic.getAttribute('aria-pressed') === 'false', 'engine error releases the mic')
await page.waitForTimeout(700)
await speak('golden hour')
check(
  await store(() => window.__editorStore.getState().lighting.key.color.toLowerCase() === '#ffb36b'),
  'voice still works after an engine error',
)

console.log('\nan empty hold is a no-op, not an error')
const logBefore = await page.locator('.director-log-line').count()
await mic.click()
await page.waitForFunction(() => window.__fakeSpeech.isLive(), null, { timeout: 4000 })
await page.waitForTimeout(150)
await mic.click()
await page.waitForTimeout(1200)
check(await mic.getAttribute('aria-pressed') === 'false', 'silent hold releases cleanly')
check(
  (await page.locator('.director-log-line').count()) === logBefore,
  'silent hold logs nothing at all',
)

console.log('\nno errors surfaced anywhere')
check(
  (await page.getByText('command dropped').count()) === 0,
  'no "command dropped" in the pod',
)
check(
  (await page.getByText('voice error').count()) === 0,
  'no raw engine codes surfaced as "voice error"',
)
check(
  (await page.getByText('network', { exact: true }).count()) === 0,
  'no bare error codes shown to the user',
)
const OFFLINE_NOISE = /favicon|Failed to load resource|ws:\/\/localhost:8000|WebSocket connection to/i
const realErrors = consoleErrors.filter((e) => !OFFLINE_NOISE.test(e))
check(realErrors.length === 0, `console is clean${realErrors.length ? ` — ${realErrors[0]}` : ''}`)

await context.close()

// ---------------------------------------------------------------- PART B ----

console.log('\n\nPART B — Deepgram path (release with no UtteranceEnd)\n')

let dgReachable = true
try {
  const res = await fetch(DG_URL, { signal: AbortSignal.timeout(3000) })
  dgReachable = res.ok
} catch {
  dgReachable = false
}

if (!dgReachable) {
  console.log(`  … skipped — no Deepgram-configured dev server at ${DG_URL}`)
  console.log('    start one with:')
  console.log('    VITE_DEEPGRAM_API_KEY=test-key VITE_DISABLE_WEBSREECH=true npx vite --port=3001')
} else {
  const dgContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
  })
  const dgPage = await dgContext.newPage()

  // Stand in for Deepgram: transcribe on cue, then answer CloseStream exactly
  // as the real service does — flush a final, hang up, never send UtteranceEnd.
  await dgPage.routeWebSocket(/api\.deepgram\.com/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== 'string') return // audio frames
      let parsed
      try { parsed = JSON.parse(message) } catch { return }
      if (parsed.type === 'CloseStream') {
        ws.send(JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: { alternatives: [{ transcript: 'hour.' }] },
        }))
        ws.send(JSON.stringify({ type: 'Metadata', request_id: 'smoke' }))
        ws.close({ code: 1000 })
      }
    })
    // The engine has heard the first half by the time the button comes up.
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'Results',
        is_final: false,
        channel: { alternatives: [{ transcript: 'golden' }] },
      }))
      ws.send(JSON.stringify({
        type: 'Results',
        is_final: true,
        channel: { alternatives: [{ transcript: 'Golden' }] },
      }))
    }, 300)
  })

  await dgPage.goto(DG_URL, { waitUntil: 'networkidle' })
  await dgPage.waitForTimeout(3000)

  const dgMic = dgPage.locator('button[title*="voice direction"]')
  check(await dgMic.count() > 0, 'mic button present on the Deepgram build')

  await dgMic.click()
  await dgPage.waitForTimeout(1500)
  check(await dgMic.getAttribute('aria-pressed') === 'true', 'mic opens on the Deepgram path')
  await dgMic.click() // release
  await dgPage.waitForTimeout(2500)

  check(
    await dgPage.evaluate(
      () => window.__editorStore.getState().lighting.key.color.toLowerCase() === '#ffb36b',
    ),
    'command submitted on socket close (no UtteranceEnd) — “Golden hour.” ran',
  )
  check(
    await dgMic.getAttribute('aria-pressed') === 'false',
    'mic returns to idle after the drain',
  )
  await dgContext.close()
}

await browser.close()

if (failures.length) {
  console.error(`\nVOICE SMOKE FAILED — ${failures.length} assertion(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nVOICE SMOKE PASSED')
