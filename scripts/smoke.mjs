/**
 * Headless first-run smoke test — the golden path a first-time user walks.
 *
 * Prereqs: `npm run dev` on :3000 and a Chromium binary. Point CHROMIUM_PATH
 * at the executable if auto-detection fails (uses playwright-core, no browser
 * download). Run: `node scripts/smoke.mjs`
 *
 * Asserts, with NO agent server running:
 *  1. cold load shows the SET DAY cue chip and a calm LOCAL CREW status
 *  2. clicking the chip builds the set (pedestal + sneaker + sign spawn)
 *  3. the demo cues work offline (golden hour, float)
 *  4. the offline grammar handles the pod's own suggestions (add a red box…)
 *  5. punctuated / filler-prefixed spoken forms still match ("Okay, cut.")
 *  6. sentences the grammar refuses still change the set, in the direction the
 *     words pointed — no dead-end "didn't catch that"
 *
 * Waits are on conditions, never durations: the crew's applies are paced behind
 * their cursors, so a stopwatch makes unrelated assertions fail on a slow
 * machine. Screenshots land in scripts/smoke-out/.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE_URL = process.env.SMOKE_URL ?? 'http://localhost:3000'
const OUT = new URL('./smoke-out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const executablePath =
  process.env.CHROMIUM_PATH ??
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  undefined

const failures = []
const check = (ok, label) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) failures.push(label)
}

const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(BASE_URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(3500)

const store = (fn, arg) => page.evaluate(fn, arg)

/**
 * Poll a store predicate instead of sleeping a guessed duration.
 *
 * The crew's choreography is paced (announce → fly → apply → settle, per
 * packet), so a fixed wait is a bet on how long a multi-packet build takes on
 * this machine. Under swiftshader that bet loses often enough that unrelated
 * assertions further down fail for no reason. Returns false on timeout and lets
 * the caller's own `check` report it.
 */
const waitForStore = async (fn, timeoutMs = 25_000, arg) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await store(fn, arg)) return true
    if (Date.now() > deadline) return false
    await page.waitForTimeout(250)
  }
}

/**
 * Settle: nothing has changed for a beat, so the queued crew work has drained.
 *
 * The quiet window has to exceed the longest gap *within* one command, or it
 * reports done during the crew's own pacing. Worst case is one packet's settle
 * (450) + the next packet's flight (≤450) + its work beat (250) ≈ 1150ms, so
 * anything under that will sometimes stop mid-build. See `presence.ts`.
 */
const waitForQuiet = async (signature, quietMs = 1400, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs
  let last = await signature()
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await page.waitForTimeout(200)
    const now = await signature()
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) {
      return true
    }
  }
  return false
}

const sceneSignature = () =>
  store(() => {
    const s = window.__editorStore.getState()
    return JSON.stringify([
      s.objects.map((o) => [o.name, o.keyframes.length, o.materialOverride ?? null]),
      s.lighting,
      s.virtualCamera.postProcessing,
    ])
  })

// 1 — cold-load first impressions
console.log('cold load')
check(await page.locator('.cue-chip').isVisible(), 'SET DAY cue chip is visible')
check(
  (await page.getByText('LOCAL CREW').count()) > 0,
  'status reads LOCAL CREW (not CLOSED)'
)
check(
  (await page.getByText('CLOSED', { exact: true }).count()) === 0,
  'no scary CLOSED status'
)
await page.screenshot({ path: `${OUT}01-cold-load.png` })

// 2 — the front door: click the chip, watch the set build
console.log('set day build')
await page.locator('.cue-chip').click()
for (const expected of ['PEDESTAL', 'SNEAKER_ONE', 'SET_SIGN']) {
  check(
    await waitForStore(
      (n) => window.__editorStore.getState().objects.some((o) => o.name === n),
      25_000,
      expected
    ),
    `${expected} spawned`
  )
}
check(
  await waitForStore(() => window.__editorStore.getState().lighting.background !== '#f2f2f2'),
  'room dimmed for the shoot'
)
// The build is multi-packet; let the queue drain so a later cue isn't overwritten
// by a beat still in flight.
await waitForQuiet(sceneSignature)
await page.screenshot({ path: `${OUT}02-set-built.png` })

// 3 — coached cues, offline
/**
 * Say a cue and wait for the set to stop changing.
 *
 * Every apply is paced behind its crew cursor's flight, so the honest signal
 * that a cue finished is the scene going quiet — not a stopwatch. `minWait`
 * covers cues whose effect isn't in the scene signature at all (overlays,
 * transport), where there is nothing to go quiet.
 */
