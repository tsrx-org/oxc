// End-to-end verification of the built docs site using system Chrome.
// Prereqs: node docs/build.mjs && node docs/serve.mjs 4519
// Run: node docs/verify.mjs [baseUrl] [--mode=native|static]
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const mode =
  process.argv.find((argument) => argument.startsWith('--mode='))?.slice('--mode='.length) ??
  'native'
if (!['native', 'wasm', 'static'].includes(mode)) {
  throw new Error(`unsupported docs verification mode: ${mode}`)
}
const baseUrl = (positional[0] ?? 'http://localhost:4519').replace(/\/$/, '')
const parsedBaseUrl = new URL(baseUrl)
// Routes in this file are written site-relative; the site may be served under
// a URL prefix (docs/site.config.mjs base), which baseUrl carries. withBase
// maps a site-relative route onto the pathname the browser actually sees.
const basePathname = parsedBaseUrl.pathname.replace(/\/$/, '')
const withBase = (route) => (route === '/' ? basePathname || '/' : basePathname + route)
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsedBaseUrl.hostname)
if (mode === 'native' && (parsedBaseUrl.protocol !== 'http:' || !loopback)) {
  throw new Error('native docs verification is restricted to a loopback HTTP origin')
}
const expectedCapabilities = await fetch(`${baseUrl}/demo-capabilities.json`)
  .then((response) => response.json())
  .catch(() => null)
if (
  !expectedCapabilities?.ok ||
  expectedCapabilities.mode !== mode ||
  (mode === 'native') !== Boolean(expectedCapabilities.native) ||
  (mode === 'wasm') !== Boolean(expectedCapabilities.wasm)
) {
  throw new Error(`docs capability mode mismatch: requested ${mode}`)
}
// The demo is live (editable, real engine) in native mode and in wasm mode;
// static builds show the read-only preview.
const liveDemo = mode !== 'static'
const docsDir = path.dirname(fileURLToPath(import.meta.url))
const axeSource = await readFile(
  path.join(docsDir, '..', 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8',
)

const failures = []
const passes = []
const check = (ok, label, detail = '') => {
  ;(ok ? passes : failures).push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

if (mode !== 'static') {
  const [{ createDemoHighlighter }, { getDocsHighlighter, highlightWith }] = await Promise.all([
    import(
      pathToFileURL(
        path.join(
          docsDir,
          'dist',
          ...basePathname.split('/').filter(Boolean),
          'assets',
          'demo-highlighter.js',
        ),
      )
    ),
    import('./highlight.mjs'),
  ])
  const clientHighlighter = createDemoHighlighter()
  const serverHighlighter = await getDocsHighlighter()
  const paritySamples = [
    `export function TaskList({ tasks }: Props) @{
  const pending = tasks.filter((task) => !task.done);

  <section class="tasks">
    @if (pending.length > 0) {
      @for (const task of pending; key task.id) {
        <TaskRow task={task} />;
      } @empty {
        <AllDone />;
      }
    } @else {
      <SignIn />;
    }
    <style>
      .tasks { display: grid; gap: 0.5rem; }
    </style>
  </section>;
}`,
    `type Task = { id: string; label: string; done: boolean };

function TaskRow({ task }: { task: Task }) @{
  <li>{task.label}</li>;
}

export function TaskList({ tasks }: { tasks: Task[] }) @{
  const pending = tasks.filter((task) => !task.done);

  <section class="tasks">
    @if (pending.length > 0) {
      <ul>
        @for (const task of pending; key task.id) {
          <TaskRow task={task} />;
        }
      </ul>;
    } @else {
      <p>All done!</p>;
    }
  </section>;
}`,
    `export const Card = ({ name }: { name: string }) => (
  <section className="card">{\`Hello \${name}!\`}</section>
)`,
  ]
  for (const [index, sample] of paritySamples.entries()) {
    const lang = index === paritySamples.length - 1 ? 'tsx' : 'tsrx'
    const clientHtml = clientHighlighter.highlight(sample, lang)
    const serverHtml = highlightWith(serverHighlighter, sample, lang)
    let firstDifference = 0
    while (
      firstDifference < clientHtml.length &&
      firstDifference < serverHtml.length &&
      clientHtml[firstDifference] === serverHtml[firstDifference]
    ) {
      firstDifference++
    }
    if (clientHtml === serverHtml) firstDifference = -1
    const contextStart = Math.max(0, firstDifference - 40)
    check(
      clientHtml === serverHtml,
      `demo highlighter: sample ${index + 1} matches server byte-for-byte`,
      firstDifference === -1
        ? ''
        : `first difference ${firstDifference}; client=${JSON.stringify(clientHtml.slice(contextStart, contextStart + 80))}; server=${JSON.stringify(serverHtml.slice(contextStart, contextStart + 80))}`,
    )
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  let clipboardText = ''
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => clipboardText,
      writeText: async (value) => {
        clipboardText = String(value)
      },
    },
  })
})

const consoleErrors = []
const badResponses = []
const serverApiRequests = []
context.on('page', (page) => {
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${page.url()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => consoleErrors.push(`${page.url()}: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`)
  })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(`${basePathname}/api/`))
      serverApiRequests.push(request.url())
  })
})

const page = await context.newPage()

// ---------- home page ----------
await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
check((await page.title()) === 'OXC for TSRX', 'home: title')
check(
  (await page.locator('.hero-name').textContent())?.trim() === 'OXC for TSRX',
  'home: hero renders',
)
check((await page.locator('.feature').count()) === 6, 'home: six feature cards')
const homeHorizontalOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
)
check(!homeHorizontalOverflow, 'home: no horizontal page overflow')

// ---------- walkthrough: hero action then every sidebar page ----------
await page.getByRole('link', { name: 'Get Started' }).click()
await page.waitForURL('**/guide/getting-started')
check(true, 'walkthrough: hero action navigates to Getting Started')

// The SPA router updates the URL before the fetched page is swapped in; over
// a real network the sidebar is not in the DOM yet when the URL settles.
await page.waitForFunction(() => document.querySelectorAll('.sidebar nav a').length > 0)
const sidebarLinks = await page
  .locator('.sidebar nav a')
  .evaluateAll((anchors) => anchors.map((a) => ({ href: a.href, text: a.textContent.trim() })))
// There was an assertion here that the sidebar listed exactly fifteen pages.
// Adding a sixteenth turned the site build red, which skipped the deploy, so
// the platform support page existed in the repository and never reached a
// reader. Every new documentation page would have done the same.
//
// Replacing the literal with a count derived from site.config.mjs was tried
// and removed: it cannot fail. The rendered sidebar is built at runtime from
// that same config, so the two sides always agree, and a link pointing at a
// page that does not exist already fails docs:build long before this runs.
// Stripping the platform-support anchor out of all seventeen built pages still
// passed. A check that cannot fail reads as coverage without being any.
//
// The loop below is the real check and always was. It visits every page the
// sidebar offers and asserts each one renders a heading, marks itself current,
// and carries an outline and a pager. It covers a new page automatically and
// needs no number kept in step.
for (const link of sidebarLinks) {
  await page.goto(link.href, { waitUntil: 'load' })
  const h1 = (await page.locator('article h1').first().textContent())?.trim()
  const active = await page.locator('.sidebar a[aria-current="page"]').getAttribute('href')
  const hasOutline = (await page.locator('.outline a').count()) > 0
  const pagerOk = (await page.locator('.pager a').count()) > 0
  check(
    Boolean(h1) && link.href.endsWith(active) && hasOutline && pagerOk,
    `walkthrough: ${link.text}`,
    `h1="${h1}"`,
  )
}

// ---------- prev/next ----------
await page.goto(`${baseUrl}/guide/introduction`, { waitUntil: 'load' })
await page.locator('.pager-link.next a').click()
await page.waitForURL('**/guide/getting-started')
await page.locator('.pager-link.prev a').click()
await page.waitForURL('**/guide/introduction')
check(true, 'pager: next and previous navigate correctly')

// ---------- SPA routing (Navigation API) ----------
await page.goto(`${baseUrl}/guide/introduction`, { waitUntil: 'load' })
const marker = await page.evaluate(() => {
  window.__spaMarker = true
  document.querySelector('.sidebar a[href$="/guide/linting"]').focus()
  return true
})
check(marker, 'spa: marker set')
await page.keyboard.press('Enter')
await page.waitForURL('**/guide/linting')
await page.waitForFunction(
  () => document.querySelector('article h1')?.textContent.trim() === 'Linting',
)
const spaState = await page.evaluate(() => ({
  stillSpa: window.__spaMarker === true,
  h1: document.querySelector('article h1')?.textContent.trim(),
  focusHref: document.activeElement?.getAttribute('href') ?? null,
  ariaCurrent: document.querySelector('.sidebar a[aria-current="page"]')?.getAttribute('href'),
  title: document.title,
  announced: document.getElementById('route-announcer')?.textContent,
}))
check(spaState.stillSpa, 'spa: navigation did not reload the page (JS state survives)')
check(spaState.h1 === 'Linting', 'spa: content swapped in place', spaState.h1)
check(
  spaState.focusHref?.endsWith('/guide/linting'),
  'spa: focus stays on the activated sidebar link',
  String(spaState.focusHref),
)
check(
  spaState.ariaCurrent?.endsWith('/guide/linting') && spaState.title.startsWith('Linting'),
  'spa: aria-current and title updated',
)
check(Boolean(spaState.announced), 'spa: route change announced via aria-live', spaState.announced)

// home -> doc structural swap without reload
await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
await page.evaluate(() => {
  window.__spaMarker = true
})
await page.getByRole('link', { name: 'Get Started' }).click()
await page.waitForURL('**/guide/getting-started')
await page.waitForFunction(
  () => document.querySelector('article h1')?.textContent.trim() === 'Getting Started',
)
const crossState = await page.evaluate(() => ({
  stillSpa: window.__spaMarker === true,
  h1: document.querySelector('article h1')?.textContent.trim(),
  hasSidebar: Boolean(document.getElementById('sidebar')),
}))
check(
  crossState.stillSpa && crossState.h1 === 'Getting Started' && crossState.hasSidebar,
  'spa: home to doc swaps layout without reload',
)

// ---------- the stylesheet travels with the route ----------
// Every page shell ships its own stylesheet, and <head> is not part of the
// routed region, so a router that swaps the body alone leaves the destination
// page wearing the origin shell's CSS: /guide/getting-started laid out by
// style-home.css with its sidebar 237.891px wide instead of 288px, and the same
// on the way back. It looked like missing styles, so it invited a CSS rewrite;
// it was the router.
//
// A screenshot is not evidence here. The two things that are: which stylesheet
// the head holds, and a computed value that only the right shell can produce,
// compared against a direct load of the same URL in the same run. window
// .__spaMarker has to survive too — without it this silently degrades into
// testing full page loads, which were never broken.
const shellProbe = () =>
  page.evaluate(() => {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
    const computed = (selector, properties) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const style = getComputedStyle(element)
      return Object.fromEntries(properties.map((property) => [property, style[property]]))
    }
    let ruleCount = -1
    try {
      ruleCount = document.styleSheets[0]?.cssRules.length ?? -1
    } catch {
      ruleCount = -2
    }
    return {
      spa: window.__spaMarker === true,
      sheets: links.map((link) => new URL(link.href).pathname),
      ruleCount,
      firstSheetIsHeadLink: links.length > 0 && document.styleSheets[0]?.ownerNode === links[0],
      // Each of these is styled by exactly one shell's rules and left at the
      // browser default by the other two.
      style: {
        sidebar: computed('.sidebar', ['width']),
        pgSide: computed('#pg-side', ['paddingTop', 'paddingLeft', 'borderBottomWidth']),
        pgTitle: computed('.pg-title', ['fontSize', 'letterSpacing']),
        hero: computed('.hero-name', ['fontSize']),
      },
    }
  })

