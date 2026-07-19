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
 * Screenshots land in scripts/smoke-out/.
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

const store = (fn) => page.evaluate(fn)

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
await page.waitForTimeout(11_000)
const names = await store(() => window.__editorStore.getState().objects.map((o) => o.name))
for (const expected of ['PEDESTAL', 'SNEAKER_ONE', 'SET_SIGN']) {
  check(names.includes(expected), `${expected} spawned`)
}
check(
  await store(() => window.__editorStore.getState().lighting.background !== '#f2f2f2'),
  'room dimmed for the shoot'
)
await page.screenshot({ path: `${OUT}02-set-built.png` })

// 3 — coached cues, offline
const say = async (cmd, wait = 3000) => {
  const input = page.locator('form input[type="text"]')
  await input.fill(cmd)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(wait)
}
console.log('coached cues')
await say('golden hour')
check(
  await store(() => window.__editorStore.getState().lighting.key.color.toLowerCase() === '#ffb36b'),
  'golden hour relit the key light'
)
await say('make the sneaker float', 4000)
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
await say('add a red box then dim the lights', 4000)
check(
  await store(() => window.__editorStore.getState().objects.length) === before + 1,
  'add a red box (compound cue) spawned a box'
)
check(
  (await page.getByText('command dropped').count()) === 0,
  'no "command dropped" errors anywhere'
)
await say('enable bloom', 1500)
check(
  await store(() => window.__editorStore.getState().virtualCamera.postProcessing.bloom.enabled),
  'enable bloom flipped the FX stack'
)
await page.screenshot({ path: `${OUT}04-grammar.png` })

await browser.close()

if (failures.length) {
  console.error(`\nSMOKE FAILED — ${failures.length} assertion(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nSMOKE PASSED')