const say = async (cmd, minWait = 700) => {
  const input = page.locator('form input[type="text"]')
  await input.fill(cmd)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(minWait)
  await waitForQuiet(sceneSignature)
}
console.log('coached cues')
await say('golden hour')
check(
  await store(() => window.__editorStore.getState().lighting.key.color.toLowerCase() === '#ffb36b'),
  'golden hour relit the key light'
)
await say('make the sneaker float')
check(
  await store(() => {
    const hero = window.__editorStore.getState().objects.find((o) => o.name === 'SNEAKER_ONE')
    return Boolean(hero && hero.keyframes.some((k) => k.property === 'position'))
  }),
  'sneaker float authored position keyframes'
)
await page.screenshot({ path: `${OUT}03-golden-float.png` })

// 4 — the pod's own suggestions must work offline
console.log('offline grammar')
const before = await store(() => window.__editorStore.getState().objects.length)
await say('add a red box then dim the lights')
check(
  await waitForStore(
    (n) => window.__editorStore.getState().objects.length === n,
    10_000,
    before + 1
  ),
  'add a red box (compound cue) spawned a box'
)
check(
  (await page.getByText('command dropped').count()) === 0,
  'no "command dropped" errors anywhere'
)
await say('enable bloom')
check(
  await waitForStore(
    () => window.__editorStore.getState().virtualCamera.postProcessing.bloom.enabled,
    10_000
  ),
  'enable bloom flipped the FX stack'
)
await page.screenshot({ path: `${OUT}04-grammar.png` })

// 5 — the shapes speech engines actually produce. Deepgram runs with
// punctuate + smart_format, so a spoken "cut" arrives as "Cut." — and every
// cue matcher is anchored. These fail without transcript normalization.
console.log('spoken forms')
await say('Show timeline.', 1200)
check(
  await store(() => window.__editorStore.getState().overlayTimeline),
  'punctuated "Show timeline." opened the timeline'
)
await say('Okay, golden hour.')
check(
  await store(() => window.__editorStore.getState().lighting.key.color.toLowerCase() === '#ffb36b'),
  'filler-prefixed "Okay, golden hour." relit the key light'
)
await say('Action.', 1200)
check(await store(() => window.__editorStore.getState().isRolling), 'punctuated "Action." rolled a take')
await say('Cut.', 1200)
check(
  await store(() => !window.__editorStore.getState().isRolling),
  'punctuated "Cut." ended the take'
)
await page.screenshot({ path: `${OUT}05-spoken-forms.png` })

// 6 — say anything. With no server, a sentence the grammar refuses used to
// dead-end on "LOCAL CREW didn't catch that". The set must answer instead, and
// it must answer the words that were actually used — a colour is not a wiggle.
console.log('off-grammar sentences')
const paintOf = (name) =>
  store(
    (n) =>
      window.__editorStore
        .getState()
        .objects.find((o) => o.name === n)?.materialOverride?.color ?? null,
    name
  )
const beforePaint = await paintOf('SNEAKER_ONE')
await say('make the sneaker a deep gold, would you')
check((await paintOf('SNEAKER_ONE')) !== beforePaint, 'an off-grammar colour request repainted the sneaker')

const beforeBloom = await store(
  () => window.__editorStore.getState().virtualCamera.postProcessing.bloom.enabled
)
await say('can you make the whole thing glow a bit more')
check(
  beforeBloom ||
    (await store(() => window.__editorStore.getState().virtualCamera.postProcessing.bloom.enabled)),
  'an off-grammar vibe request reached the FX stack'
)

// A signature, not a count: SET_KEYFRAMES *replaces* a track, so authoring a
// fresh path over an existing one can leave the total unchanged.
const keySignature = () =>
  store(() =>
    JSON.stringify(
      window.__editorStore
        .getState()
        .objects.map((o) => [o.name, o.keyframes.map((k) => [k.property, k.time, k.value])])
    )
  )
const beforeKeys = await keySignature()
await say('do the thing with the stuff')
check((await keySignature()) !== beforeKeys, 'a sentence nothing understood still produced a take')
check(
  (await page.getByText('didn’t catch that').count()) === 0,
  'no dead-end "didn’t catch that" for any of the above'
)
await page.screenshot({ path: `${OUT}06-say-anything.png` })

await browser.close()

if (failures.length) {
  console.error(`\nSMOKE FAILED — ${failures.length} assertion(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nSMOKE PASSED')