const flattenStyle = (style) =>
  Object.entries(style).flatMap(([element, properties]) =>
    properties === null
      ? [[element, '(element absent)']]
      : Object.entries(properties).map(([name, value]) => [`${element}.${name}`, value]),
  )

const directShells = new Map()
for (const [route, shell] of [
  ['/', 'home'],
  ['/guide/getting-started', 'doc'],
  ['/playground', 'playground'],
]) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'load' })
  const state = await shellProbe()
  check(
    state.sheets.length === 1 &&
      state.sheets[0] === withBase(`/assets/style-${shell}.css`) &&
      state.firstSheetIsHeadLink &&
      state.ruleCount > 0,
    `stylesheet: direct load of ${route} links only the ${shell} shell`,
    `${state.sheets.join(', ') || 'no stylesheet'} · ${state.ruleCount} rules`,
  )
  directShells.set(route, { shell, ...state })
}

const checkShell = (label, route, state) => {
  const direct = directShells.get(route)
  check(state.spa, `stylesheet: ${label} stayed a client-side navigation (no reload)`)
  check(
    state.sheets.length === 1 && state.sheets[0] === withBase(`/assets/style-${direct.shell}.css`),
    `stylesheet: ${label} leaves the ${direct.shell} shell as the only stylesheet`,
    `${state.sheets.join(', ') || 'no stylesheet'} (expected exactly /assets/style-${direct.shell}.css)`,
  )
  check(
    state.firstSheetIsHeadLink && state.ruleCount === direct.ruleCount,
    `stylesheet: ${label} applies the rule count of a direct load`,
    `${state.ruleCount} rules vs ${direct.ruleCount} direct`,
  )
  const after = new Map(flattenStyle(state.style))
  const differences = flattenStyle(direct.style)
    .filter(([key, value]) => after.get(key) !== value)
    .map(([key, value]) => `${key}: ${after.get(key)} vs ${value} direct`)
  check(
    differences.length === 0,
    `stylesheet: ${label} computes the same shell layout as a direct load`,
    differences.join('; '),
  )
}

await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
await page.evaluate(() => {
  window.__spaMarker = true
})
await page.getByRole('link', { name: 'Get Started' }).click()
await page.waitForURL('**/guide/getting-started')
await page.waitForFunction(
  () => document.querySelector('article h1')?.textContent.trim() === 'Getting Started',
)
checkShell('home to doc', '/guide/getting-started', await shellProbe())

await page.locator('.top-nav a[href$="/playground"]').first().click()
await page.waitForURL('**/playground')
await page.waitForFunction(() => Boolean(document.querySelector('.pg-title')))
checkShell('doc to playground', '/playground', await shellProbe())

// Back and forward run through the same interceptor, which is exactly why they
// broke the same way and why they are asserted separately.
await page.evaluate(() => navigation.back())
await page.waitForURL('**/guide/getting-started')
await page.waitForFunction(
  () => document.querySelector('article h1')?.textContent.trim() === 'Getting Started',
)
checkShell('back to doc', '/guide/getting-started', await shellProbe())

await page.evaluate(() => navigation.back())
await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === basePathname)
await page.waitForFunction(() => Boolean(document.querySelector('.hero-name')))
checkShell('back to home', '/', await shellProbe())

// Back to where the session started is the one traversal a head-blind router
// gets right by accident, so a forward traversal is asserted too.
await page.evaluate(() => navigation.forward())
await page.waitForURL('**/guide/getting-started')
await page.waitForFunction(
  () => document.querySelector('article h1')?.textContent.trim() === 'Getting Started',
)
checkShell('forward to doc', '/guide/getting-started', await shellProbe())

// ---------- two taps at once: document.head has exactly one owner ----------
// Every crossing above is driven to completion before the next one starts, and
// that is not how a phone gets used. A reader touches the Playground link (the
// router prefetches it into its page cache on pointerover/touchstart), changes
// their mind and taps a sidebar doc link, then taps Playground again a fraction
// of a second later. On the live deploy that left the page with NO stylesheet at
// all, permanently — body font-family resolved to Times — because the superseded
// navigation removed the winner's stylesheet using a snapshot of the head taken
// before the winner existed, and the winner, still waiting on a load event from
// a link that had been detached, waited out its four-second timeout and then
// removed the loser's.
//
// Reproducing that needs the live shape, not just two navigate() calls: the
// SECOND target pre-warmed in the page cache and the FIRST one uncached, so the
// loser finishes after the winner. Locally every fetch is instant, so the first
// route's HTML and the winner's stylesheet are delayed at the network layer.
// That is reproducing a phone's latency, not testing this machine's speed: the
// property under test is "the end state does not depend on the interleaving".
// STYLESHEET_TIMEOUT_MS in docs/assets/app.js. The worst of these end states
// arrives one full router timeout after the last held-back response, because
// that is how long a navigation waits on a load event from a link that is no
// longer in the document, so nothing here may conclude before then.
const ROUTER_STYLESHEET_TIMEOUT_MS = 4000
const routeDelays = new Map()
const delayedRoute = (url) => routeDelays.has(url.pathname)
await page.route(delayedRoute, async (route) => {
  const delay = routeDelays.get(new URL(route.request().url()).pathname) ?? 0
  await new Promise((resolve) => setTimeout(resolve, delay))
  await route.continue().catch(() => {})
})

const watchHead = () =>
  page.evaluate(() => {
    window.__headLog = []
    window.__raceStartedAt = performance.now()
    window.__headSettledAt = performance.now()
    new MutationObserver((records) => {
      let touched = false
      for (const record of records) {
        for (const [nodes, verb] of [
          [record.addedNodes, 'ADD'],
          [record.removedNodes, 'REMOVE'],
        ]) {
          for (const node of nodes) {
            if (node.tagName !== 'LINK' || node.rel !== 'stylesheet') continue
            touched = true
            window.__headLog.push(
              `${Math.round(performance.now())} ${verb} ${new URL(node.href).pathname}`,
            )
          }
        }
      }
      if (touched) window.__headSettledAt = performance.now()
    }).observe(document.head, { childList: true })
  })

// The broken end state arrives late — the winner's stylesheet is removed when
// the loser finishes, and the loser's four seconds after that, when the winner
// gives up waiting for a load event from a link that is no longer in the
// document. So the probe never samples on a timer that happens to look right: it
// waits for the destination's content to render, then for the head to stop
// changing, and never earlier than every held-back response has been delivered.
const settleHead = async (floorMs) => {
  await page
    .waitForFunction(
      (floor) =>
        performance.now() - window.__headSettledAt > 700 &&
        performance.now() - window.__raceStartedAt > floor,
      floorMs,
      { timeout: 20_000, polling: 100 },
    )
    .catch(() => {})
  return page.evaluate(() => window.__headLog.join(' | '))
}

// Hovering is how the router's cache gets warmed in the wild (pointerover, and
// touchstart on a phone); waiting for the response is how we know it actually
// happened before the race starts, which is the condition that made the live
// window wide enough to hit.
const warmCache = async (pathname) => {
  // The wild mechanism is a pointer hovering a nav link; the contract under
  // test is that fetchPage puts the page into the router's cache before the
  // race starts. Simulating the pointer proved environment-sensitive on CI
  // (three distinct timeout signatures, none reproducible locally), so the
  // router's own fetchPage is called directly and any failure names itself
  // instead of hiding inside a hover that silently warmed nothing.
  const outcome = await page.evaluate(async (target) => {
    if (typeof window.__warmPage !== 'function') return 'router not initialised'
    try {
      await window.__warmPage(new URL(target, location.href).href)
    } catch (error) {
      return String(error)
    }
    return window.__pageCache instanceof Map && window.__pageCache.has(target)
      ? true
      : 'fetch completed but the page is not in the router cache'
  }, withBase(pathname))
  if (outcome !== true) throw new Error(`warming ${pathname}: ${outcome}`)
  return true
}

const raceNavigations = (steps) =>
  page.evaluate((plan) => {
    // navigate() rejects both of its promises when a later navigation supersedes
    // it. That is the expected outcome here and must not surface as an unhandled
    // rejection, which the console-error check would (rightly) fail on.
    const go = (href) => {
      const result = navigation.navigate(href)
      result.committed?.catch(() => {})
      result.finished?.catch(() => {})
    }
    go(plan[0].href)
    let elapsed = 0
    for (const step of plan.slice(1)) {
      elapsed += step.afterMs
      setTimeout(() => go(step.href), elapsed)
    }
  }, steps)

const overlapCase = async ({ label, start, warm, steps, delays, finalRoute, marker }) => {
  await page.goto(`${baseUrl}${start}`, { waitUntil: 'load' })
  routeDelays.clear()
  for (const pathname of warm) {
    check(
      await warmCache(pathname),
      `${label}: prefetch warms ${pathname} into the router's page cache`,
    )
  }
  for (const [pathname, ms] of delays) routeDelays.set(withBase(pathname), ms)
  await page.evaluate(() => {
    window.__spaMarker = true
  })
  await watchHead()
  await raceNavigations(steps.map((step) => ({ ...step, href: withBase(step.href) })))
  await page.waitForURL(`**${finalRoute}`, { timeout: 15_000 }).catch(() => {})
  await page
    .waitForFunction(
      ({ selector, text }) => document.querySelector(selector)?.textContent.trim() === text,
      marker,
      { timeout: 15_000 },
    )
    .catch(() => {})
  const floorMs =
    Math.max(0, ...delays.map(([, ms]) => ms)) + ROUTER_STYLESHEET_TIMEOUT_MS + 400
  const headLog = await settleHead(floorMs)
  routeDelays.clear()
  const state = await shellProbe()
  const rendered = await page.evaluate(
    (selector) => document.querySelector(selector)?.textContent.trim() ?? null,
    marker.selector,
  )
  const landed = new URL(page.url()).pathname
  check(
    landed === withBase(finalRoute) && rendered === marker.text,
    `${label}: settles on the final destination, not a superseded one`,
    `${landed} showing ${JSON.stringify(rendered)} (expected ${finalRoute} showing ${JSON.stringify(marker.text)})`,
  )
  // checkShell already asserts the head; this repeats the single most important
  // half of it with the head's mutation log attached, because "which link was
  // removed, by whom, and when" is the whole diagnosis when it fails.
  const shell = directShells.get(finalRoute).shell
  check(
    state.sheets.length === 1 && state.sheets[0] === withBase(`/assets/style-${shell}.css`),
    `${label}: leaves exactly one stylesheet in the head, the ${shell} shell's`,
    `${state.sheets.join(', ') || 'NO STYLESHEET AT ALL'} · head log: ${headLog || '(no head mutations)'}`,
  )
  checkShell(label, finalRoute, state)
}

// 1. The live sequence, in order: an uncached doc link, then the prefetched
//    playground 100 ms later. The playground stylesheet is held open past the
//    moment the doc navigation finishes, which is exactly the window in which
//    the superseded handler used to delete it.
await overlapCase({
  label: 'overlapping doc then playground',
  start: '/guide/getting-started',
  warm: ['/playground'],
  delays: [
    ['/guide/linting', 600],
    ['/assets/style-playground.css', 1200],
  ],
  steps: [{ href: '/guide/linting' }, { href: '/playground', afterMs: 100 }],
  finalRoute: '/playground',
  marker: { selector: '.pg-title', text: 'TSRX Playground' },
})

// 2. The other order, and the other failure mode: the first navigation runs to
//    completion and the second is still in flight. The winner has to sweep up
//    the stylesheet the loser appended before it was superseded, which no
//    snapshot taken at the loser's start could account for.
await overlapCase({
  label: 'overlapping playground then doc',
  start: '/guide/introduction',
  warm: ['/playground'],
  delays: [
    ['/guide/getting-started', 600],
    ['/assets/style-playground.css', 1200],
  ],
  steps: [{ href: '/playground' }, { href: '/guide/getting-started', afterMs: 60 }],
  finalRoute: '/guide/getting-started',
  marker: { selector: 'article h1', text: 'Getting Started' },
})

// 3. Three deep. Two losers, one of which crosses a shell boundary and one of
//    which does not, and a winner that shares its stylesheet with the page the
//    session started on — so the head can only be right if the sweep runs
//    against the live head rather than against anybody's snapshot.
await overlapCase({
  label: 'three overlapping navigations',
  start: '/guide/introduction',
  warm: ['/playground', '/guide/getting-started'],
  delays: [
    ['/guide/linting', 600],
    ['/assets/style-playground.css', 1200],
  ],
  steps: [
    { href: '/guide/linting' },
    { href: '/playground', afterMs: 60 },
    { href: '/guide/getting-started', afterMs: 60 },
  ],
  finalRoute: '/guide/getting-started',
  marker: { selector: 'article h1', text: 'Getting Started' },
})

routeDelays.clear()
await page.unroute(delayedRoute)

// ---------- the playground survives its own boot window ----------
// The example buttons used to be `hidden` until the demo module had been
// fetched, parsed, and had answered a capability request. On a Pixel 5 over Fast
// 3G that took 3.3 s, and a tap inside that window hit nothing and left no
// trace, which is what "sometimes didn't work at all" was. The page now ships
// the controls visible and marked as starting, an inline script in the head
// records a tap that lands before the module does, and the module replays it
// once it is wired.
//
// Those are three separate mechanisms, each of which can be lost on its own
// while the page still photographs perfectly, so each is asserted on its own,
// against DOM state and computed style. The module is held at the network layer
// rather than raced against a timer: the property is "does not depend on the
// module", and a wall-clock wait would only be testing this machine's speed.
const bootProbe = (target) =>
  target.evaluate(() => {
    const bar = document.getElementById('pg-side')
    const button = document.getElementById('pg-scenario-lint')
    if (!bar || !button) return { present: false }
    const barStyle = getComputedStyle(bar)
    const buttonStyle = getComputedStyle(button)
    const rect = button.getBoundingClientRect()
    return {
      present: true,
      engine: bar.dataset.engine ?? null,
      hidden: bar.hasAttribute('hidden'),
      busy: bar.querySelector('.pg-examples')?.getAttribute('aria-busy') ?? null,
      legible:
        barStyle.display !== 'none' &&
        barStyle.visibility === 'visible' &&
        buttonStyle.display !== 'none' &&
        buttonStyle.visibility === 'visible' &&
        Number.parseFloat(barStyle.opacity) > 0.25 &&
        Number.parseFloat(buttonStyle.opacity) > 0.25 &&
        rect.width > 20 &&
        rect.height > 10 &&
        button.textContent.trim() === 'Lint findings',
      geometry: `${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)}`,
      label: document.getElementById('pg-engine-label')?.textContent.trim() ?? null,
      note: document.getElementById('pg-scenario-note')?.textContent.trim() ?? null,
      queued: button.dataset.queued ?? null,
      moduleRan: Boolean(document.getElementById('demo-input')),
      source: document.getElementById('demo-input')?.value ?? null,
    }
  })

if (mode === 'wasm') {
  // 1. No script at all. If the controls need JavaScript to become visible,
  //    they need it to become visible late, which is the whole defect.
  const scriptless = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  })
  const scriptlessPage = await scriptless.newPage()
  await scriptlessPage.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  const staticBar = await bootProbe(scriptlessPage)
  check(
    staticBar.present && staticBar.legible && !staticBar.hidden,
    'boot window: the playground ships its controls visible in the HTML, before any script',
    `${staticBar.geometry ?? 'absent'} · hidden=${staticBar.hidden}`,
  )
  check(
    staticBar.engine === 'starting' &&
      staticBar.busy === 'true' &&
      /starting/i.test(staticBar.label ?? '') &&
      /still starting/i.test(staticBar.note ?? ''),
    'boot window: the controls say they are still starting rather than pretending to be live',
    `data-engine=${staticBar.engine} aria-busy=${staticBar.busy} label=${staticBar.label} · ${(staticBar.note ?? '').slice(0, 60)}`,
  )
  await scriptless.close()

  // 2. Script on, but the demo module held on the wire: this is the real boot
  //    window, reproduced deterministically.
  const bootPage = await context.newPage()
  let releaseModule
  const moduleHeld = new Promise((resolve) => {
    releaseModule = resolve
  })
  let moduleRequested = false
  await bootPage.route('**/assets/demo-panel.js*', async (route) => {
    moduleRequested = true
    await moduleHeld
    await route.continue()
  })
  const navigationStarted = Date.now()
  await bootPage.goto(`${baseUrl}/playground`, { waitUntil: 'commit' })
  await bootPage.waitForFunction(() => Boolean(document.getElementById('pg-scenario-lint')))
  const controlsAt = Date.now() - navigationStarted
  const heldState = await bootProbe(bootPage)
  check(
    heldState.legible && !heldState.moduleRan && controlsAt < 1500,
    'boot window: the controls are legible with the demo module still in flight',
    `${controlsAt} ms, module initialised=${heldState.moduleRan}, ${heldState.geometry}`,
  )

  // Tolerated rather than awaited: if the controls have gone back to being
  // hidden, the tap cannot land at all, and that has to read as these checks
  // failing, not as the whole verification run aborting on a click timeout.
  let tapError = null
  try {
    await bootPage.locator('#pg-scenario-lint').click({ timeout: 5000 })
    await bootPage.waitForFunction(
      () => document.getElementById('pg-scenario-lint')?.dataset.queued === '1',
      null,
      { timeout: 5000 },
    )
  } catch (error) {
    tapError = error.message.split('\n')[0]
  }
  const tapped = await bootProbe(bootPage)
  check(
    !tapError &&
      tapped.queued === '1' &&
      /queued/i.test(tapped.note ?? '') &&
      /Lint findings/.test(tapped.note ?? ''),
    'boot window: a tap taken before the module arrives is acknowledged, not swallowed',
    tapError ?? `queued=${tapped.queued} · ${(tapped.note ?? 'no note').slice(0, 70)}`,
  )
  check(
    moduleRequested && !tapped.moduleRan,
    'boot window: that acknowledgement came from the page itself, not from the demo module',
    `module requested=${moduleRequested}, initialised=${tapped.moduleRan}`,
  )

  releaseModule()
  await bootPage
    .waitForFunction(() => document.getElementById('pg-side')?.dataset.engine === 'ready', null, {
      timeout: 30_000,
    })
    .catch(() => {})
  const drained = await bootPage
    .waitForFunction(
      () => (document.getElementById('demo-input')?.value ?? '').includes('debugger;'),
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  const readyState = await bootProbe(bootPage)
  check(
    drained,
    'boot window: the queued tap runs once the engine is up instead of being dropped',
    `editor holds the "Lint findings" source: ${drained}`,
  )
  check(
    readyState.engine === 'ready' &&
      readyState.busy === null &&
      readyState.label === 'Examples' &&
      readyState.queued === null,
    'boot window: the pending affordance clears when the controls go live',
    `data-engine=${readyState.engine} aria-busy=${readyState.busy} label=${readyState.label}`,
  )
  await bootPage.unroute('**/assets/demo-panel.js*')
  await bootPage.close()

  // 3. Arriving through a client-side navigation is the other way in, and the
  //    page's own inline scripts do not re-run for it. The controls still have
  //    to be there, and the bar still has to declare a state: a swapped-in
  //    playground that reverted to `hidden` would be the same six-second hole.
  await page.locator('.top-nav a[href$="/playground"]').first().click()
  await page.waitForURL('**/playground')
  await page.waitForFunction(() => Boolean(document.getElementById('pg-scenario-lint')))
  const swappedIn = await bootProbe(page)
  check(
    swappedIn.legible &&
      !swappedIn.hidden &&
      ['starting', 'ready'].includes(swappedIn.engine ?? ''),
    'boot window: a playground reached by client-side navigation arrives with its controls up',
    `data-engine=${swappedIn.engine} hidden=${swappedIn.hidden} ${swappedIn.geometry}`,
  )
} else {
  // A build without the in-browser engine must NOT ship a pending affordance:
  // there the controls never become usable, so promising an engine would be a
  // lie the reader cannot tell from the live case.
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  const staticBar = await bootProbe(page)
  check(
    staticBar.present && staticBar.hidden && staticBar.engine === null,
    'boot window: a build without the in-browser engine promises nothing and stays hidden',
    `hidden=${staticBar.hidden} data-engine=${staticBar.engine}`,
  )
}

// ---------- outline scroll spy ----------
await page.goto(`${baseUrl}/architecture/rust-oxc-core`, { waitUntil: 'load' })
await page.evaluate(() => document.getElementById('performance-evidence').scrollIntoView())
await page.waitForTimeout(400)
const spied = await page.locator('.outline .active a').getAttribute('href')
check(spied === '#performance-evidence', 'outline: scroll spy tracks section', String(spied))

// The reading estimate is the same scroll position read a second way: part way
// down it counts minutes left, and back at the top it names the whole page.
const scrolledTime = await page.locator('.outline-remaining').textContent()
const scrolledFill = await page.locator('.outline-progress-fill').evaluate((el) => el.style.width)
const arrivalTime = await page.evaluate(async () => {
  window.scrollTo(0, 0)
  await new Promise((resolve) => setTimeout(resolve, 400))
  return document.querySelector('.outline-remaining')?.textContent
})
check(
  /^\d+ min read$/.test(arrivalTime ?? '') &&
    /^(\d+ min left|Finished)$/.test(scrolledTime ?? '') &&
    Number.parseFloat(scrolledFill) > 0,
  'outline: reading progress counts down with the page',
  `${arrivalTime} then ${scrolledTime} at ${scrolledFill}`,
)

// ---------- theme toggle + persistence ----------
await page.goto(`${baseUrl}/guide/introduction`, { waitUntil: 'load' })
await page.emulateMedia({ colorScheme: 'light' })
const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
const initialDark = await isDark()
await page.locator('#theme-toggle').click()
check((await isDark()) !== initialDark, 'theme: toggle flips theme')
check(
  (await page.locator('#theme-toggle').getAttribute('aria-pressed')) ===
    String(!initialDark),
  'theme: aria-pressed reflects state',
)
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check(
  !initialDark ? bg === 'rgb(27, 27, 31)' : bg === 'rgb(255, 255, 255)',
  'theme: body background actually changes',
  bg,
)
await page.reload({ waitUntil: 'load' })
check((await isDark()) !== initialDark, 'theme: choice persists across reload')
await page.locator('#theme-toggle').click() // restore

// ---------- search ----------
await page.locator('#search-button').click()
await page.waitForSelector('#search-dialog[open]')
check(true, 'search: button opens dialog')
await page.fill('#search-input', 'formatter')
await page.waitForFunction(() => document.querySelectorAll('#search-results li').length > 0)
const resultCount = await page.locator('#search-results li').count()
check(resultCount > 0, 'search: "formatter" returns results', `${resultCount} results`)
const marks = await page.locator('#search-results mark').count()
check(marks > 0, 'search: matched terms are highlighted')
await page.keyboard.press('ArrowDown')
const activeDescendant = await page.locator('#search-input').getAttribute('aria-activedescendant')
check(activeDescendant === 'search-result-0', 'search: arrow keys drive aria-activedescendant')
await page.keyboard.press('Enter')
await page.waitForFunction(() => !document.getElementById('search-dialog').open)
check(
  /#|\/(guide|integrations|architecture|reference|playground)\//.test(`${page.url()}/`),
  'search: Enter navigates to result',
  page.url(),
)

await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
await page.waitForSelector('#search-dialog[open]')
check(true, 'search: Cmd/Ctrl+K opens dialog')
await page.fill('#search-input', 'zzzzqqqq')
await page.waitForFunction(() =>
  document.getElementById('search-status').textContent.includes('No results'),
)
check(true, 'search: no-result state announced via role=status')
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.getElementById('search-dialog').open)
check(true, 'search: Escape closes dialog')

// ---------- copy button ----------
await page.goto(`${baseUrl}/guide/getting-started`, { waitUntil: 'load' })
const firstBlock = page.locator('.code-block').first()
const firstBlockSource = (await firstBlock.locator('code').textContent()).trimEnd()
await firstBlock.hover()
await firstBlock.locator('.copy-button').click()
const clipboard = await page.evaluate(() => navigator.clipboard.readText())
check(clipboard === firstBlockSource, 'copy: code block copies exact source to clipboard')

// ---------- keyboard navigation / skip link ----------
await page.goto(`${baseUrl}/guide/introduction`, { waitUntil: 'load' })
await page.keyboard.press('Tab')
const skipFocused = await page.evaluate(
  () => document.activeElement?.classList.contains('skip-link') ?? false,
)
check(skipFocused, 'a11y: skip link is first tab stop')
await page.keyboard.press('Enter')
const mainTarget = await page.evaluate(() => location.hash)
check(mainTarget === '#main-content', 'a11y: skip link jumps to main content')

// ---------- axe accessibility scans (light + dark, home + doc + dialog) ----------
async function axeScan(url, { dark = false, openDialog = false } = {}) {
  await page.goto(url, { waitUntil: 'load' })
  await page.evaluate((wantDark) => {
    document.documentElement.classList.toggle('dark', wantDark)
  }, dark)
  if (openDialog) {
    await page.locator('#search-button').click()
    await page.waitForSelector('#search-dialog[open]')
    await page.fill('#search-input', 'lint')
    await page.waitForFunction(() => document.querySelectorAll('#search-results li').length > 0)
  }
  await page.addScriptTag({ content: axeSource })
  const result = await page.evaluate(() =>
    axe.run(document, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
    }),
  )
  const label = `${new URL(url).pathname}${dark ? ' [dark]' : ' [light]'}${openDialog ? ' [search open]' : ''}`
  const violations = result.violations.map((violation) => {
    const targets = violation.nodes
      .slice(0, 3)
      .map((node) => node.target.join(' '))
      .join(', ')
    return `${violation.id} (${violation.impact}): ${violation.nodes.length} nodes [${targets}]`
  })
  check(violations.length === 0, `a11y: axe clean on ${label}`, violations.join('; '))
}

await axeScan(`${baseUrl}/`)
await axeScan(`${baseUrl}/`, { dark: true })
await axeScan(`${baseUrl}/guide/getting-started`)
await axeScan(`${baseUrl}/guide/getting-started`, { dark: true })
await axeScan(`${baseUrl}/reference/benchmarks`, { dark: true })
await axeScan(`${baseUrl}/guide/introduction`, { openDialog: true })
await axeScan(`${baseUrl}/playground`)
await axeScan(`${baseUrl}/reference/benchmarks`)

// ---------- interactive demo (real oxlint/oxfmt through the docs server) ----------
const health = expectedCapabilities
if (liveDemo) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  if (mode === 'wasm') {
    const wasmHint = (await page.locator('#demo-hint').textContent()).trim()
    check(
      wasmHint.includes('runs in your browser'),
      'wasm: home hint names the in-browser engine',
      wasmHint,
    )
  }
  let demoHighlightRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/api/highlight')) demoHighlightRequests++
  })
  // The wasm-mode home hero defers the client highlighter and engine until
  // the first interaction; focus counts as that interaction.
  await page.locator('#demo-input').focus()
  await page.waitForSelector('#demo-editor[data-highlighter="client"]', { timeout: 15000 })
  const originalDemoInput = await page.inputValue('#demo-input')
  demoHighlightRequests = 0
  await page.locator('#demo-input').focus()
  await page.evaluate(() => {
    const input = document.getElementById('demo-input')
    input.setSelectionRange(input.value.length, input.value.length)
  })
  await page.keyboard.type("\nconst zz = 'q';")
  await page.evaluate(() =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  const clientHighlight = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#demo-editor pre code > .line')]
    const line = lines.at(-1)
    return {
      text: line?.textContent ?? '',
      styledTokens: line
        ? [...line.querySelectorAll('span[style]')].filter((token) =>
            token.getAttribute('style').includes('--shiki-light'),
          ).length
        : 0,
    }
  })
  check(
    clientHighlight.text === "const zz = 'q';" && clientHighlight.styledTokens > 0,
    'demo: client highlighter renders exact Shiki tokens on the next frame',
    JSON.stringify(clientHighlight),
  )
  check(
    demoHighlightRequests === 0,
    'demo: client editor typing makes no server highlight requests',
    `${demoHighlightRequests} requests`,
  )
  const immediateTimes = (await page.locator('#demo-times').textContent()).trim()
  check(
    /highlighted in \d+(\.\d+)? ms/.test(immediateTimes),
    'demo: client highlight timing appears immediately',
    immediateTimes,
  )
  await page.waitForFunction(
    () => /compiled in \d+ ms/.test(document.getElementById('demo-times')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  )
  check(true, 'demo: native compile timing appears after lint settles')
  await page.fill('#demo-input', originalDemoInput)
  await page.waitForFunction(() => document.querySelectorAll('.demo-diag').length === 0)
  await page.locator('#hero-demo').scrollIntoViewIfNeeded()
  check(true, 'demo: playground activates when the demo API is present')
  const before = await page.inputValue('#demo-input')
  await page.fill('#demo-input', before.replace('const pending', 'debugger;\n  const pending'))
  await page.waitForSelector('.demo-diag', { timeout: 8000 })
  check(true, 'demo: typing debugger produces a real oxlint diagnostic underline')
  const demoStatus = (await page.locator('#demo-status').textContent()).trim()
  check(/oxlint/.test(demoStatus), 'demo: status reflects the oxlint result', demoStatus)
  const segment = await page.locator('.demo-diag').first().boundingBox()
  await page.mouse.move(segment.x + segment.width / 2, segment.y + segment.height / 2)
  await page.waitForSelector('.demo-tooltip:not([hidden])', { timeout: 5000 })
  const tip = (await page.locator('.demo-tooltip').textContent()).trim()
  check(tip.includes('no-debugger'), 'demo: tooltip shows the rule and message', tip.slice(0, 80))
  await page.locator('#pg-scenario-messy').click()
  await page.waitForFunction(
    () => document.getElementById('demo-input').value.includes('pending = tasks'),
    { timeout: 15000 },
  )
  check(true, 'demo: "Messy → Format" chip auto-runs real oxfmt')
  await page.locator('#pg-scenario-clean').click()
  await page.waitForFunction(() => document.querySelectorAll('.demo-diag').length === 0)
  check(true, 'demo: "Clean" chip restores the converged snippet')

  // The home hero's "Type-aware lint" chip must do something visible in EVERY
  // mode. The type lane needs tsgolint, which the in-browser wasm engine does
  // not ship, so on the published site the chip replays the pre-generated
  // report instead of going quiet.
  const beforeTypes = await page.inputValue('#demo-input')
  await page.locator('#pg-scenario-types').click()
  await page.waitForFunction(
    (previous) => document.getElementById('demo-input').value !== previous,
    beforeTypes,
    { timeout: 15000 },
  )
  const typesSource = await page.inputValue('#demo-input')
  check(
    typesSource.includes('saveTask(task);'),
    'demo: "Type-aware lint" chip loads the snippet with the unawaited Promise',
  )
  await page.waitForSelector('.demo-diag', { timeout: 20000 })
  const typesDiagCount = await page.locator('.demo-diag').count()
  const typesSegment = await page.locator('.demo-diag').first().boundingBox()
  await page.mouse.move(
    typesSegment.x + typesSegment.width / 2,
    typesSegment.y + typesSegment.height / 2,
  )
  await page.waitForSelector('.demo-tooltip:not([hidden])', { timeout: 5000 })
  const typesTip = (await page.locator('.demo-tooltip').textContent()).trim()
  // A tsgolint rule finding, not a bare compiler error: the latter is what an
  // editor's language server already reports, so it would prove nothing here.
  check(
    /no-floating-promises/.test(typesTip) && !/TS\d{4}/.test(typesTip),
    'demo: "Type-aware lint" chip underlines the call with a tsgolint rule finding',
    `${typesDiagCount} underlines · ${typesTip.slice(0, 90)}`,
  )
  // Every chip has to explain itself on the hero, not just on the playground.
  const heroNote = (await page.locator('#pg-scenario-note').textContent()).trim()
  check(
    heroNote.length > 0 && /promise|type-aware/i.test(heroNote),
    'demo: the home hero shows the scenario note',
    heroNote.slice(0, 90),
  )
  if (mode === 'wasm') {
    const typesMeta = (await page.locator('#demo-meta').textContent()).trim()
    check(
      /pre-generated/i.test(typesMeta),
      'wasm: the "Type-aware lint" chip labels the replayed report as pre-generated',
      typesMeta,
    )
  }
  await page.mouse.move(1, 1)
  await page.locator('#pg-scenario-clean').click()
  await page.waitForFunction(() => document.querySelectorAll('.demo-diag').length === 0)

  // Tab indents inside the editor instead of moving focus; Escape releases it.
  await page.click('#demo-input')
  await page.evaluate(() => {
    const input = document.getElementById('demo-input')
    input.setSelectionRange(0, 0)
  })
  const beforeTab = await page.inputValue('#demo-input')
  await page.keyboard.press('Tab')
  const afterTab = await page.inputValue('#demo-input')
  const stillFocused = await page.evaluate(() => document.activeElement?.id === 'demo-input')
  check(
    stillFocused && afterTab === `  ${beforeTab}`,
    'demo: Tab indents code and keeps focus in the editor',
  )
  await page.keyboard.down('Shift')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Shift')
  check(
    (await page.inputValue('#demo-input')) === beforeTab,
    'demo: Shift+Tab outdents back to the original',
  )
  await page.keyboard.press('Escape')
  const escaped = await page.evaluate(() => document.activeElement?.id !== 'demo-input')
  check(escaped, 'demo: Escape releases focus from the editor')
} else if (mode === 'native') {
  check(
    false,
    'demo: API unavailable',
    'build the release binaries and serve with docs/serve.mjs to enable the live demo',
  )
} else {
  check(health?.mode === 'static' && health?.native === false, 'demo: static capability contract')
  await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('demo-hint')?.textContent === 'static preview',
  )
  check((await page.locator('#demo-input').count()) === 0, 'demo: static home stays read-only')
  check(await page.locator('#demo-actions').isHidden(), 'demo: static actions stay hidden')
  check(
    (await page.locator('#demo-times').count()) === 0 ||
      (await page.locator('#demo-times').textContent()).trim() === '',
    'demo: static home has no timing readout',
  )
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('demo-hint')?.textContent === 'static preview',
  )
  check((await page.locator('#demo-input').count()) === 0, 'demo: static playground stays read-only')
  check(await page.locator('#pg-side').isHidden(), 'demo: native-only controls stay hidden')
  check(
    (await page.locator('#demo-times').count()) === 0 ||
      (await page.locator('#demo-times').textContent()).trim() === '',
    'demo: static playground has no timing readout',
  )
  const staticStatus = (await page.locator('#demo-status').textContent()).trim()
  const staticMeta = (await page.locator('#demo-meta').textContent()).trim()
  check(
    staticStatus.includes('pre-generated') && staticStatus.includes('static preview'),
    'demo: static status does not claim a live lint or format run',
    staticStatus,
  )
  check(
    staticMeta.includes('local development server'),
    'demo: static metadata names the localhost-only native boundary',
    staticMeta,
  )
  const hostile = '<img src=x onerror="window.__shareXss=1">'
  const bytes = new TextEncoder().encode(hostile)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = Buffer.from(binary, 'binary').toString('base64url')
  // Arrive as an actual shared-link navigation. A hash-only navigation on an
  // already-open playground is same-document and intentionally does not rerun
  // module initialization.
  await page.goto(`${baseUrl}/guide/introduction`, { waitUntil: 'load' })
  await page.goto(`${baseUrl}/playground#code=${encoded}`, { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.getElementById('demo-hint')?.textContent === 'static preview',
  )
  check(
    (await page.locator('#demo-editor').textContent()).includes(hostile) &&
      (await page.evaluate(() => window.__shareXss)) === undefined,
    'demo: hostile shared source stays literal in static preview',
  )
}

// ---------- data-driven benchmarks page ----------
await page.goto(`${baseUrl}/reference/benchmarks`, { waitUntil: 'load' })
await page.waitForSelector('.bench-chart', { timeout: 10000 })
const chartCount = await page.locator('.bench-chart').count()
const passCells = await page.locator('td.bench-pass').count()
check(chartCount === 6, 'benchmarks: six generated charts', String(chartCount))
check(passCells > 25, 'benchmarks: generated status cells', `${passCells} pass cells`)
const reportNamed = await page.locator('article').textContent()
check(
  /results-\d+\.json/.test(reportNamed),
  'benchmarks: report filenames rendered from disk',
)
await page.locator('.bench-row').first().scrollIntoViewIfNeeded()
await page.waitForTimeout(300) // let scroll events settle (scroll hides the tooltip)
await page.locator('.bench-row').first().dispatchEvent('mouseover')
await page.waitForSelector('.chart-tooltip:not([hidden])', { timeout: 5000 })
const chartTip = (await page.locator('.chart-tooltip').textContent()).trim()
check(
  chartTip.includes('Budget:') && chartTip.includes('pass'),
  'benchmarks: chart rows show interactive tooltips',
  chartTip.slice(0, 60),
)

// ---------- llms.txt + copy as markdown + footer badge ----------
const llms = await (await fetch(`${baseUrl}/llms.txt`)).text()
check(llms.startsWith('# OXC for TSRX'), 'llms: llms.txt is served and well-formed')
const llmsFull = await (await fetch(`${baseUrl}/llms-full.txt`)).text()
check(llmsFull.includes('## '), 'llms: llms-full.txt contains page content')
await page.goto(`${baseUrl}/guide/linting`, { waitUntil: 'load' })
await page.locator('.copy-md-button').first().click()
await page.waitForFunction(() =>
  document.querySelector('.copy-md-button').textContent.includes('Copied'),
)
const copiedMd = await page.evaluate(() => navigator.clipboard.readText())
check(copiedMd.includes('# Linting'), 'copy-md: page markdown lands on the clipboard')
await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
const badge = (await page.locator('.footer-badge').textContent()).trim()
check(
  badge.includes('Pinned OXC 8e0ed2ebb961') && /\d{4}-\d{2}-\d{2}/.test(badge),
  'badge: footer shows pinned OXC revision and report date',
  badge,
)
const disclaimer = (await page.locator('.footer-disclaimer').textContent()).trim()
check(disclaimer.includes('official OXC integration for TSRX'), 'footer: official OXC integration line present')

// ---------- projection explorer ----------
await page.goto(`${baseUrl}/guide/linting`, { waitUntil: 'load' })
const tabCount = await page
  .locator('[aria-label="Projection stages"] [role="tab"]')
  .count()
check(tabCount === 3, 'explorer: three stage tabs', String(tabCount))
const pipelineTabs = await page.locator('.pipeline [role="tab"]').count()
check(pipelineTabs === 5, 'pipeline: five interactive stages replace the ASCII diagram', String(pipelineTabs))
await page.locator('#explorer-tab-projected').click()
const projectedVisible = await page.evaluate(() => {
  const panel = document.getElementById('explorer-panel-projected')
  return !panel.hidden && panel.textContent.includes('_t0_')
})
check(projectedVisible, 'explorer: projected tab shows real scaffold markers')
await page.keyboard.press('ArrowRight')
const mappedSelected = await page.evaluate(
  () => document.getElementById('explorer-tab-mapped').getAttribute('aria-selected') === 'true',
)
check(mappedSelected, 'explorer: arrow keys move between tabs')

// ---------- how-it-works walkthrough ----------
await page.goto(`${baseUrl}/guide/introduction`, { waitUntil: 'load' })
await page.waitForSelector('[data-how-it-works][data-hiw-ready]')
const hiwSteps = await page.locator('[data-hiw-step]').count()
check(hiwSteps === 4, 'how-it-works: four step buttons', String(hiwSteps))
const hiwInitial = await page.evaluate(() => {
  const figure = document.querySelector('[data-how-it-works]')
  const visibleTexts = [...figure.querySelectorAll('.hiw-text')].filter(
    (text) => getComputedStyle(text).display !== 'none',
  )
  return { step: figure.dataset.step, visible: visibleTexts.length }
})
check(
  hiwInitial.step === 'scan' && hiwInitial.visible === 1,
  'how-it-works: starts on scan with a single explanation visible',
  JSON.stringify(hiwInitial),
)
await page.locator('[data-hiw-step="lint"]').click()
const hiwLint = await page.evaluate(() => {
  const figure = document.querySelector('[data-how-it-works]')
  const button = figure.querySelector('[data-hiw-step="lint"]')
  const diagLine = figure.querySelector(
    '.projection-map-pane:last-of-type [data-diag-line]',
  )
  return {
    step: figure.dataset.step,
    pressed: button.getAttribute('aria-pressed'),
    highlighted: getComputedStyle(diagLine).boxShadow !== 'none',
  }
})
check(
  hiwLint.step === 'lint' && hiwLint.pressed === 'true' && hiwLint.highlighted,
  'how-it-works: lint step highlights the flagged lines in the projected pane',
  JSON.stringify(hiwLint),
)
await page.locator('[data-scaffolding-toggle]').click()
// Scaffold lines fade over a 140ms transition; wait for it to land.
await page.waitForFunction(
  () =>
    Number(
      getComputedStyle(document.querySelector('[data-how-it-works] [data-scaffold]'))
        .opacity,
    ) < 1,
  null,
  { timeout: 2000 },
)
check(true, 'how-it-works: dim-the-scaffolding toggle still fades scaffold lines')
await page.locator('[data-scaffolding-toggle]').click()

// ---------- architecture diagram step tabs ----------
await page.goto(`${baseUrl}/architecture/rust-oxc-core`, { waitUntil: 'load' })
await page.waitForSelector('.diagram[data-ready] [data-diagram-step]')
const diagramInitialStrip = await page.evaluate(() => {
  const figure = document.querySelector('.diagram[data-ready]')
  return {
    strip: figure.querySelector('.diagram-caption-strip').textContent,
    firstCaption: figure.querySelector('[data-diagram-step]').dataset.caption,
  }
})
check(
  diagramInitialStrip.strip === diagramInitialStrip.firstCaption,
  'diagram: strip starts on the first step caption',
  JSON.stringify(diagramInitialStrip),
)
const diagramStepSwitch = await page.evaluate(() => {
  const figure = document.querySelector('.diagram[data-ready]')
  const steps = figure.querySelectorAll('[data-diagram-step]')
  const third = steps[2]
  third.click()
  return {
    strip: figure.querySelector('.diagram-caption-strip').textContent,
    caption: third.dataset.caption,
    pressed: third.getAttribute('aria-pressed'),
  }
})
check(
  diagramStepSwitch.pressed === 'true' &&
    diagramStepSwitch.caption.length > 0 &&
    diagramStepSwitch.strip === diagramStepSwitch.caption,
  'diagram: clicking a step tab swaps the caption strip to that step',
  JSON.stringify(diagramStepSwitch),
)
// A synthetic click event was used here once. It went straight to the node and
// so it passed while a real press-and-release on the artboard selected nothing:
// the stage took the pointer capture, which retargets the click to the stage.
// Drive the real mouse instead, the way a reader does.
const diagramNode = page.locator('.diagram[data-ready] [data-diagram-node]').first()
await diagramNode.click()
const diagramNodeAfterStep = await page.evaluate(() => {
  const figure = document.querySelector('.diagram[data-ready]')
  const node = figure.querySelector('[data-diagram-node]')
  return {
    strip: figure.querySelector('.diagram-caption-strip').textContent,
    caption: node.dataset.caption,
    pressed: node.getAttribute('aria-pressed'),
    active: node.classList.contains('diagram-node-active'),
    focused: document.activeElement === node,
  }
})
check(
  diagramNodeAfterStep.strip === diagramNodeAfterStep.caption &&
    diagramNodeAfterStep.pressed === 'true' &&
    diagramNodeAfterStep.active &&
    diagramNodeAfterStep.focused,
  'diagram: a real click on a node selects it and shows that node explanation',
  JSON.stringify(diagramNodeAfterStep),
)

// Panning is a drag, not a selection: a drag that happens to end on a node must
// leave the strip alone.
const diagramNodeBox = await diagramNode.boundingBox()
await page.mouse.move(diagramNodeBox.x + diagramNodeBox.width / 2 - 60, diagramNodeBox.y + 8)
await page.mouse.down()
await page.mouse.move(diagramNodeBox.x + diagramNodeBox.width / 2, diagramNodeBox.y + diagramNodeBox.height / 2, {
  steps: 20,
})
const diagramCursorMidDrag = await page.evaluate(() => {
  const figure = document.querySelector('.diagram[data-ready]')
  const node = figure.querySelector('[data-diagram-node]')
  return {
    node: getComputedStyle(node).cursor,
    stage: getComputedStyle(figure.querySelector('.diagram-stage')).cursor,
  }
})
await page.mouse.up()
const diagramAfterDrag = await page.evaluate(() => {
  const figure = document.querySelector('.diagram[data-ready]')
  const second = figure.querySelectorAll('[data-diagram-node]')[1]
  return {
    strip: figure.querySelector('.diagram-caption-strip').textContent,
    secondCaption: second.dataset.caption,
  }
})
check(
  diagramAfterDrag.strip !== diagramAfterDrag.secondCaption,
  'diagram: a pan that ends on a node does not select it',
  JSON.stringify(diagramAfterDrag),
)
check(
  diagramCursorMidDrag.node === 'grabbing' && diagramCursorMidDrag.stage === 'grabbing',
  'diagram: panning shows the closed hand over the whole artboard',
  JSON.stringify(diagramCursorMidDrag),
)

// Nodes are the only thing on the artboard you can select, so they are the only
// thing that gets a pointer. Everything else is pan surface.
const diagramCursorAtRest = await page.evaluate(() => {
  const figure = document.querySelector('.diagram[data-ready]')
  const stage = figure.querySelector('.diagram-stage')
  const node = figure.querySelector('[data-diagram-node]')
  return {
    node: getComputedStyle(node).cursor,
    label: getComputedStyle(node.querySelector('text') ?? node).cursor,
    shape: getComputedStyle(node.querySelector('.shape > *')).cursor,
    stage: getComputedStyle(stage).cursor,
    background: getComputedStyle(stage.querySelector('svg rect')).cursor,
  }
})
check(
  diagramCursorAtRest.node === 'pointer' &&
    diagramCursorAtRest.label === 'pointer' &&
    diagramCursorAtRest.shape === 'pointer' &&
    diagramCursorAtRest.stage === 'grab' &&
    diagramCursorAtRest.background === 'grab',
  'diagram: the cursor is a pointer on a node and a grab hand off it',
  JSON.stringify(diagramCursorAtRest),
)

// ---------- transplant matrix filter (upstreaming page) ----------
await page.goto(`${baseUrl}/architecture/upstreaming-to-oxc`, { waitUntil: 'load' })
await page.waitForSelector('[data-matrix-filter][data-ready]')
const matrixFiltered = await page.evaluate(() => {
  const filter = document.querySelector('[data-matrix-filter]')
  const chip = filter.querySelector('[data-matrix-chip="reuse"]')
  chip.click()
  const rows = [...filter.querySelectorAll('tr[data-classification]')]
  return {
    pressed: chip.getAttribute('aria-pressed'),
    visible: rows.filter((row) => !row.hidden).length,
    hidden: rows.filter((row) => row.hidden).length,
    allVisible: rows.filter((row) => !row.hidden).every((row) => row.dataset.classification === 'reuse'),
    status: filter.querySelector('[data-matrix-status]').textContent,
  }
})
check(
  matrixFiltered.pressed === 'true' &&
    matrixFiltered.visible > 0 &&
    matrixFiltered.hidden > 0 &&
    matrixFiltered.allVisible &&
    /Showing \d+ of \d+/.test(matrixFiltered.status),
  'matrix filter: classification chip hides other rows and announces the count',
  JSON.stringify(matrixFiltered),
)
const matrixReset = await page.evaluate(() => {
  const filter = document.querySelector('[data-matrix-filter]')
  filter.querySelector('[data-matrix-chip="all"]').click()
  return [...filter.querySelectorAll('tr[data-classification]')].every((row) => !row.hidden)
})
check(matrixReset, 'matrix filter: All chip restores every row')

// ---------- chooser (provider protocol page) ----------
// The chooser replaces a decision table, so the thing worth proving is that a
// reader who picks their own case is left looking at exactly one answer.
await page.goto(`${baseUrl}/architecture/provider-protocol`, { waitUntil: 'load' })
await page.waitForSelector('[data-chooser][data-ready]')
const chooserStart = await page.evaluate(() => {
  const chooser = document.querySelector('[data-chooser]')
  return {
    options: chooser.querySelectorAll('[data-chooser-option]').length,
    shown: [...chooser.querySelectorAll('[data-chooser-panel]')].filter((panel) => !panel.hidden)
      .length,
    pressed: chooser.querySelector('[data-chooser-option][aria-pressed="true"]')?.dataset
      .chooserOption,
  }
})
check(
  chooserStart.options >= 2 && chooserStart.shown === 1 && chooserStart.pressed === '0',
  'chooser: opens on the first case with one answer showing',
  JSON.stringify(chooserStart),
)
await page.locator('[data-chooser-option]').last().click()
const chooserPicked = await page.evaluate(() => {
  const chooser = document.querySelector('[data-chooser]')
  const options = [...chooser.querySelectorAll('[data-chooser-option]')]
  const shown = [...chooser.querySelectorAll('[data-chooser-panel]')].filter((panel) => !panel.hidden)
  return {
    shown: shown.length,
    answers: shown[0]?.textContent.trim().length ?? 0,
    matches: shown[0]?.dataset.chooserPanel === options.at(-1).dataset.chooserOption,
    pressed: options.filter((option) => option.getAttribute('aria-pressed') === 'true').length,
  }
})
check(
  chooserPicked.shown === 1 &&
    chooserPicked.matches &&
    chooserPicked.pressed === 1 &&
    chooserPicked.answers > 20,
  'chooser: picking a case swaps to that answer and presses only that chip',
  JSON.stringify(chooserPicked),
)

// ---------- editor replay (editor page) ----------
await page.goto(`${baseUrl}/integrations/editor`, { waitUntil: 'load' })
await page.waitForSelector('[data-editor-replay][data-ready]')
const replaySquiggles = await page.evaluate(() => ({
  squiggles: document.querySelectorAll('[data-editor-replay] .er-squiggle').length,
  windows: document.querySelectorAll('[data-editor-replay] .er-window').length,
}))
check(
  replaySquiggles.squiggles >= 3 && replaySquiggles.windows === 3,
  'editor replay: three stage windows render with diagnostic squiggles',
  JSON.stringify(replaySquiggles),
)
const replayStage = await page.evaluate(() => {
  const replay = document.querySelector('[data-editor-replay]')
  const tabs = [...replay.querySelectorAll('[role="tab"]')]
  tabs[2].click()
  const panels = [...replay.querySelectorAll('[role="tabpanel"]')]
  return {
    selected: tabs[2].getAttribute('aria-selected'),
    lastVisible: !panels[2].hidden,
    firstHidden: panels[0].hidden,
  }
})
check(
  replayStage.selected === 'true' && replayStage.lastVisible && replayStage.firstHidden,
  'editor replay: stage tabs switch the visible editor window',
  JSON.stringify(replayStage),
)
const replayPlay = await page.evaluate(() => {
  const replay = document.querySelector('[data-editor-replay]')
  replay.querySelector('[data-er-play]').click()
  const tabs = [...replay.querySelectorAll('[role="tab"]')]
  return tabs[0].getAttribute('aria-selected')
})
check(replayPlay === 'true', 'editor replay: Play rewinds to the first stage and starts advancing')

// ---------- annotated config fields (configuration page) ----------
await page.goto(`${baseUrl}/integrations/configuration`, { waitUntil: 'load' })
const configHovers = await page
  .locator('.code-block[data-lang="jsonc"] .tsrx-hover')
  .count()
check(configHovers >= 10, 'config docs: jsonc fields annotated with hover docs', String(configHovers))
await page.locator('.code-block[data-lang="jsonc"] .tsrx-hover').first().scrollIntoViewIfNeeded()
await page.waitForTimeout(250)
await page
  .locator('.code-block[data-lang="jsonc"] .tsrx-hover')
  .first()
  .dispatchEvent('mouseover')
await page.waitForSelector('.chart-tooltip:not([hidden])', { timeout: 4000 })
const configHoverText = (await page.locator('.chart-tooltip').textContent()).trim()
check(
  configHoverText.length > 20,
  'config docs: hovering a field shows its native-boundary meaning',
  configHoverText.slice(0, 50),
)

// ---------- try-it buttons ----------
await page.goto(`${baseUrl}/guide/tsrx-syntax`, { waitUntil: 'load' })
const fenceCode = await page.evaluate(() => document.querySelector('.try-button').dataset.code)
await page.locator('.try-button').first().click()
await page.waitForURL('**/playground#code=*')
if (liveDemo) {
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  const editorValue = await page.inputValue('#demo-input')
  check(editorValue === fenceCode, 'try-it: fence code lands in the playground editor')
} else {
  await page.waitForFunction(
    () => document.getElementById('demo-hint')?.textContent === 'static preview',
  )
  const previewValue = await page.locator('#demo-editor code').textContent()
  check(previewValue === fenceCode, 'try-it: fence code lands in the static preview')
  check((await page.locator('#demo-input').count()) === 0, 'try-it: static preview stays read-only')
}

// ---------- playground: filters, config, share, type-aware ----------
if (liveDemo) {
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  if (mode === 'wasm') {
    const modeNoteText = (await page.locator('#pg-mode-note').textContent()).trim()
    check(
      modeNoteText.includes('WebAssembly'),
      'wasm: playground mode note names the in-browser engine',
      modeNoteText,
    )
  }
  // "Lint findings" then "Silence a rule": the -A flags run internally.
  await page.locator('#pg-scenario-lint').click()
  await page.waitForSelector('.demo-diag', { timeout: 8000 })
  await page.locator('#pg-scenario-silence').click()
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.demo-diag').length === 0 &&
      document.getElementById('demo-meta').textContent.includes('-A no-debugger'),
    { timeout: 8000 },
  )
  check(true, 'playground: "Silence a rule" example runs real -A severity flags')
  // "Custom config": no-console becomes an error via --config.
  await page.locator('#pg-scenario-config').click()
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.demo-diag').length > 0 &&
      document.getElementById('demo-meta').textContent.includes('--config'),
    { timeout: 8000 },
  )
  const configStatus = await page.locator('#demo-status').textContent()
  check(/error/.test(configStatus), 'playground: "Custom config" example feeds --config', configStatus.trim())
  // Share link round-trip.
  await page.locator('#demo-share').click()
  await page.waitForFunction(() => location.hash.includes('code='))
  const shareUrl = await page.evaluate(() => navigator.clipboard.readText())
  check(shareUrl.includes('#code='), 'playground: share copies a snippet URL')
  const sharedValue = await page.inputValue('#demo-input')
  await page.goto(shareUrl, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  await page.waitForFunction(
    (expected) => document.getElementById('demo-input').value === expected,
    sharedValue,
  )
  check(true, 'playground: share URL restores the snippet')
  if (health.typeAware) {
    await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
    await page.waitForSelector('#demo-input', { timeout: 10000 })
    await page.locator('#pg-scenario-types').click()
    await page.waitForFunction(
      () => document.getElementById('demo-meta').textContent.includes('type-aware'),
      { timeout: 20000 },
    )
    check(true, 'playground: "Type-aware lint" example runs the TypeScript-Go lane')
  } else {
    check(true, 'playground: type-aware unavailable on this host (skipped)', 'tsgolint missing')
  }
  // Format-as-diff on deliberately misformatted code.
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  await page.fill('#demo-input', 'export function T() @{\n  const x=1;\n  <b/>\n}')
  await page.locator('#demo-format').click()
  await page.waitForFunction(() =>
    document.getElementById('demo-input').value.includes('const x = 1;'),
  )
  check(true, 'playground: Format applies real oxfmt output directly')

  const maliciousRule = 'x" onpointerover="window.__shareXss=1" data-x="'
  await page.goto(
    `${baseUrl}/playground#filters=${encodeURIComponent(`${maliciousRule}:warn`)}`,
    { waitUntil: 'load' },
  )
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  check(
    (await page.locator('#pg-filters [onpointerover]').count()) === 0 &&
      (await page.evaluate(() => window.__shareXss)) === undefined,
    'playground: hostile shared filter cannot inject DOM attributes',
  )

  if (mode === 'native') {
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  const staleOriginal = 'export function T() @{\n  const value=1;\n  <b/>;\n}'
  const newerSource = 'export function T() @{\n  const newer = 2;\n  <b/>;\n}'
  await page.fill('#demo-input', staleOriginal)
  let releaseFormat
  let interceptedFormat
  const formatIntercepted = new Promise((resolve) => {
    interceptedFormat = resolve
  })
  const formatGate = new Promise((resolve) => {
    releaseFormat = resolve
  })
  await page.route(
    '**/api/format',
    async (route) => {
      interceptedFormat()
      await formatGate
      await route.continue()
    },
    { times: 1 },
  )
  await page.locator('#demo-format').click()
  await formatIntercepted
  await page.fill('#demo-input', newerSource)
  releaseFormat()
  await page.waitForTimeout(500)
  check(
    (await page.inputValue('#demo-input')) === newerSource,
    'playground: stale format response cannot overwrite a newer edit',
  )
  }
}

// ---------- home benchmark chart + page menu + dual-pane output ----------
await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
await page.waitForSelector('.home-bench .bench-row')
const homeRows = await page.locator('.home-bench .bench-row').count()
check(homeRows >= 5, 'home: headline benchmark chart rendered', `${homeRows} rows`)
await page.locator('.home-bench').scrollIntoViewIfNeeded()
await page.waitForTimeout(300) // let scroll events settle (scroll hides the tooltip)
await page.locator('.home-bench .bench-row').first().dispatchEvent('mouseover')
await page.waitForSelector('.chart-tooltip:not([hidden])', { timeout: 5000 })
const homeTip = (await page.locator('.chart-tooltip').textContent()).trim()
check(
  homeTip.includes('Budget:') && /ESLint|Oxlint/.test(homeTip),
  'home: chart rows explain their metric on hover',
  homeTip.slice(0, 60),
)
await page.goto(`${baseUrl}/guide/linting`, { waitUntil: 'load' })
await page.locator('.page-menu-toggle').click()
await page.waitForSelector('.page-menu-list:not([hidden])')
const menuItems = await page.locator('.page-menu-list [role="menuitem"]').count()
const aiLinks = await page.evaluate(() =>
  [...document.querySelectorAll('.page-menu-list a')].map((a) => a.href),
)
check(
  menuItems === 4 && aiLinks.some((h) => h.includes('chatgpt.com')) && aiLinks.some((h) => h.includes('claude.ai')),
  'page menu: markdown + ChatGPT + Claude items',
  `${menuItems} items`,
)
await page.keyboard.press('Escape')
if (liveDemo) {
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  await page.waitForFunction(
    () => document.getElementById('pg-projected').textContent.includes('_t0_'),
    { timeout: 15000 },
  )
  check(true, 'playground: Projected TSX pane shows the real projection')
  await page.locator('#pg-tab-structure').click()
  const structureText = await page.locator('#pg-structure').textContent()
  check(
    structureText.includes('FunctionBody') && structureText.includes('controls'),
    'playground: Structure pane lists real overlay tokens',
  )
  await page.locator('#pg-tab-formatted').click()
  await page.waitForFunction(
    () => document.getElementById('pg-formatted').textContent.includes('TaskList'),
  )
  check(true, 'playground: Formatted pane shows real oxfmt output')
  // Tooltip must sit above its trigger.
  const pgSource = await page.inputValue('#demo-input')
  await page.fill('#demo-input', pgSource.replace('const pending', 'debugger;\n  const pending'))
  await page.waitForSelector('.demo-diag', { timeout: 8000 })
  const trigger = await page.locator('.demo-diag').first().boundingBox()
  await page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2)
  await page.waitForSelector('.demo-tooltip:not([hidden])')
  const tipBox = await page.locator('.demo-tooltip').boundingBox()
  check(
    tipBox.y + tipBox.height <= trigger.y + 1,
    'tooltip: positioned directly above its trigger',
    `tooltip bottom ${Math.round(tipBox.y + tipBox.height)} vs trigger top ${Math.round(trigger.y)}`,
  )
}

// ---------- playground workbench + editor features + hover docs ----------
if (liveDemo) {
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  await page.waitForTimeout(600)
  const paneBox = () => page.locator('#pg-output').boundingBox()
  const paneBefore = await paneBox()
  await page.locator('#pg-tab-structure').click()
  await page.locator('#pg-tab-diagnostics').click()
  const paneAfter = await paneBox()
  check(
    JSON.stringify(paneBefore) === JSON.stringify(paneAfter),
    'workbench: switching output tabs never resizes the panes',
  )
  check(
    !(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1)),
    'workbench: playground fills the viewport without page scroll',
  )
  await page.fill('#demo-input', '')
  await page.click('#demo-input')
  await page.keyboard.type('<div>')
  check(
    (await page.inputValue('#demo-input')) === '<div></div>',
    'editor: typing > auto-closes the JSX tag (Markless autoClosingTags)',
  )
  await page.fill('#demo-input', '')
  await page.keyboard.type('(')
  check(
    (await page.inputValue('#demo-input')) === '()',
    'editor: brackets auto-close like the Markless language configuration',
  )
}
await page.goto(`${baseUrl}/guide/tsrx-syntax`, { waitUntil: 'load' })
const hoverSpans = await page.locator('.tsrx-hover').count()
check(hoverSpans >= 8, 'hover docs: TSRX constructs annotated in code examples', String(hoverSpans))
await page.locator('.tsrx-hover').first().scrollIntoViewIfNeeded()
await page.waitForTimeout(250)
await page.locator('.tsrx-hover').first().dispatchEvent('mouseover')
await page.waitForSelector('.chart-tooltip:not([hidden])', { timeout: 4000 })
const hoverText = (await page.locator('.chart-tooltip').textContent()).trim()
check(
  hoverText.includes('Statement container') || hoverText.includes('Conditional'),
  'hover docs: editor-style tooltip shows construct documentation',
  hoverText.slice(0, 50),
)

// ---------- @-snippet completions (Markless catalog) ----------
if (liveDemo) {
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  await page.fill('#demo-input', '')
  await page.click('#demo-input')
  await page.keyboard.type('@fo')
  await page.waitForSelector('.demo-completions:not([hidden])', { timeout: 4000 })
  const options = await page.locator('.demo-completions li').count()
  check(options >= 3, 'intellisense: typing @ opens directive completions', `${options} options`)
  const completionAria = await page.evaluate(() => {
    const input = document.getElementById('demo-input')
    const listbox = document.querySelector('.demo-completions')
    const combobox = input.closest('[role="combobox"]')
    const active = document.getElementById(input.getAttribute('aria-activedescendant'))
    return {
      role: combobox?.getAttribute('role'),
      autocomplete: input.getAttribute('aria-autocomplete'),
      expanded: combobox?.getAttribute('aria-expanded'),
      controls: combobox?.getAttribute('aria-controls'),
      inputControls: input.getAttribute('aria-controls'),
      listbox: listbox.id,
      activeIsSelectedOption:
        active?.getAttribute('role') === 'option' && active.getAttribute('aria-selected') === 'true',
    }
  })
  check(
    completionAria.role === 'combobox' &&
      completionAria.autocomplete === 'list' &&
      completionAria.expanded === 'true' &&
      completionAria.controls === completionAria.listbox &&
      completionAria.inputControls === completionAria.listbox &&
      completionAria.activeIsSelectedOption,
    'intellisense: completion popup exposes the ARIA combobox relationship and active option',
    JSON.stringify(completionAria),
  )
  const firstActive = await page.locator('#demo-input').getAttribute('aria-activedescendant')
  await page.keyboard.press('ArrowDown')
  const nextActive = await page.locator('#demo-input').getAttribute('aria-activedescendant')
  check(
    Boolean(nextActive) && nextActive !== firstActive,
    'intellisense: arrow keys update the active descendant',
    `${firstActive} -> ${nextActive}`,
  )
  await page.keyboard.press('Escape')
  const closedAria = await page.evaluate(() => {
    const input = document.getElementById('demo-input')
    const combobox = input.closest('[role="combobox"]')
    return {
      expanded: combobox?.getAttribute('aria-expanded'),
      active: input.getAttribute('aria-activedescendant'),
      hidden: document.querySelector('.demo-completions').hidden,
      focused: document.activeElement === input,
    }
  })
  check(
    closedAria.expanded === 'false' &&
      closedAria.active === null &&
      closedAria.hidden &&
      closedAria.focused,
    'intellisense: Escape closes the popup and clears ARIA active state without leaving the editor',
    JSON.stringify(closedAria),
  )
  await page.fill('#demo-input', '')
  await page.keyboard.type('@fo')
  await page.waitForSelector('.demo-completions:not([hidden])', { timeout: 4000 })
  await page.keyboard.press('Enter')
  const inserted = await page.inputValue('#demo-input')
  check(
    inserted.startsWith('@for (const item of '),
    'intellisense: Enter inserts the Markless snippet with caret placement',
    JSON.stringify(inserted.split('\n')[0]),
  )
}

// ---------- plain-language homepage metrics + glossary hovers ----------
await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
const homeLabels = await page.evaluate(() =>
  [...document.querySelectorAll('.home-bench .bench-row')].map((row) => row.dataset.label),
)
check(
  homeLabels.length >= 5 && !homeLabels.some((label) => /p95|throughput|projection/i.test(label)),
  'home: headline metric labels avoid jargon',
  homeLabels.join(' | '),
)
// Scoped to the gate cards. The four comparative bars deliberately carry no
// hover prose: their labels name the tool, the caption under the chart states
// what was measured, and the methodology block below carries the route
// evidence and the mixed lane's non-comparability disclaimer. A gate card is
// different, since a bare number there does not say what was measured.
const homeNotes = await page.evaluate(() =>
  [...document.querySelectorAll('.home-bench .gate-card')].map((row) => row.dataset.note ?? ''),
)
check(
  homeNotes.length >= 6 && homeNotes.every((note) => note.length > 20),
  'home: every release gate has a plain-language explanation on hover',
)
await page.goto(`${baseUrl}/reference/benchmarks`, { waitUntil: 'load' })
const glossaryTerms = await page.evaluate(() =>
  [...document.querySelectorAll('article .tsrx-hover')].map((el) => el.dataset.docTitle),
)
check(
  glossaryTerms.includes('p95') && glossaryTerms.includes('throughput'),
  'glossary: p95 and throughput get hover definitions on the benchmarks page',
  glossaryTerms.join(', '),
)
const glossaryHover = page.locator('article .tsrx-hover').first()
await glossaryHover.scrollIntoViewIfNeeded()
await page.waitForTimeout(150)
await glossaryHover.hover()
await page.waitForSelector('.chart-tooltip:not([hidden])', { timeout: 4000 })
const projGlossary = (await page.locator('.chart-tooltip:not([hidden])').textContent()) ?? ''
check(projGlossary.length > 10, 'glossary: hover shows the definition tooltip', projGlossary.slice(0, 40))

// ---------- snippet caret + TypeScript completions ----------
if (liveDemo) {
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  await page.fill('#demo-input', '')
  await page.click('#demo-input')
  await page.keyboard.type('@for')
  await page.waitForSelector('.demo-completions:not([hidden])')
  await page.keyboard.press('Enter')
  const caretInfo = await page.evaluate(() => {
    const input = document.getElementById('demo-input')
    return { caret: input.selectionStart, expected: input.value.indexOf('of ') + 3 }
  })
  check(
    caretInfo.caret === caretInfo.expected,
    'intellisense: snippet caret lands inside the @for header',
    `caret ${caretInfo.caret} expected ${caretInfo.expected}`,
  )
  const completionsReady =
    mode === 'native'
      ? (await (await fetch(`${baseUrl}/api/health`)).json()).completions
      : false
  if (completionsReady) {
    await page.fill(
      '#demo-input',
      'export function V({items}:{items:string[]}) @{\n  const x = items\n  <b/>;\n}',
    )
    await page.evaluate(() => {
      const input = document.getElementById('demo-input')
      const position = input.value.indexOf('items\n') + 5
      input.setSelectionRange(position, position)
      input.focus()
    })
    await page.keyboard.type('.fil', { delay: 60 })
    await page.waitForSelector('.demo-completions:not([hidden])', { timeout: 8000 })
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('.demo-completions li')].map((li) => li.dataset.name),
    )
    check(
      names.includes('filter') && names.includes('fill'),
      'intellisense: real TypeScript member completions from the type projection',
      names.join(','),
    )
    await page.keyboard.press('Enter')
    check(
      /items\.fil(l|ter)/.test(await page.inputValue('#demo-input')),
      'intellisense: accepting a TS completion replaces the typed prefix',
    )
  } else {
    check(true, 'intellisense: TS completions unavailable on this host (skipped)')
  }
}

// ---------- comparative benchmark + hover type info ----------
await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
const compLabels = await page.evaluate(() =>
  [...document.querySelectorAll('.home-bench .bench-row')].map((row) => row.dataset.label),
)
// Our own matched lane is now called "Oxlint + TSRX", which itself contains
// the substring "Oxlint". A substring test for the official competitor lane
// would therefore pass even if that lane were dropped from the chart, so both
// non-ESLint clauses match the exact label instead: 'Official Oxlint' can only
// be the upstream tool, and 'Oxlint + TSRX' can only be our matched all-TSX
// lane, never the longer mixed-file label.
check(
  compLabels.some((l) => l.includes('ESLint')) &&
    compLabels.some((l) => l === 'Official Oxlint') &&
    compLabels.some((l) => l === 'Oxlint + TSRX'),
  'comparative: home shows the matched ESLint, official Oxlint, and Oxlint + TSRX lanes',
  compLabels.filter((l) => /ESLint|Oxlint/.test(l)).join(' | '),
)
if (mode === 'native') {
  const quick = await page.evaluate(async () => {
    const source = 'export function V({items}:{items:string[]}) @{\n  const x = items\n  <b/>;\n}'
    const response = await fetch(document.querySelector('.top-nav a[href$="/playground"]').href.replace(/\/playground$/, '/api/quickinfo'), {
      method: 'POST',
      body: JSON.stringify({ source, offset: source.indexOf('items\n') + 3 }),
    })
    return response.json()
  })
  check(
    quick.info?.display?.includes('string[]'),
    'hover types: quickinfo returns the real TypeScript type',
    quick.info?.display ?? 'none',
  )
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  const hoverSource = 'export function V({items}:{items:string[]}) @{\n  const x = items\n  <b/>;\n}'
  await page.fill('#demo-input', hoverSource)
  await page.waitForTimeout(500)
  const hoverPoint = await page.evaluate(() => {
    const input = document.getElementById('demo-input')
    const style = getComputedStyle(input)
    const rect = input.getBoundingClientRect()
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    context.font = style.font
    const width = context.measureText('M').width
    const column = input.value.indexOf('items') + 2
    return {
      x: rect.left + Number.parseFloat(style.paddingLeft) + column * width,
      y: rect.top + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.lineHeight) / 2,
    }
  })
  await page.mouse.move(hoverPoint.x, hoverPoint.y)
  await page.waitForFunction(
    () => document.querySelector('.demo-tooltip:not([hidden])')?.textContent.includes('string[]'),
    { timeout: 8000 },
  )
  check(true, 'hover types: middle-of-identifier UI hover shows TypeScript quick info')
  await page.mouse.move(1, 1)
  await page.waitForTimeout(400)
  check(
    await page.locator('.demo-tooltip').isHidden(),
    'hover types: leaving the editor cancels an in-flight tooltip',
  )
}

// ---------- guided scenarios + completion menu layout ----------
if (liveDemo) {
  await page.goto(`${baseUrl}/playground`, { waitUntil: 'load' })
  await page.waitForSelector('#demo-input', { timeout: 10000 })
  await page.locator('#pg-scenario-lint').click()
  await page.waitForSelector('.demo-diag', { timeout: 8000 })
  check(true, 'scenarios: "Lint findings" loads a variant with real diagnostics')
  await page.locator('#pg-scenario-messy').click()
  await page.waitForFunction(
    () => document.getElementById('demo-input').value.includes('pending = tasks'),
    { timeout: 15000 },
  )
  check(true, 'scenarios: "Messy → Format" auto-normalizes via real oxfmt')
  await page.fill('#demo-input', '')
  await page.click('#demo-input')
  await page.keyboard.type('@fo')
  await page.waitForSelector('.demo-completions:not([hidden])')
  await page.keyboard.press('Escape')
  const menuFlex = await page.evaluate(() => {
    const item = document.createElement('li')
    document.querySelector('.demo-completions').appendChild(item)
    return getComputedStyle(item).display
  })
  check(menuFlex === 'flex', 'completions: menu rows separate name and kind', menuFlex)
}

// ---------- mobile ----------
const mobile = await context.newPage()
await mobile.setViewportSize({ width: 390, height: 844 })
await mobile.goto(`${baseUrl}/`, { waitUntil: 'load' })
const mobileHomeOverflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
)
check(!mobileHomeOverflow, 'mobile: home has no horizontal page overflow')
if (liveDemo) {
  await mobile.waitForSelector('#demo-input', { timeout: 10000 })
  const controlsFit = await mobile.evaluate(() => {
    const panel = document.getElementById('hero-demo')?.getBoundingClientRect()
    const controls = [...document.querySelectorAll('#demo-actions button')].map((button) =>
      button.getBoundingClientRect(),
    )
    return Boolean(
      panel &&
        controls.length > 0 &&
        controls.every(
          (control) => control.left >= panel.left && control.right <= panel.right,
        ),
    )
  })
  check(controlsFit, 'mobile: native demo controls stay inside the code panel')
}
await mobile.goto(`${baseUrl}/guide/introduction`, { waitUntil: 'load' })
const menuToggle = mobile.locator('#menu-toggle')
check(await menuToggle.isVisible(), 'mobile: hamburger visible at 390px')
await menuToggle.click()
check(
  (await menuToggle.getAttribute('aria-expanded')) === 'true' &&
    (await mobile.locator('.sidebar').isVisible()),
  'mobile: drawer opens with aria-expanded',
)
await mobile.locator('.sidebar a', { hasText: 'Linting' }).click()
await mobile.waitForURL('**/guide/linting')
check(true, 'mobile: drawer navigation works')
const horizontalOverflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
)
check(!horizontalOverflow, 'mobile: no horizontal page overflow')
await mobile.close()

// ---------- performance ----------
for (const target of ['/', '/guide/getting-started', '/architecture/rust-oxc-core']) {
  await page.goto(`${baseUrl}${target}`, { waitUntil: 'load' })
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const resources = performance.getEntriesByType('resource')
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      load: Math.round(nav.loadEventEnd - nav.startTime),
      bytes: Math.round(
        (nav.transferSize + resources.reduce((sum, r) => sum + r.transferSize, 0)) / 1024,
      ),
      requests: 1 + resources.length,
    }
  })
  check(
    metrics.load < 1500 && metrics.bytes < 250,
    `perf: ${target}`,
    `DCL ${metrics.domContentLoaded}ms, load ${metrics.load}ms, ${metrics.bytes} KiB over ${metrics.requests} requests`,
  )
}

// ---------- global hygiene ----------
check(consoleErrors.length === 0, 'hygiene: no console errors', consoleErrors.join('; '))
check(badResponses.length === 0, 'hygiene: no 4xx/5xx responses', badResponses.join('; '))
if (mode === 'wasm') {
  check(
    serverApiRequests.length === 0,
    'wasm: the entire session made no server API requests',
    serverApiRequests.slice(0, 3).join('; '),
  )
}

console.log(`\n${passes.length} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
