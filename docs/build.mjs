// Static docs site generator: markdown in docs/ -> HTML in docs/dist/.
// Plain JavaScript, no framework. Run with: node docs/build.mjs
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import { build as rolldownBuild } from 'rolldown'
import {
  benchmarkHeadings,
  benchmarksSectionsHtml,
  benchmarksSectionsMarkdown,
  comparativeChartHtml,
  editorReplayLatencies,
  homeBenchmarksHtml,
  latestReportDates,
} from './benchmarks-data.mjs'
import { getDocsHighlighter, highlightWith } from './highlight.mjs'
import config from './site.config.mjs'
import { heroCode, playgroundCode, typeAwareCode } from './demo-sources.mjs'

const docsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(docsDir, '..')
const defaultOutDir = path.join(docsDir, 'dist')
const outDir = process.env.OXC_TSRX_DOCS_OUT_DIR
  ? path.resolve(process.env.OXC_TSRX_DOCS_OUT_DIR)
  : defaultOutDir
const base = config.base ?? '/'
const trimmedBase = base.replace(/\/$/, '')
// Site pages live under the base path inside the deploy root, so the domain
// root stays free for the landing page and deploy-wide files (vercel.json,
// robots.txt).
const siteDir = trimmedBase
  ? path.join(outDir, ...trimmedBase.split('/').filter(Boolean))
  : outDir

const withBase = (href) => {
  if (!href.startsWith('/')) return href
  if (href === '/') return trimmedBase || '/'
  return trimmedBase + href
}

const escapeHtml = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const diagramCache = new Map()

// A diagram caption may quote a measured latency. The number is never typed
// into the diagram JSON: the source carries a {{token}} that resolves here
// from the aggregate-selected report, so a benchmark refresh cannot leave a
// stale figure behind in a diagram.
let diagramMetricsPromise = null
function diagramMetrics() {
  diagramMetricsPromise ??= editorReplayLatencies().then((latency) => ({
    editorInitialOpenMedian: editorReplayMs(latency.initialOpenMedianMs),
  }))
  return diagramMetricsPromise
}

function resolveDiagramMetrics(value, metrics, figureId) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([A-Za-z0-9]+)\}\}/g, (_marker, token) => {
      if (!(token in metrics)) {
        throw new Error(`Diagram ${figureId} references unknown metric ${token}`)
      }
      return metrics[token]
    })
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveDiagramMetrics(entry, metrics, figureId))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveDiagramMetrics(entry, metrics, figureId),
      ]),
    )
  }
  return value
}

function decorateDiagramSvg(svg, metadata, figureId) {
  const [, width, height] = svg.match(/viewBox="0 0 ([0-9]+) ([0-9]+)"/) ?? []
  if (!width || !height) throw new Error(`Diagram ${figureId} has no numeric viewBox`)
  let decorated = svg.replace(
    '<svg ',
    `<svg class="diagram-svg" width="${width}" height="${height}" role="group" aria-label="${escapeHtml(
      metadata.title,
    )}" `,
  )
  for (const [nodeId, caption] of Object.entries(metadata.nodes)) {
    const d2Class = Buffer.from(nodeId).toString('base64')
    const marker = `<g class="${d2Class}">`
    const replacement = `<g class="${d2Class} diagram-node" data-diagram-node="${escapeHtml(
      nodeId,
    )}" data-caption="${escapeHtml(caption)}" tabindex="0" role="button" aria-label="${escapeHtml(
      caption,
    )}" aria-pressed="false">`
    if (!decorated.includes(marker)) {
      throw new Error(`Diagram ${figureId} has no rendered node named ${nodeId}`)
    }
    decorated = decorated.replace(marker, replacement)
  }
  return decorated
}

async function diagramHtml(name) {
  if (diagramCache.has(name)) return diagramCache.get(name)
  const sourceDir = path.join(docsDir, 'diagrams')
  const assetDir = path.join(docsDir, 'assets', 'diagrams')
  const figureId = `diagram-${name}`
  const metadata = resolveDiagramMetrics(
    JSON.parse(await readFile(path.join(sourceDir, `${name}.json`), 'utf8')),
    await diagramMetrics(),
    figureId,
  )
  const svg = decorateDiagramSvg(
    await readFile(path.join(assetDir, `${name}.svg`), 'utf8'),
    metadata,
    figureId,
  )
  const steps = metadata.steps
    ? `<div class="diagram-steps pipeline-tabs" role="group" aria-label="${escapeHtml(
        `${metadata.title} steps`,
      )}">${metadata.steps
        .map(
          (step, index) =>
            `<button type="button" data-diagram-step data-nodes="${escapeHtml(
              JSON.stringify(step.nodes),
            )}"${step.caption ? ` data-caption="${escapeHtml(step.caption)}"` : ''} aria-pressed="false"><span class="pipeline-step">${index + 1}</span>${escapeHtml(
              step.label,
            )}</button>`,
        )
        .join('')}</div>`
    : ''
  const html = `<figure class="diagram" id="${figureId}" aria-labelledby="${figureId}-caption">
${steps}<div class="diagram-caption-strip" aria-live="polite">Select a diagram node to read its explanation.</div>
<div class="diagram-stage" data-diagram-stage>
  <div class="diagram-canvas" data-diagram-canvas>${svg}</div>
  <div class="diagram-tools" data-diagram-tools hidden>
    <button type="button" data-diagram-zoom="out" aria-label="Zoom out">&minus;</button>
    <button type="button" data-diagram-zoom="in" aria-label="Zoom in">+</button>
    <button type="button" data-diagram-fit>Fit</button>
  </div>
</div>
<figcaption id="${figureId}-caption"><strong>${escapeHtml(metadata.title)}.</strong> ${escapeHtml(
    metadata.caption,
  )}</figcaption>
</figure>`
  diagramCache.set(name, html)
  return html
}

function isSameOrAncestor(candidate, target) {
  const relative = path.relative(candidate, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveThroughExistingAncestor(candidate) {
  let existing = candidate
  for (;;) {
    try {
      const canonical = await realpath(existing)
      return path.resolve(canonical, path.relative(existing, candidate))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
}

async function validateOutputDirectory() {
  if (
    outDir === path.parse(outDir).root ||
    isSameOrAncestor(outDir, repoRoot) ||
    outDir === docsDir
  ) {
    throw new Error(`refusing destructive docs output directory: ${outDir}`)
  }
  let metadata = null
  try {
    metadata = await lstat(outDir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (metadata?.isSymbolicLink()) throw new Error(`refusing symlink docs output directory: ${outDir}`)
  if (outDir === defaultOutDir) return

  const tempRoot = path.resolve(tmpdir())
  const relative = path.relative(tempRoot, outDir)
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !path.basename(outDir).startsWith('oxc-tsrx-')
  ) {
    throw new Error(`custom docs output must be an oxc-tsrx-* directory under ${tempRoot}`)
  }
  const canonicalTempRoot = await realpath(tempRoot)
  const canonicalOutDir = await resolveThroughExistingAncestor(outDir)
  const expectedCanonicalOutDir = path.resolve(canonicalTempRoot, relative)
  const canonicalRelative = path.relative(canonicalTempRoot, canonicalOutDir)
  if (
    canonicalOutDir !== expectedCanonicalOutDir ||
    canonicalRelative.startsWith('..') ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(
      `custom docs output resolves outside the trusted temporary directory: ${outDir}`,
    )
  }
  if (metadata && !metadata.isDirectory()) throw new Error(`docs output is not a directory: ${outDir}`)
  if (metadata && (await readdir(outDir)).length > 0) {
    throw new Error(`refusing nonempty custom docs output directory: ${outDir}`)
  }
}

const namedEntities = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

// Headings are slugged from rendered inline HTML, so a heading that quotes a
// phrase arrives as `&quot;…&quot;`. Stripping punctuation without decoding first
// leaves the entity *name* in the id, which is how
// `What "a plain install" actually covers` became
// `what-quota-plain-installquot-actually-covers` and broke every link to it.
// Tags go first: decoding `&lt;` before that would manufacture one.
function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return namedEntities[name.toLowerCase()] ?? match
  })
}

function slugify(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function makeSlugger() {
  const seen = new Map()
  return (text) => {
    const slug = slugify(text) || 'section'
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    return count === 0 ? slug : `${slug}-${count}`
  }
}

function parseFrontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  if (!match) return { data: {}, body: source }
  const data = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) {
      data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
    }
  }
  return { data, body: source.slice(match[0].length) }
}

const highlighter = await getDocsHighlighter()
const highlightHtml = (code, lang) => highlightWith(highlighter, code, lang)

// Content hash of the shared chrome assets, appended as ?v= to their URLs so
// deployed pages never pair fresh HTML with a stale cached stylesheet.
// Every shipped script is folded in, not just app.js: the modules app.js and
// demo-panel.js pull in lazily (interactive.js, fuel.js, demo-wasm-backend.js,
// the minisearch bundle) inherit this same stamp through import.meta.url, so a
// hash over app.js alone left an edit to any of them serving from cache
// forever. Paths are sorted and hashed alongside their contents, so a rename
// rotates the stamp too.
const assetsDir = path.join(docsDir, 'assets')
const styleSource = await readFile(path.join(assetsDir, 'style.css'), 'utf8')
const scriptAssets = (await readdir(assetsDir, { recursive: true }))
  .filter((entry) => entry.endsWith('.js') || entry.endsWith('.mjs'))
  .map((entry) => entry.split(path.sep).join('/'))
  .sort()
const assetVersionHash = createHash('sha256').update(styleSource)
for (const entry of scriptAssets) {
  assetVersionHash.update(entry).update(await readFile(path.join(assetsDir, entry)))
}
// The rolldown bundles (demo-highlighter.js, demo-wasm/engine.js, the wasi
// worker) are written straight into the site output, so their bytes cannot be
// hashed here — hash their entry modules instead, so editing one still
// rotates the stamp.
for (const entry of [
  'demo-highlighter-entry.mjs',
  'demo-wasm-engine-entry.mjs',
  'demo-wasm-worker-entry.mjs',
]) {
  const entryPath = path.join(docsDir, entry)
  if (existsSync(entryPath)) {
    assetVersionHash.update(entry).update(await readFile(entryPath))
  }
}
const assetVersion = assetVersionHash.digest('hex').slice(0, 10)

// The three page shells this site renders. Each one gets its own stylesheet.
const CSS_SHELLS = ['doc', 'home', 'playground']

// Whether this build ships the in-browser engine (see the bundling step at the
// end of build()). Known here, before any page is rendered, because the
// playground's markup differs: a build that can run the demo ships its controls
// visible and pending, and one that cannot keeps them hidden.
const wasmBinary = process.env.OXC_TSRX_WASM_BINARY
  ? path.resolve(process.env.OXC_TSRX_WASM_BINARY)
  : path.join(docsDir, 'tools', 'demo-wasm', 'dist', 'demo-wasm.wasm')
const wasmDemo = existsSync(wasmBinary)

// docs/assets/style.css is authored as one file but most of it can only ever
// match one shell, so shipping all of it to every page made the home page carry
// the sidebar, the article typography and every doc component it never renders.
// Regions marked `#css-pages:` are kept only for the shells they name (see the
// header comment in the stylesheet); everything else is shared chrome. Lines
// keep their authored order in every bundle, so a shell's cascade is exactly the
// cascade of the source file with the other shells' rules deleted.
function splitStylesheet(source) {
  const bundles = new Map(CSS_SHELLS.map((shell) => [shell, []]))
  let shells = null
  let openedAt = 0
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    const opening = /^[ \t]*\/\* #css-pages:([a-z ]+)\*\/[ \t]*$/.exec(line)
    if (opening) {
      if (shells) {
        throw new Error(
          `style.css:${index + 1}: #css-pages region opened inside the one opened on line ${openedAt}`,
        )
      }
      shells = opening[1].trim().split(/\s+/)
      openedAt = index + 1
      const unknown = shells.filter((shell) => shell !== 'none' && !CSS_SHELLS.includes(shell))
      if (unknown.length > 0) {
        throw new Error(
          `style.css:${index + 1}: unknown page shell ${unknown.join(', ')} (expected ${CSS_SHELLS.join(', ')} or none)`,
        )
      }
      continue
    }
    if (/^[ \t]*\/\* #css-pages-end \*\/[ \t]*$/.test(line)) {
      if (!shells) throw new Error(`style.css:${index + 1}: #css-pages-end closes nothing`)
      shells = null
      continue
    }
    for (const shell of CSS_SHELLS) {
      if (!shells || shells.includes(shell)) bundles.get(shell).push(line)
    }
  }
  if (shells) throw new Error(`style.css:${openedAt}: #css-pages region is never closed`)
  return bundles
}

const styleBundles = splitStylesheet(styleSource)

// Read the pinned OXC revision from the adapter crate so the footer badge can
// never disagree with the code.
const adapterSource = await readFile(
  path.join(docsDir, '..', 'crates', 'oxc_adapter', 'src', 'lib.rs'),
  'utf8',
)
const oxcRevision = /OXC_REVISION: &str = "([0-9a-f]{40})"/.exec(adapterSource)?.[1] ?? 'unknown'
const reportDate = (await latestReportDates()).toISOString().slice(0, 10)
const footerBadge = `<p class="footer-badge">Pinned OXC <code>${oxcRevision.slice(0, 12)}</code> · benchmark report ${reportDate} · ${config.footer.copyright}</p>`

// Editor-style hover docs for TSRX constructs in code examples, mirroring the
// quick-info experience of the Markless VS Code extension.
const TSRX_DOCS = {
  '@{': [
    'Statement container',
    'A statement container that allows you to have statements and markup colocated.',
  ],
  '@if': ['Conditional', 'Renders when the condition is truthy.'],
  '@else': ['Fallback', 'Runs when @if fails; chain with @else if.'],
  '@for': ['Loop', 'Renders once per item. Supports index i and key expr.'],
  '@empty': ['Loop fallback', 'Renders when the loop has nothing to show.'],
  '@switch': ['Match', 'Picks the @case that matches a value.'],
  '@case': ['Branch', 'Written as @case value: { … }.'],
  '@default': ['Fallback', 'Renders when no @case matches.'],
  '@try': ['Async boundary', 'Awaited content, with loading and error branches.'],
  '@pending': ['Loading', 'Shown while @try content loads.'],
  '@catch': ['Error', 'Handles @try failures; (error, reset) supported.'],
}

function addTsrxHovers(html) {
  // Chained form first. The grammar scopes the trailing `if` as part of the
  // directive, so shiki emits two adjacent spans with identical styling; fuse
  // them so the hover target is the whole `@else if` rather than half of it.
  html = html.replace(
    /(<span style="([^"]*)">)([ \t]*)@else<\/span><span style="\2">([ \t]*if\b)/g,
    (match, open, style, whitespace, ifWord) =>
      `${open}${whitespace}<span class="tsrx-hover" tabindex="0" role="img" aria-label="@else if: Chained conditional. Tests another condition when the previous branch failed." data-doc-title="@else if · Chained conditional" data-doc="Tests another condition when the previous branch failed.">@else${ifWord}</span>`,
  )
  return html.replace(
    /(<span(?! class="tsrx-hover")[^>]*>)([ \t]*)(@(?:\{|if|else|for|empty|switch|case|default|try|pending|catch))(<\/span>)/g,
    (match, open, whitespace, token, close) => {
      const doc = TSRX_DOCS[token]
      if (!doc) return match
      return `${open}${whitespace}<span class="tsrx-hover" tabindex="0" role="img" aria-label="${escapeHtml(
        `${token}: ${doc[0]}. ${doc[1]}`,
      )}" data-doc-title="${escapeHtml(`${token} · ${doc[0]}`)}" data-doc="${escapeHtml(doc[1])}">${token}</span>${close}`
    },
  )
}

// Site-wide hover glossary: first prose occurrence of each technical term on
// a page gets an editor-style tooltip, so jargon is explained where it sits.
const GLOSSARY = {
  p95: ['p95', '95 of 100 runs were at least this fast. A worst-realistic-case number, not an average.'],
  throughput: ['throughput', 'How much source code is processed per second. Higher is better.'],
  'MiB/s': ['MiB/s', 'Mebibytes of source code processed per second.'],
  projection: ['projection', 'The temporary in-memory TSX copy of your TSRX file that OXC actually reads.'],
  lift: ['lift', 'Converting the formatted TSX copy back into your TSRX syntax.'],
  'fail-closed': ['fail-closed', 'Unsupported input produces a clear error instead of a silently wrong result.'],
}

function addGlossary(article) {
  const seen = new Set()
  const wrapText = (text) => {
    let out = text
    for (const [term, [title, doc]] of Object.entries(GLOSSARY)) {
      if (seen.has(term)) continue
      const pattern = new RegExp(`(^|[\\s(])(${term.replace('/', '\\/').replace('-', '\\-')})(?=[\\s.,;:)]|$)`)
      if (!pattern.test(out)) continue
      seen.add(term)
      out = out.replace(
        pattern,
        (m, pre, word) =>
          `${pre}<span class="tsrx-hover" tabindex="0" role="img" aria-label="${escapeHtml(`${title}: ${doc}`)}" data-doc-title="${escapeHtml(title)}" data-doc="${escapeHtml(doc)}">${word}</span>`,
      )
    }
    return out
  }
  return article.replace(/(<(?:p|li)>)([\s\S]*?)(<\/(?:p|li)>)/g, (match, open, body, close) => {
    const parts = body.split(/(<[^>]+>)/)
    for (let i = 0; i < parts.length; i += 2) parts[i] = wrapText(parts[i])
    return open + parts.join('') + close
  })
}

function createMarked(slugger, headings) {
  const marked = new Marked()
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens)
        const id = slugger(html)
        // Plain text, not inline HTML: the outline and the permalink label both
        // escape what they are given, so an undecoded `&quot;` would be escaped
        // a second time and read as `&quot;` on the page.
        const text = decodeEntities(html.replace(/<[^>]*>/g, ''))
        headings.push({ depth, id, text })
        const anchor =
          depth > 1
            ? `<a class="header-anchor" href="#${id}" aria-label="Permalink to “${escapeHtml(
                text,
              )}”">#</a>`
            : ''
        return `<h${depth} id="${id}">${html}${anchor}</h${depth}>\n`
      },
      code({ text, lang }) {
        const [language, ...flags] = (lang || 'text').split(/\s+/)
        // The button hands the fence to the real engines, so it is only honest
        // on a fence the engines accept. A sample that is deliberately not a
        // whole file, or is showing what invalid TSRX looks like, opts out with
        // ```tsrx no-playground; tests/site/playground-snippets.test.mjs proves
        // every fence that keeps the button still parses.
        const tryButton =
          language === 'tsrx' && !flags.includes('no-playground')
            ? `<button type="button" class="try-button" data-code="${escapeHtml(text)}">Try in playground</button>`
            : ''
        let body = highlightHtml(text, language)
        if (language === 'tsrx') body = addTsrxHovers(body)
        return `<div class="code-block" data-lang="${escapeHtml(language)}">${body}${tryButton}</div>\n`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        if (/^https?:\/\//.test(href)) {
          // `[Deno](https://deno.com "brand:deno")` renders the project's own
          // mark next to its name. The title is the only inline signal Markdown
          // gives an author, and an unknown brand degrades to a plain link.
          const brand = /^brand:([a-z][a-z-]*)$/.exec(title ?? '')?.[1]
          const mark = brand ? brandIconHtml(brand) : ''
          return `<a${mark ? ' class="brand-link"' : ''} href="${href}" target="_blank" rel="noreferrer">${mark}${text}<span class="visually-hidden"> (opens in new tab)</span></a>`
        }
        // A source link may name the file (`./rust-oxc-core.md#…`) the way it
        // reads in an editor. The site serves routes, not files, so drop the
        // extension rather than shipping a link that lands on nothing.
        return `<a href="${withBase(href.replace(/\.md(?=$|#)/, ''))}">${text}</a>`
      },
    },
  })
  return marked
}

// Collect page text per heading section for the client-side search index.
function extractSections(marked, body, page) {
  const slugger = makeSlugger()
  const sections = []
  let current = { title: page.title, anchor: '', parts: [] }
  const flush = () => {
    const text = current.parts.join(' ').replace(/\s+/g, ' ').trim()
    if (text || current.anchor) sections.push({ ...current, text })
  }
  const plain = (raw) =>
    raw
      .replace(/```[^\n]*\n?/g, ' ')
      .replace(/[`*_#>|]/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
  for (const token of marked.lexer(body)) {
    if (token.type === 'heading' && token.depth <= 3) {
      const id = slugger(token.text)
      if (token.depth === 1) {
        current.title = token.text
        continue
      }
      flush()
      current = { title: token.text, anchor: id, parts: [] }
    } else if (token.raw) {
      current.parts.push(plain(token.raw))
    }
  }
  flush()
  return sections.map((section, index) => ({
    id: `${page.link}#${index}`,
    page: page.title,
    group: page.group,
    title: section.title,
    href: withBase(page.link) + (section.anchor ? `#${section.anchor}` : ''),
    text: section.text.slice(0, 1200),
  }))
}

const githubIcon =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a11 11 0 0 1 2.88-.39c.98 0 1.96.13 2.88.39 2.19-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14 0 1.54-.02 2.79-.02 3.17 0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>'
const navHtml = config.nav
  .map((item) =>
    item.link.startsWith('https://github.com')
      ? `<li><a class="nav-github" href="${item.link}" aria-label="${item.text} repository" title="${item.text}">${githubIcon}</a></li>`
      : `<li><a href="${withBase(item.link)}">${item.text}</a></li>`,
  )
  .join('')

function sidebarHtml(activeLink) {
  return config.sidebar
    .map(
      (group) => `
      <section class="sidebar-group">
        <h2 class="sidebar-group-title">${group.text}</h2>
        <ul>
          ${group.items
            .map(
              (item) =>
                `<li><a href="${withBase(item.link)}"${
                  item.link === activeLink ? ' aria-current="page"' : ''
                }>${item.text}${
                  item.tag ? `<span class="sidebar-tag">${escapeHtml(item.tag)}</span>` : ''
                }</a></li>`,
            )
            .join('\n')}
        </ul>
      </section>`,
    )
    .join('\n')
}

// Reading minutes per outline section, measured from the rendered article so
// that generated blocks (diagrams, demos, tables) count the same as prose.
// 200 words a minute is the low end of adult silent reading, which suits
// reference pages people read carefully rather than skim.
const WORDS_PER_MINUTE = 200

function annotateReadingTime(articleHtml, headings) {
  const marks = [...articleHtml.matchAll(/<h([23]) id="([^"]+)"/g)]
  const words = (html) =>
    html
      // Chart tick labels are not reading. A page of build-time SVG charts
      // counts thousands of axis numbers otherwise, and tells a reader it is a
      // twenty-minute page when the prose is three.
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .split(/\s+/)
      .filter(Boolean).length
  const counted = new Map()
  for (const [index, mark] of marks.entries()) {
    const start = mark.index
    const end = index + 1 < marks.length ? marks[index + 1].index : articleHtml.length
    counted.set(mark[2], words(articleHtml.slice(start, end)))
  }
  // Everything above the first section belongs to the page, not to a heading,
  // so it lands on the total without giving the first item a misleading badge.
  const lead = marks.length > 0 ? words(articleHtml.slice(0, marks[0].index)) : words(articleHtml)
  for (const heading of headings) heading.words = counted.get(heading.id) ?? 0
  return lead
}

function readingMinutes(words) {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
}

function outlineHtml(headings, leadWords = 0) {
  const items = headings.filter((h) => h.depth === 2 || h.depth === 3)
  if (items.length === 0) return ''
  const total = readingMinutes(
    leadWords + items.reduce((sum, h) => sum + (h.words ?? 0), 0),
  )
  // Without JS the bar sits at zero and the readout names the whole page, which
  // is exactly true for a reader who has not scrolled.
  return `
    <nav class="outline" aria-labelledby="outline-title">
      <p class="outline-title" id="outline-title">On this page</p>
      <div class="outline-progress" data-total-minutes="${total}">
        <div class="outline-progress-track" aria-hidden="true"><div class="outline-progress-fill"></div></div>
        <p class="outline-remaining" aria-live="polite">${total} min read</p>
      </div>
      <ul>
        ${items
          .map(
            (h) =>
              `<li class="outline-depth-${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`,
          )
          .join('\n')}
      </ul>
    </nav>`
}

function prevNextHtml(pageIndex, flat) {
  if (pageIndex < 0) return ''
  const prev = flat[pageIndex - 1]
  const next = flat[pageIndex + 1]
  if (!prev && !next) return ''
  const cell = (item, kind, label) =>
    item
      ? `<div class="pager-link ${kind}"><a href="${withBase(item.link)}"><span class="pager-label">${label}</span><span class="pager-title">${item.text}</span></a></div>`
      : '<div></div>'
  return `<nav class="pager" aria-label="Previous and next page">
    ${cell(prev, 'prev', 'Previous page')}
    ${cell(next, 'next', 'Next page')}
  </nav>`
}

const themeInit = `(() => {
  try {
    const stored = localStorage.getItem('oxc-tsrx-theme')
    const dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.classList.toggle('dark', dark)
  } catch {}
})()`

// The playground's example buttons are in the HTML from the first byte, but the
// module that gives them behaviour is several hundred kilobytes and a couple of
// round trips away. On a phone that gap was six seconds long, and a tap inside
// it hit nothing and left no trace, which is what "sometimes didn't work at all"
// was. This runs during head parsing, before any module, and does two things: it
// records the tap so the module can replay it, and it says so on screen. It is
// delegated from document, so it also covers a playground arrived at through a
// client-side navigation, where the page's own inline scripts never re-run.
// It disarms itself the moment demo-panel.js marks the bar ready.
const playgroundTapQueue = `(() => {
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('button[id^="pg-scenario-"]')
    if (!button) return
    const bar = document.getElementById('pg-side')
    if (!bar || bar.dataset.engine !== 'starting' || !bar.contains(button)) return
    event.preventDefault()
    event.stopPropagation()
    window.__pgQueuedScenario = button.id
    for (const other of bar.querySelectorAll('button[id^="pg-scenario-"]')) {
      other.removeAttribute('data-queued')
    }
    button.dataset.queued = '1'
    const note = document.getElementById('pg-scenario-note')
    if (note) {
      note.textContent =
        'Queued: ' + button.textContent.trim() + '. It runs as soon as the engine has started.'
    }
  }, true)
})()`

const favicon = withBase('/assets/logo.svg')
const socialImage = `${config.origin}${withBase('/assets/social-card.png')}`

function canonicalUrl(pathname) {
  if (pathname === '/') return `${config.origin}${trimmedBase || '/'}`
  return `${config.origin}${withBase(pathname)}`
}

const searchDialog = `
<dialog id="search-dialog" class="search-dialog" aria-label="Search documentation">
  <div class="search-panel">
    <form class="search-form" role="search" onsubmit="return false">
      <label class="visually-hidden" for="search-input">Search documentation</label>
      <input id="search-input" type="search" role="combobox" aria-expanded="false"
        aria-controls="search-results" aria-autocomplete="list" autocomplete="off"
        placeholder="Search docs" />
      <button type="button" class="search-close" id="search-close">Esc</button>
    </form>
    <ul id="search-results" class="search-results" role="listbox" aria-label="Search results"></ul>
    <p id="search-status" class="search-status" role="status"></p>
  </div>
</dialog>`

function headerHtml() {
  return `
<header class="navbar">
  <div class="navbar-inner">
    <button id="menu-toggle" class="menu-toggle" aria-label="Navigation menu" aria-expanded="false" aria-controls="sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>
    <a class="site-title" href="${withBase('/')}"><img class="site-logo" src="${withBase('/assets/logo.svg')}" alt="" width="26" height="26" />${config.title}</a>
    <div class="navbar-spacer"></div>
    <button id="search-button" class="search-button" aria-label="Search documentation">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <span class="search-button-text">Search</span>
      <kbd class="search-key" aria-hidden="true">⌘K</kbd>
    </button>
    <nav class="top-nav" aria-label="Main navigation"><ul>${navHtml}</ul></nav>
    <button id="theme-toggle" class="theme-toggle" aria-label="Toggle dark theme" aria-pressed="false">
      <svg class="icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg class="icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>
    </button>
  </div>
</header>`
}

function pageShell({ title, description, pathname, shell, bodyClass, header, main }) {
  if (!CSS_SHELLS.includes(shell)) {
    throw new Error(`pageShell: unknown shell ${shell} for ${pathname}`)
  }
  const fullTitle = title === config.title ? title : `${title} | ${config.title}`
  const summary = description || config.description
  const canonical = canonicalUrl(pathname)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(summary)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${escapeHtml(config.title)}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:title" content="${escapeHtml(fullTitle)}" />
<meta property="og:description" content="${escapeHtml(summary)}" />
<meta property="og:image" content="${socialImage}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="OXC for TSRX" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(fullTitle)}" />
<meta name="twitter:description" content="${escapeHtml(summary)}" />
<meta name="twitter:image" content="${socialImage}" />
<meta name="twitter:image:alt" content="OXC for TSRX" />
<meta name="color-scheme" content="light dark" />
<link rel="icon" href="${favicon}" />
<link rel="preload" href="${withBase('/assets/fonts/space-grotesk-latin.woff2')}" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="${withBase('/assets/fonts/inter-latin.woff2')}" as="font" type="font/woff2" crossorigin />
<script>${themeInit}</script>
${wasmDemo ? `<script>${playgroundTapQueue}</script>\n` : ''}<link rel="stylesheet" href="${withBase(`/assets/style-${shell}.css`)}?v=${assetVersion}" />
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main-content">Skip to content</a>
${header}
${main}
${searchDialog}
<div id="route-announcer" class="visually-hidden" aria-live="polite"></div>
<script type="module" src="${withBase('/assets/app.js')}?v=${assetVersion}"></script>
</body>
</html>
`
}

// Static projection explorer: authored TSRX, the projected TSX OXC actually
// sees, and the diagnostics mapped back. Data is precomputed by
// docs/generate-projection.mjs from the real tsrx_syntax crate and lint CLI.
async function projectionExplorerHtml() {
  let example
  try {
    example = JSON.parse(await readFile(path.join(docsDir, 'projection-example.json'), 'utf8'))
  } catch {
    return '<p><em>Projection example data is not generated yet. Run <code>node docs/generate-projection.mjs</code>.</em></p>'
  }
  const diagnosticsList = example.diagnostics
    .map(
      (diagnostic) =>
        `<li><code>${escapeHtml(diagnostic.code)}</code> (${escapeHtml(diagnostic.severity)}): ${escapeHtml(
          diagnostic.message,
        )} <span class="explorer-span">at authored bytes ${diagnostic.labels[0].span.offset}–${
          diagnostic.labels[0].span.offset + diagnostic.labels[0].span.length
        }</span></li>`,
    )
    .join('\n')
  const tabs = [
    { id: 'authored', label: '1 · Your TSRX', body: addTsrxHovers(highlightHtml(example.tsrx, 'tsrx')) },
    { id: 'projected', label: '2 · Projected TSX (what OXC sees)', body: highlightHtml(example.projected, 'tsx') },
    {
      id: 'mapped',
      label: '3 · Diagnostics mapped back',
      body: `<div class="explorer-diagnostics"><p>Real <code>oxc-tsrx</code> output for this file. Every position points at the authored TSRX on tab 1, never at the scaffolding on tab 2:</p><ul>${diagnosticsList}</ul></div>`,
    },
  ]
  return `<div class="explorer" data-explorer>
  <div class="explorer-tabs" role="tablist" aria-label="Projection stages">
    ${tabs
      .map(
        (tab, index) =>
          `<button type="button" role="tab" id="explorer-tab-${tab.id}" aria-controls="explorer-panel-${tab.id}" aria-selected="${index === 0}" ${index === 0 ? '' : 'tabindex="-1"'}>${tab.label}</button>`,
      )
      .join('\n')}
  </div>
  ${tabs
    .map(
      (tab, index) =>
        `<div class="explorer-panel" role="tabpanel" id="explorer-panel-${tab.id}" aria-labelledby="explorer-tab-${tab.id}" ${index === 0 ? '' : 'hidden'}>${tab.body}</div>`,
    )
    .join('\n')}
</div>`
}

function transcriptOutputHtml(output) {
  const lines = output.split('\n')
  return lines
    .map((line, index) => {
      if (index === lines.length - 1 && line === '') return ''
      const severity = /:\d+:\d+: warning\b/.test(line)
        ? ' gs-terminal-line-warning'
        : /:\d+:\d+: error\b/.test(line)
          ? ' gs-terminal-line-error'
          : ''
      return `<span class="gs-terminal-line gs-terminal-output${severity}">${escapeHtml(line)}</span>${index < lines.length - 1 ? '\n' : ''}`
    })
    .join('')
}

const terminalDemoDefaultCaption =
  'This output was captured from the real native binaries at build time, so it matches what they actually returned.'

function terminalDemoMarkdown(example, generator = 'docs/generate-projection.mjs') {
  if (!example?.transcript?.length) {
    return `_Run \`node ${generator}\` to generate the terminal walkthrough._`
  }
  const transcript = example.transcript
    .flatMap((entry) => [
      ...(entry.comment ? [`# ${entry.comment}`] : []),
      `$ ${entry.command}`,
      entry.output.trimEnd(),
      '',
    ])
    .join('\n')
    .trimEnd()
  return [
    example.caption ?? terminalDemoDefaultCaption,
    '',
    '```text',
    transcript,
    '```',
  ].join('\n')
}

function terminalDemoHtml(example, generator = 'docs/generate-projection.mjs') {
  if (!example?.transcript?.length) {
    return `<p><em>Run <code>node ${generator}</code> to generate the terminal walkthrough.</em></p>`
  }
  // One block per command, separated by a blank line so the sequence of
  // steps stays visually distinct.
  const transcript = example.transcript
    .map((entry) => {
      const parts = []
      if (entry.comment) {
        parts.push(
          `<span class="gs-terminal-line gs-terminal-comment"># ${escapeHtml(entry.comment)}</span>`,
        )
      }
      parts.push(
        `<span class="gs-terminal-line gs-terminal-command">${escapeHtml(entry.command)}</span>`,
      )
      const output = transcriptOutputHtml(entry.output)
      if (output) parts.push(output)
      return parts.join('\n')
    })
    .join('\n\n')
  // Unique per page so multiple walkthrough regions satisfy landmark-unique.
  const regionLabel = `Recorded output of ${example.transcript[0].command.split('\n')[0]}`
  return `<figure class="gs-terminal" data-terminal-demo>
  <div class="gs-terminal-titlebar">
    <span class="gs-terminal-title">See it run</span>
    <button type="button" data-terminal-play aria-label="Play terminal walkthrough">Play</button>
  </div>
  <pre class="gs-terminal-transcript" role="region" aria-label="${escapeHtml(regionLabel)}" tabindex="0">${transcript}</pre>
  <figcaption>${escapeHtml(example.caption ?? terminalDemoDefaultCaption)}</figcaption>
</figure>`
}

// ---------- transplant matrix filter (Upstreaming to OXC) ----------
// <!-- matrix-filter --> before a table adds classification badges to each
// row and a chip bar that app.js turns into live row filtering. Without JS
// the badges still render and every row stays visible.
const MATRIX_CLASSIFICATIONS = [
  { slug: 'reuse', chip: 'Direct reuse', match: 'Direct reuse' },
  { slug: 'adapt', chip: 'Adapt or replace', match: 'Adapt or replace' },
  { slug: 'glue', chip: 'Product glue', match: 'Standalone product glue' },
  { slug: 'redesign', chip: 'Upstream-only redesign', match: 'Upstream-only redesign' },
]

function matrixFilterHtml(article) {
  const marker = '<!-- matrix-filter -->'
  const markerIndex = article.indexOf(marker)
  const start = article.indexOf('<div class="table-wrap">', markerIndex)
  const end = article.indexOf('</table></div>', start)
  if (markerIndex === -1 || start === -1 || end === -1) {
    throw new Error('matrix-filter marker found without a following table')
  }
  const counts = new Map(MATRIX_CLASSIFICATIONS.map((entry) => [entry.slug, 0]))
  const table = article
    .slice(start, end)
    .replace(/<tr>([\s\S]*?)<\/tr>/g, (row, cells) => {
      const entry = MATRIX_CLASSIFICATIONS.find((candidate) =>
        cells.includes(`<strong>${candidate.match}</strong>`),
      )
      if (!entry) return row
      counts.set(entry.slug, counts.get(entry.slug) + 1)
      return `<tr data-classification="${entry.slug}">${cells.replace(
        `<strong>${entry.match}</strong>`,
        `<span class="matrix-badge matrix-badge-${entry.slug}">${entry.match}</span>`,
      )}</tr>`
    })
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  const chips = [
    `<button type="button" data-matrix-chip="all" aria-pressed="true">All <span class="matrix-count">${total}</span></button>`,
    ...MATRIX_CLASSIFICATIONS.map(
      (entry) =>
        `<button type="button" data-matrix-chip="${entry.slug}" aria-pressed="false"><span class="matrix-badge matrix-badge-${entry.slug}" aria-hidden="true"></span>${entry.chip} <span class="matrix-count">${counts.get(entry.slug)}</span></button>`,
    ),
  ].join('\n    ')
  const replacement = `<div class="matrix-filter" data-matrix-filter>
  <div class="matrix-chips" role="group" aria-label="Filter the transplant matrix by classification">
    ${chips}
  </div>
  <p class="matrix-status" aria-live="polite" data-matrix-status></p>
  ${table}</table></div>
</div>`
  return article.slice(0, markerIndex) + article.slice(markerIndex + marker.length, start) + replacement + article.slice(end + '</table></div>'.length)
}

// ---------- disclosure (the detail a reader wants once, not on the way past) ----------
// `<!-- details:Summary -->` ... `<!-- /details -->` folds everything between
// the two behind a summary line. It is for the paragraph that is true, worth
// keeping, and not needed to take the next step: why a flag exists, what a
// warning means, what was measured. A `<details>` element rather than a
// scripted panel, so it still opens with JavaScript off and prints expanded.
const DISCLOSURE_PATTERN = /<!-- details:([\s\S]*?) -->([\s\S]*?)<!-- \/details -->/g

function disclosureHtml(article) {
  return article.replace(
    DISCLOSURE_PATTERN,
    (_match, summary, body) =>
      `<details class="disclosure"><summary>${escapeHtml(summary.trim())}</summary>\n${body.trim()}\n</details>\n`,
  )
}

// The Markdown twin keeps the words: an export has no disclosure to open, so a
// reader (or a model) reading the export gets the heading and the body inline.
function disclosureMarkdown(body) {
  return body.replace(
    DISCLOSURE_PATTERN,
    (_match, summary, inner) => `**${summary.trim()}**\n${inner.trim()}\n`,
  )
}

// ---------- file tree (what a download actually unpacks) ----------
// `<!-- filetree:<dir> -->` reads that directory out of the repository and
// prints one row per file, each opening to the exact bytes it will write. It is
// for a step that tells a reader to pipe a download into `tar`: the answer to
// "what am I about to run" should be on the page, not one clone away. Reading
// the files at build time is what keeps it true, since the same directory is
// what CI runs. Every file needs a note here, so an example that grows a file
// fails the build rather than shipping an incomplete list.
const FILETREE_NOTES = {
  'examples/custom-js-plugins/vite-plus': {
    '.oxlintrc.json': { note: 'turns the rule on. This is the file your editor reads' },
    'house-rules.mjs': { note: 'the rule itself, an ordinary Oxlint JavaScript plugin' },
    'vite.config.ts': { note: 'what `vp lint` reads', replaces: true },
    'src/Greeting.tsrx': { note: 'the `.tsrx` component' },
    'src/Panel.tsx': { note: 'an ordinary `.tsx` component, so you see both flagged' },
  },
}

const FILETREE_LANGS = {
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.mjs': 'js',
  '.js': 'js',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.tsrx': 'tsrx',
  '.css': 'css',
}

// Notes are prose with the odd `identifier` in them, and nothing else.
function inlineCode(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>')
}

async function filetreeEntries(root, prefix = '') {
  const dirents = await readdir(path.join(root, prefix), { withFileTypes: true })
  const byName = (a, b) => a.name.localeCompare(b.name)
  const rel = (name) => (prefix ? `${prefix}/${name}` : name)
  const files = dirents
    .filter((entry) => entry.isFile())
    .map((entry) => ({ kind: 'file', name: entry.name, rel: rel(entry.name) }))
    .sort(byName)
  // Directories last: the files a reader lands in are the ones they see first.
  const dirs = await Promise.all(
    dirents
      .filter((entry) => entry.isDirectory())
      .sort(byName)
      .map(async (entry) => ({
        kind: 'dir',
        name: entry.name,
        children: await filetreeEntries(root, rel(entry.name)),
      })),
  )
  return [...files, ...dirs]
}

async function filetreeRows(entries, root, notes, dir) {
  const rows = []
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      rows.push(
        `<li class="filetree-entry filetree-dir"><span class="filetree-name">${escapeHtml(entry.name)}/</span>
<ul class="filetree-level">
${await filetreeRows(entry.children, root, notes, dir)}
</ul></li>`,
      )
      continue
    }
    const meta = notes[entry.rel]
    if (!meta) throw new Error(`filetree ${dir}: ${entry.rel} has no note in FILETREE_NOTES`)
    const source = await readFile(path.join(root, entry.rel), 'utf8')
    const lines = source.replace(/\n$/, '').split('\n').length
    const lang = FILETREE_LANGS[path.extname(entry.name)] ?? 'text'
    // A badge in the row does not earn the space it takes, so the one fact a
    // reader has to know before unpacking, that this file lands on top of one
    // the scaffold wrote, rides along in the note. Same words as the Markdown
    // twin, which is why both build it from `meta.replaces`.
    rows.push(
      `<li class="filetree-entry"><details class="filetree-file">
<summary><span class="filetree-name">${escapeHtml(entry.name)}</span><span class="filetree-note">${inlineCode(
        `${meta.note}${meta.replaces ? ", replacing the scaffold's" : ''}`,
      )}</span><span class="filetree-meta"><span class="filetree-lines">${lines} lines</span></span></summary>
<div class="code-block" data-lang="${lang}">${highlightHtml(source.replace(/\n$/, ''), lang)}</div>
</details></li>`,
    )
  }
  return rows.join('\n')
}

async function filetreeHtml(dir) {
  const notes = FILETREE_NOTES[dir]
  if (!notes) throw new Error(`filetree marker for a directory with no notes: ${dir}`)
  const root = path.join(repoRoot, dir)
  const entries = await filetreeEntries(root)
  const rows = await filetreeRows(entries, root, notes, dir)
  const count = Object.keys(notes).length
  return `<div class="filetree" data-filetree>
<p class="filetree-lead">${count} files. Open any of them to read what lands on disk, before you run anything.</p>
<ul class="filetree-level">
${rows}
</ul>
</div>`
}

// The Markdown twin has nothing to open, so it keeps the paths and the notes as
// a plain list and leaves the contents where they live.
function filetreeMarkdown(dir) {
  const notes = FILETREE_NOTES[dir]
  return Object.entries(notes)
    .map(
      ([file, meta]) =>
        `- \`${file}\`: ${meta.note}${meta.replaces ? ", replacing the scaffold's" : ''}`,
    )
    .join('\n')
}

// ---------- setup report (the states `oxc-tsrx setup` prints) ----------
// <!-- setup-report --> before a text fence gives each state the colour the CLI
// gives it at a terminal: green for a slot this package took over, dim for one
// that needed nothing, yellow for one asking the reader to look at something.
// The words stay the CLI's, so the fence is still the source of truth.
const SETUP_STATE_TONE = {
  active: 'taken',
  written: 'taken',
  unnecessary: 'quiet',
  removed: 'quiet',
  missing: 'attention',
  collision: 'attention',
  unreadable: 'attention',
  stale: 'attention',
  preview: 'attention',
}

const SETUP_REPORT_PATTERN = /<!-- setup-report -->\r?\n```text\r?\n([\s\S]*?)\r?\n```/g

function setupReportHtml(text) {
  const rows = text
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^-?\s*([^\s:]+):\s+([a-z]+)(?:\s+\(([a-z]+)\))?\s*$/.exec(line)
      if (!match) throw new Error(`setup-report line is not "name: state": ${line}`)
      const [, name, state, scope] = match
      const tone = SETUP_STATE_TONE[state]
      if (!tone) throw new Error(`setup-report line has an unknown state: ${line}`)
      // The `(scope)` suffix is the CLI's own, and it is what tells you which
      // of these rows is a setting rather than a slot. Not worth a badge, so it
      // trails the state in the same cell, dimmed.
      const suffix = scope ? `<span class="setup-scope"> (${escapeHtml(scope)})</span>` : ''
      return `<li><span class="setup-slot">${escapeHtml(name)}</span><span class="setup-state" data-tone="${tone}">${escapeHtml(state)}${suffix}</span></li>`
    })
  return `<div class="setup-report" data-setup-report>
<ul>
${rows.join('\n')}
</ul>
</div>`
}

// ---------- chooser (a decision table you answer for your own project) ----------
// <!-- chooser --> before a two-column table turns the first column into
// buttons and the second into the answer that button reveals. It is for a
// decision a reader makes about their own project, where a table asks them to
// scan rows that will never apply to them. Without JS every answer stays on the
// page under its own label, which is the table again in prose form.
function chooserHtml(article) {
  const marker = '<!-- chooser -->'
  const markerIndex = article.indexOf(marker)
  const start = article.indexOf('<div class="table-wrap">', markerIndex)
  const end = article.indexOf('</table></div>', start)
  if (markerIndex === -1 || start === -1 || end === -1) {
    throw new Error('chooser marker found without a following table')
  }
  const table = article.slice(start, end)
  const prompt = table.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1]?.trim()
  const rows = [...table.matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)]
  if (!prompt || rows.length < 2) {
    throw new Error('chooser needs a two-column table with a header and at least two rows')
  }
  const options = rows.map(([, label, answer], index) => ({
    index,
    // The chip is a button, so the label has to survive as plain text.
    chip: label.replace(/<[^>]*>/g, '').trim(),
    label: label.trim(),
    answer: answer.trim(),
  }))
  const chips = options
    .map(
      (option) =>
        `<button type="button" data-chooser-option="${option.index}" aria-pressed="false">${escapeHtml(option.chip)}</button>`,
    )
    .join('\n    ')
  const panels = options
    .map(
      (option) =>
        `<div class="chooser-panel" data-chooser-panel="${option.index}">
      <p class="chooser-label">${option.label}</p>
      <p class="chooser-answer">${option.answer}</p>
    </div>`,
    )
    .join('\n    ')
  const replacement = `<div class="chooser" data-chooser>
  <p class="chooser-prompt">${prompt}</p>
  <div class="chooser-chips" role="group" aria-label="${escapeHtml(prompt.replace(/<[^>]*>/g, ''))}">
    ${chips}
  </div>
  <div class="chooser-panels">
    ${panels}
  </div>
</div>`
  return (
    article.slice(0, markerIndex) +
    article.slice(markerIndex + marker.length, start) +
    replacement +
    article.slice(end + '</table></div>'.length)
  )
}

// ---------- review route checklist (Upstreaming to OXC) ----------
// <!-- review-route --> before an ordered list turns each step into a
// checklist item with its stated reading time, and app.js keeps a running
// "minutes left" total. Without JS the checkboxes still work, the total is
// simply static.
const REVIEW_MINUTE_WORDS = { two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20 }

function reviewRouteHtml(article) {
  const marker = '<!-- review-route -->'
  const markerIndex = article.indexOf(marker)
  const start = article.indexOf('<ol>', markerIndex)
  const end = article.indexOf('</ol>', start)
  if (markerIndex === -1 || start === -1 || end === -1) {
    throw new Error('review-route marker found without a following ordered list')
  }
  let totalMinutes = 0
  let stepIndex = 0
  const items = article
    .slice(start + '<ol>'.length, end)
    .replace(/<li>([\s\S]*?)<\/li>/g, (item, body) => {
      stepIndex += 1
      const minuteMatch = body.match(/Roughly\s+(\w+)\s+minutes/)
      const minutes = minuteMatch ? (REVIEW_MINUTE_WORDS[minuteMatch[1]] ?? 0) : 0
      totalMinutes += minutes
      const badge = minutes
        ? `<span class="matrix-badge review-step-minutes">${minutes} min</span>`
        : '<span class="matrix-badge review-step-minutes review-step-optional">optional</span>'
      return `<li class="review-step"><input type="checkbox" data-review-check data-minutes="${minutes}" aria-label="Mark review step ${stepIndex} as read" /><span class="review-step-body">${body.trim()}</span>${badge}</li>`
    })
  const replacement = `<div class="review-route" data-review-route data-total-minutes="${totalMinutes}">
  <p class="review-status" aria-live="polite" data-review-status>A full first pass is about ${totalMinutes} minutes, including the code and commits these steps point at. Check them off as you go.</p>
  <ol class="review-route-list">${items}</ol>
</div>`
  return article.slice(0, markerIndex) + article.slice(markerIndex + marker.length, start) + replacement + article.slice(end + '</ol>'.length)
}

// ---------- editor replay (Editor integration) ----------
// A VS Code styled window that steps through a real editing session: open
// with live diagnostics, apply the validated quick fix, then format on save.
// The buffer states are highlighted at build time and the diagnostics and
// latency figures are the ones recorded by the editor benchmark and the
// Extension Host walkthrough.

// Wraps the first occurrence of a plain-text target inside highlighted HTML
// with a squiggle span that reuses the site's hover-doc tooltip. The match
// may cross token boundaries; each covered slice is wrapped separately.
function addSquiggle(html, target, kind, title, doc) {
  const segments = html.split(/(<[^>]+>)/)
  let text = ''
  const spans = []
  for (const [index, segment] of segments.entries()) {
    if (index % 2 === 0 && segment) {
      spans.push({ index, start: text.length, end: text.length + segment.length })
      text += segment
    }
  }
  const start = text.indexOf(target)
  if (start === -1) throw new Error(`Editor replay target not found: ${target}`)
  const end = start + target.length
  const hover = `class="er-squiggle er-squiggle-${kind} tsrx-hover" tabindex="0" role="img" aria-label="${escapeHtml(
    `${title}: ${doc}`,
  )}" data-doc-title="${escapeHtml(title)}" data-doc="${escapeHtml(doc)}"`
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue
    const segment = segments[span.index]
    const from = Math.max(0, start - span.start)
    const to = Math.min(segment.length, end - span.start)
    segments[span.index] =
      `${segment.slice(0, from)}<span ${hover}>${segment.slice(from, to)}</span>${segment.slice(to)}`
  }
  return segments.join('')
}

const EDITOR_REPLAY_DIAGNOSTICS = {
  console: {
    kind: 'warning',
    title: 'eslint(no-console) · warning',
    doc: 'Unexpected console statement. Mapped to the exact authored bytes you typed, never to projection scaffolding.',
  },
  debugger: {
    kind: 'error',
    title: 'eslint(no-debugger) · error',
    doc: '`debugger` statement is not allowed. The quick fix for this line is validated against your authored bytes before VS Code applies it.',
  },
}

function editorReplayWindow({ code, targets, problems, status }) {
  let body = highlightHtml(code, 'tsrx')
  body = addTsrxHovers(body)
  for (const target of targets) {
    const diagnostic = EDITOR_REPLAY_DIAGNOSTICS[target]
    body = addSquiggle(
      body,
      target === 'console' ? 'console.log' : 'debugger',
      diagnostic.kind,
      diagnostic.title,
      diagnostic.doc,
    )
  }
  const problemLines = problems.length
    ? problems
        .map(
          (problem) =>
            `<li class="er-problem er-problem-${problem.kind}">${escapeHtml(problem.text)}</li>`,
        )
        .join('')
    : '<li class="er-problem er-problem-clear">No problems detected in Counter.tsrx</li>'
  const problemCount = problems.filter((problem) => problem.kind === 'error').length
  const warningCount = problems.filter((problem) => problem.kind === 'warning').length
  return `<div class="er-window" role="group" aria-label="Simulated VS Code window">
  <div class="er-titlebar"><span class="er-dot"></span><span class="er-dot"></span><span class="er-dot"></span><span class="er-filetab">Counter.tsrx</span></div>
  <div class="er-code">${body}</div>
  <div class="er-problems" aria-label="Problems panel"><p class="er-problems-title">Problems</p><ul>${problemLines}</ul></div>
  <div class="er-statusbar"><span class="er-status-counts" aria-label="${problemCount} errors, ${warningCount} warnings">✕ ${problemCount} ⚠ ${warningCount}</span><span class="er-status-latency">${escapeHtml(status)}</span></div>
</div>`
}

// Every latency this demo says out loud comes from the aggregate-selected
// editor report, formatted here rather than typed in, so rerunning the
// benchmarks moves the demo copy along with the gate tables.
const editorReplayMs = (value) => `${value.toFixed(2)} ms`

function editorReplayStages(latency) {
  const openCode = `export function Counter({start}:{start:number}) @{
  var count = start;
  console.log("mounted");
  debugger;

  <div   class="counter">
    <span>{count}</span>
  </div>
}`
  const fixedCode = `export function Counter({start}:{start:number}) @{
  var count = start;
  console.log("mounted");

  <div   class="counter">
    <span>{count}</span>
  </div>
}`
  const formattedCode = `export function Counter({ start }: { start: number }) @{
  var count = start;
  console.log("mounted");

  <div class="counter">
    <span>{count}</span>
  </div>
}`
  const consoleProblem = {
    kind: 'warning',
    text: 'eslint(no-console): Unexpected console statement · at your authored bytes',
  }
  return [
    {
      id: 'open',
      label: 'Open',
      text: 'You open an unsaved buffer with two problems in it. The native server lints the in-memory text and the squiggles land on the exact bytes you typed. Hover a squiggle to read the real diagnostic.',
      window: editorReplayWindow({
        code: openCode,
        targets: ['console', 'debugger'],
        problems: [
          consoleProblem,
          {
            kind: 'error',
            text: 'eslint(no-debugger): `debugger` statement is not allowed · at your authored bytes',
          },
        ],
        status: `open to first diagnostics: ${editorReplayMs(latency.initialOpenMedianMs)} median`,
      }),
    },
    {
      id: 'quickfix',
      label: 'Quick fix',
      text: 'You accept the quickfix for no-debugger. The server only offered it because the affected text exists verbatim in your file and the fixed result reparses as valid TSRX. The debugger line is gone and the error disappears with it.',
      window: editorReplayWindow({
        code: fixedCode,
        targets: ['console'],
        problems: [consoleProblem],
        status: `code action round trip: ${editorReplayMs(latency.codeActionsP95Ms)} p95`,
      }),
    },
    {
      id: 'format',
      label: 'Format on save',
      text: 'You save. Oxfmt formats a projected TSX copy, the result is lifted back into TSRX syntax, and the lift is verified before the editor applies one edit. The messy spacing is gone and your @-controls are untouched.',
      window: editorReplayWindow({
        code: formattedCode,
        targets: ['console'],
        problems: [consoleProblem],
        status: `format request: ${editorReplayMs(latency.formattingP95Ms)} p95 · code actions never touch disk`,
      }),
    },
  ]
}

async function editorReplayHtml() {
  const latency = await editorReplayLatencies()
  const stages = editorReplayStages(latency)
  const prefix = 'er'
  return `<figure class="er-replay" data-editor-replay>
  <div class="er-replay-head">
    <span class="er-replay-title">One editing session, replayed</span>
    <button type="button" class="er-play" data-er-play aria-label="Play the editor session">Play</button>
  </div>
  <div class="explorer pipeline er-stages" data-explorer>
    <div class="explorer-tabs pipeline-tabs" role="tablist" aria-label="Editor session stages">
      ${stages
        .map(
          (stage, index) =>
            `<button type="button" role="tab" id="${prefix}-tab-${stage.id}" aria-controls="${prefix}-panel-${stage.id}" aria-selected="${index === 0}" ${index === 0 ? '' : 'tabindex="-1"'}><span class="pipeline-step" aria-hidden="true">${index + 1}</span>${stage.label}</button>`,
        )
        .join('\n      ')}
    </div>
    ${stages
      .map(
        (stage, index) =>
          `<div class="explorer-panel" role="tabpanel" id="${prefix}-panel-${stage.id}" aria-labelledby="${prefix}-tab-${stage.id}" ${index === 0 ? '' : 'hidden'}><p class="pipeline-text">${stage.text}</p>${stage.window}</div>`,
      )
      .join('\n    ')}
  </div>
  <figcaption>The diagnostics, quick-fix rules, and latency figures are the real recorded ones: ${escapeHtml(editorReplayMs(latency.initialOpenMedianMs))} median open-to-diagnostics and edit, format, and code-action p95 all at or under ${escapeHtml(editorReplayMs(latency.slowestRoundTripP95Ms))} on the recorded ${escapeHtml(latency.cpu)}, with zero disk writes from code actions.</figcaption>
</figure>`
}

async function editorReplayMarkdown() {
  const latency = await editorReplayLatencies()
  return [
    'One editing session, replayed in three stages:',
    '',
    `1. **Open.** An unsaved buffer with a \`console.log\` warning and a \`debugger\` error gets live diagnostics on the exact authored bytes (${editorReplayMs(latency.initialOpenMedianMs)} median open to first diagnostics).`,
    `2. **Quick fix.** The validated \`no-debugger\` quickfix removes the statement; it was only offered because the text exists verbatim and the result reparses (${editorReplayMs(latency.codeActionsP95Ms)} p95).`,
    `3. **Format on save.** Oxfmt formats a projected copy, the lift back to TSRX is verified, and one edit fixes the messy spacing (${editorReplayMs(latency.formattingP95Ms)} p95, zero disk writes).`,
  ].join('\n')
}

// ---------- annotated config examples (Configuration) ----------
// <!-- annotate-config --> before a fenced jsonc block gives the known keys
// the same hover-doc treatment as TSRX tokens, so hovering a field explains
// what the native boundary does with it.
const CONFIG_DOCS = {
  plugins: ['plugins', 'Enables built-in plugin rule sets like react or typescript. JavaScript plugins are not supported and fail loudly.'],
  env: ['env', 'Declares an environment such as browser, which defines its globals through the canonical ConfigStoreBuilder.'],
  globals: ['globals', 'Declares project-specific globals and whether code may write to them.'],
  rules: ['rules', 'Sets severity and options per rule with canonical OXC precedence. CLI -A, -W, and -D flags win over these.'],
  overrides: ['overrides', 'Per-pattern changes, matched against your authored .tsrx paths before any projection exists, so **/*.tsrx keeps working.'],
  files: ['files', 'The glob patterns this override applies to.'],
  ignorePatterns: ['ignorePatterns', 'Paths to skip, rooted at the directory the config file lives in.'],
  options: ['options', 'Exit policy (denyWarnings, maxWarnings) and the opt-in type lanes.'],
  typeAware: ['typeAware', 'Opts into tsgolint type-aware rules. The direct native command still requires the explicit --type-aware flag so a TypeScript-Go process never starts unexpectedly.'],
  typeCheck: ['typeCheck', 'Also publishes TypeScript syntactic and semantic diagnostics, and implies the type-aware lane.'],
  singleQuote: ['singleQuote', 'Prefer single quotes in JS and TS output.'],
  semi: ['semi', 'Whether statements end with semicolons.'],
  printWidth: ['printWidth', 'The line width the formatter tries to fit.'],
  singleAttributePerLine: ['singleAttributePerLine', 'Puts each JSX attribute on its own line when an element wraps.'],
}

function annotateConfigBlocks(article) {
  const marker = '<!-- annotate-config -->'
  while (article.includes(marker)) {
    const markerIndex = article.indexOf(marker)
    const start = article.indexOf('<div class="code-block" data-lang="jsonc">', markerIndex)
    if (start === -1) throw new Error('annotate-config marker found without a following jsonc block')
    const end = article.indexOf('</div>', start)
    let block = article.slice(start, end)
    let annotated = 0
    block = block.replace(
      /(<span[^>]*>)([ \t]*)(&quot;|")([A-Za-z]+)\3(<\/span>)/g,
      (match, open, whitespace, quote, key, close) => {
        const doc = CONFIG_DOCS[key]
        if (!doc) return match
        annotated += 1
        return `${open}${whitespace}<span class="tsrx-hover" tabindex="0" role="img" aria-label="${escapeHtml(
          `${doc[0]}: ${doc[1]}`,
        )}" data-doc-title="${escapeHtml(doc[0])}" data-doc="${escapeHtml(doc[1])}">${quote}${key}${quote}</span>${close}`
      },
    )
    if (annotated === 0) throw new Error('annotate-config found no known keys to annotate')
    article = article.slice(0, markerIndex) + article.slice(markerIndex + marker.length, start) + block + article.slice(end)
  }
  return article
}

function alignProjectionLines(sourceLines, projectedLines) {
  const lengths = Array.from({ length: sourceLines.length + 1 }, () =>
    Array(projectedLines.length + 1).fill(0),
  )
  for (let sourceIndex = sourceLines.length - 1; sourceIndex >= 0; sourceIndex--) {
    for (let projectedIndex = projectedLines.length - 1; projectedIndex >= 0; projectedIndex--) {
      lengths[sourceIndex][projectedIndex] =
        sourceLines[sourceIndex] === projectedLines[projectedIndex]
          ? lengths[sourceIndex + 1][projectedIndex + 1] + 1
          : Math.max(
              lengths[sourceIndex + 1][projectedIndex],
              lengths[sourceIndex][projectedIndex + 1],
            )
    }
  }

  const pairs = []
  let sourceIndex = 0
  let projectedIndex = 0
  while (sourceIndex < sourceLines.length && projectedIndex < projectedLines.length) {
    if (sourceLines[sourceIndex] === projectedLines[projectedIndex]) {
      pairs.push({ sourceIndex, projectedIndex })
      sourceIndex++
      projectedIndex++
    } else if (
      lengths[sourceIndex + 1][projectedIndex] >=
      lengths[sourceIndex][projectedIndex + 1]
    ) {
      sourceIndex++
    } else {
      projectedIndex++
    }
  }
  return pairs
}

function decorateProjectionLines(html, mapIds, { unpairedAttr, diagLines } = {}) {
  let lineIndex = 0
  return html
    .replace(/<span class="line">/g, () => {
      const index = lineIndex++
      const mapId = mapIds.get(index)
      const attrs = [
        mapId !== undefined ? ` data-map-id="${mapId}"` : unpairedAttr ? ` ${unpairedAttr}` : '',
        diagLines?.has(index) ? ' data-diag-line' : '',
      ].join('')
      return `<span class="line"${attrs}>`
    })
    .replace(/\r?\n(?=<span class="line"(?:\s|>))/g, '')
}

// "How it works" walkthrough: the four pipeline steps as buttons that light up
// the matching lines of the linked projection map, one explanation at a time.
// `<!-- cli-builder -->`: a flag picker. Nobody reads a table of twenty flags,
// but people will click three of them to see the command they should have run,
// so the reference doubles as the thing you copy.
const CLI_COMMANDS = [
  {
    id: 'oxlint',
    label: 'oxlint',
    base: 'npx oxlint',
    target: 'src/Cart.tsrx',
    lead: 'Lints your files.',
    flags: [
      { flag: '--fix', summary: 'apply safe fixes', effect: 'applies fixes to your original TSRX and reparses the result before writing' },
      { flag: '--deny', value: 'no-debugger', summary: 'turn a rule into an error', effect: 'treats <code>no-debugger</code> as an error whatever the config says' },
      { flag: '--warn', value: 'no-console', summary: 'turn a rule into a warning', effect: 'downgrades <code>no-console</code> to a warning' },
      { flag: '--allow', value: 'no-unused-vars', summary: 'switch a rule off', effect: 'switches <code>no-unused-vars</code> off for this run' },
      { flag: '--type-aware', summary: 'add type-aware rules', effect: 'adds the official tsgolint rules, one type-checking process for the whole batch' },
      { flag: '--type-check', summary: 'add full TypeScript diagnostics', effect: 'adds TypeScript compiler diagnostics on top of the type-aware rules' },
      { flag: '--config', value: '.oxlintrc.json', summary: 'name a config file', effect: 'reads that config instead of searching upward for one' },
      { flag: '--format', value: 'json', summary: 'machine-readable output', effect: 'prints one JSON report instead of the usual text' },
    ],
  },
  {
    id: 'oxfmt',
    label: 'oxfmt',
    base: 'npx oxfmt',
    target: 'src/Cart.tsrx',
    lead: 'Formats your files.',
    flags: [
      { flag: '--check', summary: 'report, do not write', effect: 'lists files that would change and exits 1, writing nothing' },
      { flag: '--write', summary: 'write the result', effect: 'rewrites the files, and only after every file in the batch formatted successfully' },
      { flag: '--config', value: '.oxfmtrc.json', summary: 'name a config file', effect: 'reads that config instead of searching upward for one' },
      { flag: '--threads', value: '4', summary: 'set worker count', effect: 'formats with four workers' },
      { flag: '--with-node-modules', summary: 'include node_modules', effect: 'stops skipping <code>node_modules</code>, which it skips by default' },
    ],
  },
  {
    id: 'oxc-tsrx',
    label: 'oxc-tsrx',
    base: 'npx oxc-tsrx',
    target: '',
    lead: 'Manages the install itself.',
    exclusive: true,
    flags: [
      { flag: 'providers', summary: 'what a host finds here', effect: 'prints the provider index and writes nothing. Look for <code>routed extensions: .tsrx -> oxc-tsrx</code>' },
      { flag: 'status', summary: 'check the Vite+ slots', effect: 'reports the four compatibility slots. Three <code>missing</code> lines are the healthy result outside Vite+' },
      { flag: 'setup', summary: 'write the Vite+ slots', effect: 'writes the project-local stand-ins Vite+ resolves, plus the editor setting when it is needed' },
      { flag: 'remove', summary: 'undo setup', effect: 'removes those slots and restores any official package it displaced' },
      { flag: '--json', summary: 'machine-readable output', effect: 'prints the same answer as JSON' },
    ],
  },
]

function cliBuilderHtml() {
  const tabs = CLI_COMMANDS.map(
    (command, index) =>
      `<button type="button" role="tab" id="cli-tab-${command.id}" aria-controls="cli-panel-${command.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"><code>${escapeHtml(command.label)}</code></button>`,
  ).join('')
  const panels = CLI_COMMANDS.map((command, index) => {
    const flags = command.flags
      .map(
        (entry, position) =>
          `<label class="cli-flag"><input type="${command.exclusive ? 'radio' : 'checkbox'}" name="cli-${command.id}"${command.exclusive && position === 0 ? ' checked' : ''} data-cli-flag="${escapeHtml(entry.flag)}"${entry.value ? ` data-cli-value="${escapeHtml(entry.value)}"` : ''} data-cli-effect="${escapeHtml(entry.effect)}"><span><code>${escapeHtml(entry.flag)}${entry.value ? ` ${entry.value}` : ''}</code> ${escapeHtml(entry.summary)}</span></label>`,
      )
      .join('')
    return `<div role="tabpanel" id="cli-panel-${command.id}" aria-labelledby="cli-tab-${command.id}"${index === 0 ? '' : ' hidden'} data-cli-command data-cli-base="${escapeHtml(command.base)}" data-cli-target="${escapeHtml(command.target)}" data-cli-lead="${escapeHtml(command.lead)}"${command.exclusive ? ' data-cli-exclusive' : ''}>
  <div class="cli-flags">${flags}</div>
  <div class="code-block cli-line" data-lang="sh"><code data-cli-output></code></div>
  <p class="cli-effect" data-cli-explain aria-live="polite"></p>
</div>`
  }).join('\n')
  return `<div class="cli-builder" data-cli-builder>
  <div class="cli-tabs" role="tablist" aria-label="Command">${tabs}</div>
  ${panels}
</div>\n`
}

const cliBuilderMarkdown = CLI_COMMANDS.map(
  (command) =>
    `### \`${command.label}\`\n\n${command.lead}\n\n| Flag | What it does |\n| --- | --- |\n${command.flags
      .map(
        (entry) =>
          `| \`${entry.flag}${entry.value ? ` ${entry.value}` : ''}\` | ${entry.effect.replace(/<\/?code>/g, '`').replace(/<[^>]*>/g, '')} |`,
      )
      .join('\n')}`,
).join('\n\n')

// `<!-- rule-sees -->`: the four things a JavaScript rule sees differently on
// `.tsrx`. Each one is a before/after pair, so a tabbed panel showing your file
// next to the copy carries it better than four dense paragraphs did.
const RULE_SEES = [
  {
    id: 'control',
    label: 'Control blocks',
    summary:
      'TSRX control syntax is already compiled away, so a rule keyed on <code>JSXForExpression</code> never fires. Your rule does visit the compiled statement, but a report on one is dropped, because its span covers text the copy wrote.',
    yours: '@for (const task of tasks) {\n  <li>{task.label}</li>;\n}',
    copy: 'for (const task of tasks) {\n  <li>{task.label}</li>;\n}',
    note: 'Measured one rule per node type: <code>JSXElement</code> reported 7 and dropped 0, while <code>IfStatement</code>, <code>SwitchStatement</code>, and <code>FunctionDeclaration</code> each reported 0 and dropped 1.',
  },
  {
    id: 'filename',
    label: 'context.filename',
    summary:
      'Your rule is handed the copy\u2019s path. The path relative to your working directory survives, so a rule testing for <code>src/</code> works, but one comparing an absolute path or expecting a <code>.tsrx</code> extension does not. The diagnostic still lands on your file.',
    yours: 'src/View.tsrx',
    copy: '<temporary directory>/src/View.tsrx.tsx',
  },
  {
    id: 'dropped',
    label: 'Dropped reports',
    summary:
      'The copy adds markers and wrappers matching nothing you typed, and a report on one of those has no position in your file to point at. It is dropped, and the count is never silent.',
    note: 'The count goes to stderr on a second <code>oxlint (oxc-tsrx):</code> line, into <code>oxcTsrx.jsPluginProjection.unmapped</code> under <code>--format=json</code>, and into one <code>js-plugins-unmapped</code> warning in your editor.',
  },
  {
    id: 'overrides',
    label: 'overrides globs',
    summary:
      'The copy is named <code>View.tsrx.tsx</code>, which <code>**/*.tsrx</code> does not match, so <code>oxlint</code> emits each of your <code>overrides[].files</code> and <code>excludeFiles</code> globs with <code>.tsx</code> appended as well.',
    yours: '"files": ["**/*.tsrx"]',
    copy: '"files": ["**/*.tsrx", "**/*.tsrx.tsx"]',
    note: 'A config reached through <code>extends</code> does not get that rewrite yet, so put <code>.tsrx</code>-targeted overrides in the config that names <code>jsPlugins</code>.',
  },
]

function ruleSeesHtml() {
  const buttons = RULE_SEES.map(
    (facet, index) =>
      `<button type="button" role="tab" id="rule-sees-tab-${facet.id}" aria-controls="rule-sees-panel-${facet.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(facet.label)}</button>`,
  ).join('')
  const panels = RULE_SEES.map(
    (facet, index) =>
      `<div role="tabpanel" id="rule-sees-panel-${facet.id}" aria-labelledby="rule-sees-tab-${facet.id}"${index === 0 ? '' : ' hidden'}>
  <p class="facet-summary">${facet.summary}</p>
  ${
    facet.yours
      ? `<div class="facet-pair">
    <div><span class="facet-label">You wrote</span><div class="code-block" data-lang="tsrx">${highlightHtml(facet.yours, 'tsrx')}</div></div>
    <div><span class="facet-label">Your rule sees</span><div class="code-block" data-lang="tsx">${highlightHtml(facet.copy, 'tsx')}</div></div>
  </div>`
      : ''
  }${facet.note ? `\n  <p class="facet-note">${facet.note}</p>` : ''}
</div>`,
  ).join('\n')
  return `<div class="facet-tabs" data-facet-tabs>
  <div class="facet-tabs-bar" role="tablist" aria-label="What your rule sees on .tsrx">${buttons}</div>
  ${panels}
</div>\n`
}

const ruleSeesMarkdown = RULE_SEES.map(
  (facet) =>
    `- **${facet.label}.** ${facet.summary.replace(/<\/?code>/g, '`').replace(/<[^>]*>/g, '')}`,
).join('\n')

async function howItWorksHtml() {
  const example = await loadProjectionExample()
  if (!example) {
    return '<p><em>Run <code>node docs/generate-projection.mjs</code> to generate the walkthrough.</em></p>'
  }

  const sourceLines = example.tsrx.split('\n')
  const projectedLines = example.projected.split('\n')
  const pairs = alignProjectionLines(sourceLines, projectedLines)
  const sourceMapIds = new Map()
  const projectedMapIds = new Map()
  pairs.forEach(({ sourceIndex, projectedIndex }, mapId) => {
    sourceMapIds.set(sourceIndex, mapId)
    projectedMapIds.set(projectedIndex, mapId)
  })

  // The lines the real diagnostics point at, in both panes.
  const lineOfOffset = (text, offset) => text.slice(0, offset).split('\n').length - 1
  const sourceDiagLines = new Set(
    example.diagnostics.flatMap((diagnostic) =>
      diagnostic.labels.map((label) => lineOfOffset(example.tsrx, label.span.offset)),
    ),
  )
  const projectedDiagLines = new Set(
    pairs
      .filter((pair) => sourceDiagLines.has(pair.sourceIndex))
      .map((pair) => pair.projectedIndex),
  )

  const source = addTsrxHovers(
    decorateProjectionLines(highlightHtml(example.tsrx, 'tsrx'), sourceMapIds, {
      unpairedAttr: 'data-tsrx-only',
      diagLines: sourceDiagLines,
    }),
  )
  const projected = decorateProjectionLines(
    highlightHtml(example.projected, 'tsx'),
    projectedMapIds,
    { unpairedAttr: 'data-scaffold', diagLines: projectedDiagLines },
  )

  const diagCodes = [...new Set(example.diagnostics.map((diagnostic) => diagnostic.code))]
    .map((code) => `<code>${escapeHtml(code)}</code>`)
    .join(' and ')
  const steps = [
    {
      id: 'scan',
      label: 'Scan',
      text: 'One pass finds the TSRX-only lines, highlighted on the left. OXC on its own cannot parse them.',
    },
    {
      id: 'project',
      label: 'Project',
      text: 'Each construct becomes a valid TSX placeholder, highlighted on the right. Every other byte is your code, untouched.',
    },
    {
      id: 'lint',
      label: 'Run the real OXC',
      text: `The real, unmodified OXC runs on the copy, exactly once, and flags the highlighted lines: ${diagCodes}.`,
    },
    {
      id: 'map',
      label: 'Map back',
      text: 'Each warning lands back on the bytes you wrote, highlighted on the left. Formatting is lifted back the same way.',
    },
  ]
  return `<figure class="projection-map how-it-works" data-projection-map data-how-it-works>
  <div class="hiw-steps" role="group" aria-label="The four steps of the pipeline">
    ${steps
      .map(
        (step, index) =>
          `<button type="button" data-hiw-step="${step.id}" aria-pressed="false"><span class="pipeline-step" aria-hidden="true">${index + 1}</span>${step.label}</button>`,
      )
      .join('\n    ')}
    <button type="button" class="hiw-dim-toggle" aria-pressed="false" data-scaffolding-toggle>Dim the scaffolding</button>
  </div>
  <div class="hiw-strip" aria-live="polite">
    ${steps
      .map(
        (step) => `<p class="hiw-text" data-hiw-text="${step.id}">${step.text}</p>`,
      )
      .join('\n    ')}
  </div>
  <div class="projection-map-panes">
    <section class="projection-map-pane" aria-label="Your TSRX source code" data-map-id-count="${pairs.length}">
      <h3>Your TSRX</h3>
      <div class="projection-map-code">${source}</div>
    </section>
    <section class="projection-map-pane" aria-label="The projected TSX code OXC sees" data-map-id-count="${pairs.length}">
      <h3>What OXC actually sees</h3>
      <div class="projection-map-code">${projected}</div>
    </section>
  </div>
  <figcaption>Hover any shared line to see its twin in the other pane.</figcaption>
</figure>`
}

// Plain-markdown twin of the walkthrough for the copy-as-Markdown page,
// llms-full.txt, and the search index.
const howItWorksMarkdown = `1. **Scans** the file once and records where the TSRX-only syntax is.
2. **Projects** it: builds an in-memory copy where each TSRX construct is
   swapped for equivalent, valid TSX placeholders. Your real code between
   those constructs is copied byte-for-byte, and the tool remembers exactly
   which byte ranges are "your code" and which are placeholder.
3. **Runs the real OXC** (parser, then linter or formatter) on that copy.
   Exactly once. Even dynamic tags are validated against this same parse.
4. **Maps the results back** to your original file. Lint errors point at your
   actual \`.tsrx\` lines and columns. For formatting, a final step (the
   *lift*) converts the formatted TSX copy back into TSRX and double-checks
   that nothing structural changed.`

// "Copy page ▾" split menu: copy/view as Markdown, open in AI assistants.
// Package-manager install tabs. Authors write only the npm command after a
// <!-- pm-install --> marker; the pnpm/yarn/bun equivalents are derived here
// so the variants can never drift apart.
const PM_INSTALL_VARIANTS = [
  // Order matters: the dev prefix must match before the plain one.
  {
    npm: 'npm install --save-dev',
    pnpm: 'pnpm add -D',
    yarn: 'yarn add -D',
    bun: 'bun add -d',
  },
  {
    npm: 'npm install',
    pnpm: 'pnpm add',
    yarn: 'yarn add',
    bun: 'bun add',
  },
]

// A pm-install block may carry follow-up `npx` lines, and those have to move to
// the reader's package manager too. `npx` is not a universal runner: a project
// scaffolded by `vp create` declares devEngines.packageManager, and npm exits
// with EBADDEVENGINES when that block names someone else. Leaving `npx` in the
// pnpm tab hands pnpm users a command that cannot run.
const PM_EXEC_PREFIXES = {
  npm: 'npx',
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  bun: 'bunx',
}
// <!-- pm-exec --> is the same component for a block that only runs a command:
// authors write the `npx` form and each tab gets that manager's runner.
const PM_TABS_PATTERN = /<!-- pm-(?:install|exec) -->\r?\n```sh\r?\n([\s\S]*?)\r?\n```/g

// Each project's own mark, as the single-path glyphs published by Simple Icons
// (CC0; the marks themselves stay their owners' trademarks and are used here to
// name the tool they belong to). They are inlined rather than fetched, so the
// strict CSP holds, and they fill with `currentColor` so a selected tab and a
// hovered brand link tint the mark along with the label.
const BRAND_ICONS = {
  npm: 'M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z',
  pnpm: 'M0 0v7.5h7.5V0zm8.25 0v7.5h7.498V0zm8.25 0v7.5H24V0zM2 2h3.5v3.5H2zm8.25 0h3.498v3.5H10.25zm8.25 0H22v3.5h-3.5zM8.25 8.25v7.5h7.498v-7.5zm8.25 0v7.5H24v-7.5zm2 2H22v3.5h-3.5zM0 16.5V24h7.5v-7.5zm8.25 0V24h7.498v-7.5zm8.25 0V24H24v-7.5z',
  yarn: 'M12 0C5.375 0 0 5.375 0 12s5.375 12 12 12 12-5.375 12-12S18.625 0 12 0zm.768 4.105c.183 0 .363.053.525.157.125.083.287.185.755 1.154.31-.088.468-.042.551-.019.204.056.366.19.463.375.477.917.542 2.553.334 3.605-.241 1.232-.755 2.029-1.131 2.576.324.329.778.899 1.117 1.825.278.774.31 1.478.273 2.015a5.51 5.51 0 0 0 .602-.329c.593-.366 1.487-.917 2.553-.931.714-.009 1.269.445 1.353 1.103a1.23 1.23 0 0 1-.945 1.362c-.649.158-.95.278-1.821.843-1.232.797-2.539 1.242-3.012 1.39a1.686 1.686 0 0 1-.704.343c-.737.181-3.266.315-3.466.315h-.046c-.783 0-1.214-.241-1.45-.491-.658.329-1.51.19-2.122-.134a1.078 1.078 0 0 1-.58-1.153 1.243 1.243 0 0 1-.153-.195c-.162-.25-.528-.936-.454-1.946.056-.723.556-1.367.88-1.71a5.522 5.522 0 0 1 .408-2.256c.306-.727.885-1.348 1.32-1.737-.32-.537-.644-1.367-.329-2.21.227-.602.412-.936.82-1.08h-.005c.199-.074.389-.153.486-.259a3.418 3.418 0 0 1 2.298-1.103c.037-.093.079-.185.125-.283.31-.658.639-1.029 1.024-1.168a.94.94 0 0 1 .328-.06zm.006.7c-.507.016-1.001 1.519-1.001 1.519s-1.27-.204-2.266.871c-.199.218-.468.334-.746.44-.079.028-.176.023-.417.672-.371.991.625 2.094.625 2.094s-1.186.839-1.626 1.881c-.486 1.144-.338 2.261-.338 2.261s-.843.732-.899 1.487c-.051.663.139 1.2.343 1.515.227.343.51.176.51.176s-.561.653-.037.931c.477.25 1.283.394 1.71-.037.31-.31.371-1.001.486-1.283.028-.065.12.111.209.199.097.093.264.195.264.195s-.755.324-.445 1.066c.102.246.468.403 1.066.398.222-.005 2.664-.139 3.313-.296.375-.088.505-.283.505-.283s1.566-.431 2.998-1.357c.917-.598 1.293-.76 2.034-.936.612-.148.57-1.098-.241-1.084-.839.009-1.575.44-2.196.825-1.163.718-1.742.672-1.742.672l-.018-.032c-.079-.13.371-1.293-.134-2.678-.547-1.515-1.413-1.881-1.344-1.997.297-.5 1.038-1.297 1.334-2.78.176-.899.13-2.377-.269-3.151-.074-.144-.732.241-.732.241s-.616-1.371-.788-1.483a.271.271 0 0 0-.157-.046z',
  bun: 'M12 22.596c6.628 0 12-4.338 12-9.688 0-3.318-2.057-6.248-5.219-7.986-1.286-.715-2.297-1.357-3.139-1.89C14.058 2.025 13.08 1.404 12 1.404c-1.097 0-2.334.785-3.966 1.821a49.92 49.92 0 0 1-2.816 1.697C2.057 6.66 0 9.59 0 12.908c0 5.35 5.372 9.687 12 9.687v.001ZM10.599 4.715c.334-.759.503-1.58.498-2.409 0-.145.202-.187.23-.029.658 2.783-.902 4.162-2.057 4.624-.124.048-.199-.121-.103-.209a5.763 5.763 0 0 0 1.432-1.977Zm2.058-.102a5.82 5.82 0 0 0-.782-2.306v-.016c-.069-.123.086-.263.185-.172 1.962 2.111 1.307 4.067.556 5.051-.082.103-.23-.003-.189-.126a5.85 5.85 0 0 0 .23-2.431Zm1.776-.561a5.727 5.727 0 0 0-1.612-1.806v-.014c-.112-.085-.024-.274.114-.218 2.595 1.087 2.774 3.18 2.459 4.407a.116.116 0 0 1-.049.071.11.11 0 0 1-.153-.026.122.122 0 0 1-.022-.083 5.891 5.891 0 0 0-.737-2.331Zm-5.087.561c-.617.546-1.282.76-2.063 1-.117 0-.195-.078-.156-.181 1.752-.909 2.376-1.649 2.999-2.778 0 0 .155-.118.188.085 0 .304-.349 1.329-.968 1.874Zm4.945 11.237a2.957 2.957 0 0 1-.937 1.553c-.346.346-.8.565-1.286.62a2.178 2.178 0 0 1-1.327-.62 2.955 2.955 0 0 1-.925-1.553.244.244 0 0 1 .064-.198.234.234 0 0 1 .193-.069h3.965a.226.226 0 0 1 .19.07c.05.053.073.125.063.197Zm-5.458-2.176a1.862 1.862 0 0 1-2.384-.245 1.98 1.98 0 0 1-.233-2.447c.207-.319.503-.566.848-.713a1.84 1.84 0 0 1 1.092-.11c.366.075.703.261.967.531a1.98 1.98 0 0 1 .408 2.114 1.931 1.931 0 0 1-.698.869v.001Zm8.495.005a1.86 1.86 0 0 1-2.381-.253 1.964 1.964 0 0 1-.547-1.366c0-.384.11-.76.32-1.079.207-.319.503-.567.849-.713a1.844 1.844 0 0 1 1.093-.108c.367.076.704.262.968.534a1.98 1.98 0 0 1 .4 2.117 1.932 1.932 0 0 1-.702.868Z',
  deno: 'M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771 12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774 12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305 12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437-.455-.197-1.04-.624-1.226-.829-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35.66.111 1.484.25 2.317.292 2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19 12 12 0 0 1-1.25-1.634 12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236.13.979-.228 1.99-1.41 2.013-1.01.02-1.315-.997-1.248-1.614.066-.616.574-1.575 1.35-1.635',
  oxc: 'M15.463 3.923c0 .637.517 1.154 1.154 1.154h4.376c.515 0 .772.62.408.984l-5.6 5.601c-.217.216-.34.51-.34.816v1.915c0 .797.79 1.35 1.49.97.71-.386 1.371-.853 1.972-1.392a.603.603 0 0 1 .828.012l4.08 4.08a.56.56 0 0 1-.007.808A17.25 17.25 0 0 1 12 23.54 17.25 17.25 0 0 1 .176 18.872a.56.56 0 0 1-.006-.81l4.08-4.078a.604.604 0 0 1 .827-.012 10.4 10.4 0 0 0 1.973 1.39c.7.38 1.488-.171 1.488-.968v-1.915c0-.307-.122-.6-.339-.816L2.6 6.061a.576.576 0 0 1 .408-.984h4.376c.637 0 1.154-.517 1.154-1.154V1.038c0-.32.258-.577.577-.577h5.77c.318 0 .576.258.576.577v2.885z',
  typescript:
    'M1.125 0C.502 0 0 .502 0 1.125v21.75C0 23.498.502 24 1.125 24h21.75c.623 0 1.125-.502 1.125-1.125V1.125C24 .502 23.498 0 22.875 0zm17.363 9.75c.612 0 1.154.037 1.627.111a6.38 6.38 0 0 1 1.306.34v2.458a3.95 3.95 0 0 0-.643-.361 5.093 5.093 0 0 0-.717-.26 5.453 5.453 0 0 0-1.426-.2c-.3 0-.573.028-.819.086a2.1 2.1 0 0 0-.623.242c-.17.104-.3.229-.393.374a.888.888 0 0 0-.14.49c0 .196.053.373.156.529.104.156.252.304.443.444s.423.276.696.41c.273.135.582.274.926.416.47.197.892.407 1.266.628.374.222.695.473.963.753.268.279.472.598.614.957.142.359.214.776.214 1.253 0 .657-.125 1.21-.373 1.656a3.033 3.033 0 0 1-1.012 1.085 4.38 4.38 0 0 1-1.487.596c-.566.12-1.163.18-1.79.18a9.916 9.916 0 0 1-1.84-.164 5.544 5.544 0 0 1-1.512-.493v-2.63a5.033 5.033 0 0 0 3.237 1.2c.333 0 .624-.03.872-.09.249-.06.456-.144.623-.25.166-.108.29-.234.373-.38a1.023 1.023 0 0 0-.074-1.089 2.12 2.12 0 0 0-.537-.5 5.597 5.597 0 0 0-.807-.444 27.72 27.72 0 0 0-1.007-.436c-.918-.383-1.602-.852-2.053-1.405-.45-.553-.676-1.222-.676-2.005 0-.614.123-1.141.369-1.582.246-.441.58-.804 1.004-1.089a4.494 4.494 0 0 1 1.47-.629 7.536 7.536 0 0 1 1.77-.201zm-15.113.188h9.563v2.166H9.506v9.646H6.789v-9.646H3.375z',
  react:
    'M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z',
}

// A brand whose mark is not one flat path in the set above: TSRX ships a
// wordmark on a gradient, and this project's own logo is strokes on a gradient.
// Both are referenced as files rather than inlined, because two inlined SVGs
// carrying a `<linearGradient id>` collide the moment they share a page.
const BRAND_IMAGES = {
  tsrx: 'brands/tsrx.svg',
  'oxc-tsrx': 'logo.svg',
}

// `<!-- extension:oxc -->` renders the Marketplace listing as a card: the
// extension's own icon, what it is, and a link to install it. The icons are
// copied from the published VSIXs into `assets/extensions`, so nothing is
// fetched from a Marketplace CDN at page load.
const EXTENSIONS = {
  oxc: {
    name: 'Oxc',
    id: 'oxc.oxc-vscode',
    summary: 'Oxlint and Oxfmt editor integration. This is the one that serves .tsrx.',
    icon: 'oxc.webp',
  },
  tsrx: {
    name: 'TSRX for VS Code',
    id: 'ripple-ts.ripple-ts-vscode-plugin',
    summary: 'Syntax highlighting and IntelliSense for .tsrx, from the TSRX toolchain.',
    icon: 'tsrx.webp',
  },
}

function extensionCardHtml(key) {
  const extension = EXTENSIONS[key]
  const href = `https://marketplace.visualstudio.com/items?itemName=${extension.id}`
  return `<a class="ext-card" href="${href}" target="_blank" rel="noreferrer">
  <img src="${withBase(`/assets/extensions/${extension.icon}`)}" alt="" width="44" height="44" loading="lazy">
  <span class="ext-card-body"><span class="ext-card-name">${escapeHtml(extension.name)}</span><span class="ext-card-summary">${escapeHtml(extension.summary)}</span><code class="ext-card-id">${escapeHtml(extension.id)}</code></span>
  <span class="ext-card-cta">Install<span class="visually-hidden"> (opens in new tab)</span></span>
</a>\n`
}

function brandIconHtml(name) {
  const image = BRAND_IMAGES[name]
  if (image) {
    return `<img src="${withBase(`/assets/${image}`)}" alt="" width="16" height="16" loading="lazy">`
  }
  const path = BRAND_ICONS[name]
  if (!path) return ''
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`
}

// Package-manager tab groups repeat the same brand marks several times per
// page, and the two round marks are ~2 KiB of path data each. After a page is
// assembled, every repeated inline mark collapses to a `<use>` of one shared
// `<symbol>` appended before `</body>`, which keeps the uncompressed payload
// (what the wasm-mode perf budget measures) flat no matter how many tab groups
// a page carries. Single-occurrence marks stay inline: a symbol block would
// cost more bytes than it saves.
const BRAND_ICON_BY_PATH = new Map(Object.entries(BRAND_ICONS).map(([name, d]) => [d, name]))

function dedupeBrandIcons(html) {
  const counts = new Map()
  const pattern =
    /<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="([^"]+)"\/><\/svg>/g
  for (const [, d] of html.matchAll(pattern)) {
    const name = BRAND_ICON_BY_PATH.get(d)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const shared = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name))
  if (shared.size === 0) return html
  const deduped = html.replace(pattern, (match, d) => {
    const name = BRAND_ICON_BY_PATH.get(d)
    if (!name || !shared.has(name)) return match
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><use href="#brand-icon-${name}"/></svg>`
  })
  const symbols = [...shared]
    .map((name) => `<symbol id="brand-icon-${name}" viewBox="0 0 24 24"><path d="${BRAND_ICONS[name]}"/></symbol>`)
    .join('')
  return deduped.replace('</body>', `<svg hidden aria-hidden="true">${symbols}</svg></body>`)
}

// A tabbed block may carry ordinary shell around the command that changes per
// manager: the Vite+ walkthrough needs `mkdir`, `cd`, and an `export PATH` in
// the same fence as its install. So each line is translated on its own and
// anything unrecognised is copied through, rather than the fence being required
// to begin with npm.
function translateShellLine(line, pm) {
  const variant = PM_INSTALL_VARIANTS.find((entry) => line.startsWith(entry.npm))
  if (variant) return `${variant[pm]}${line.slice(variant.npm.length)}`
  if (line.startsWith('npx ')) return `${PM_EXEC_PREFIXES[pm]}${line.slice('npx'.length)}`
  return line
}

function pmInstallTabsHtml(npmCommand, groupId) {
  const lines = npmCommand.split('\n')
  // A block whose every line is passed through would render four identical
  // tabs, which is a marker someone added by mistake.
  if (!lines.some((line) => translateShellLine(line, 'pnpm') !== line)) {
    throw new Error(
      `pm tabs block needs a line starting with "npm install --save-dev", "npm install", or "npx", got: ${lines[0]}`,
    )
  }
  const managers = Object.keys(PM_EXEC_PREFIXES)
  const buttons = managers
    .map(
      (pm, index) =>
        `<button type="button" role="tab" id="pm-tab-${groupId}-${pm}" aria-controls="pm-panel-${groupId}-${pm}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-pm="${pm}">${brandIconHtml(pm)}${pm}</button>`,
    )
    .join('')
  const panels = managers
    .map((pm, index) => {
      const command =
        pm === 'npm' ? npmCommand : lines.map((line) => translateShellLine(line, pm)).join('\n')
      return `<div role="tabpanel" id="pm-panel-${groupId}-${pm}" aria-labelledby="pm-tab-${groupId}-${pm}" data-pm="${pm}"${index === 0 ? '' : ' hidden'}><div class="code-block" data-lang="sh">${highlightHtml(command, 'sh')}</div></div>`
    })
    .join('')
  return `<div class="pm-tabs" data-pm-tabs><div class="pm-tabs-bar" role="tablist" aria-label="Package manager">${buttons}</div>${panels}</div>\n`
}

function pageMenuHtml(link) {
  const mdHref = withBase(`${link}.md`)
  const absoluteMd = `${config.origin}${mdHref}`
  const prompt = encodeURIComponent(
    `Read ${absoluteMd} so I can ask questions about this OXC for TSRX documentation page.`,
  )
  return `<div class="page-menu" data-page-menu>
      <button type="button" class="copy-md-button page-menu-main" data-md-href="${mdHref}">Copy page</button>
      <button type="button" class="page-menu-toggle" aria-haspopup="menu" aria-expanded="false" aria-label="More ways to use this page">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <ul class="page-menu-list" role="menu" hidden>
        <li role="none"><button type="button" role="menuitem" class="copy-md-button" data-md-href="${mdHref}">Copy page as Markdown</button></li>
        <li role="none"><a role="menuitem" href="${mdHref}" target="_blank" rel="noreferrer">View as plain Markdown</a></li>
        <li role="none"><a role="menuitem" href="https://chatgpt.com/?hints=search&q=${prompt}" target="_blank" rel="noreferrer">Open in ChatGPT</a></li>
        <li role="none"><a role="menuitem" href="https://claude.ai/new?q=${prompt}" target="_blank" rel="noreferrer">Open in Claude</a></li>
      </ul>
    </div>`
}


// Interactive pipeline: the ASCII diagrams replaced by a step-through where
// every stage shows the real artifact from docs/projection-example.json.
async function loadProjectionExample() {
  try {
    return JSON.parse(await readFile(path.join(docsDir, 'projection-example.json'), 'utf8'))
  } catch {
    return null
  }
}

// Named terminal walkthroughs (docs/generate-transcripts.mjs), embedded on
// pages via <!-- terminal-demo:NAME -->.
async function loadTerminalTranscripts() {
  try {
    return JSON.parse(await readFile(path.join(docsDir, 'terminal-transcripts.json'), 'utf8'))
  } catch {
    return null
  }
}

async function pipelineHtml(kind) {
  const example = await loadProjectionExample()
  if (!example) return '<p><em>Run <code>node docs/generate-projection.mjs</code> to generate the pipeline example.</em></p>'
  const tokensTable = `<div class="table-wrap"><table class="pipeline-tokens"><thead><tr><th>Token</th><th>Bytes</th></tr></thead><tbody>${(
    example.tokens ?? []
  )
    .map(
      (token) =>
        `<tr><td><code>${escapeHtml(token.kind)}</code></td><td>${token.start}–${token.end}</td></tr>`,
    )
    .join('')}</tbody></table></div>`
  const diagnosticsList = `<ul>${example.diagnostics
    .map(
      (diagnostic) =>
        `<li><code>${escapeHtml(diagnostic.code)}</code>: ${escapeHtml(diagnostic.message)} <span class="explorer-span">at your bytes ${diagnostic.labels[0].span.offset}–${diagnostic.labels[0].span.offset + diagnostic.labels[0].span.length}</span></li>`,
    )
    .join('')}</ul>`
  const stages = [
    {
      id: 'source',
      label: 'Your TSRX',
      text: 'The file you wrote, byte for byte. Nothing is changed on disk at any point.',
      body: addTsrxHovers(highlightHtml(example.tsrx, 'tsrx')),
    },
    {
      id: 'scan',
      label: 'Scan',
      text: 'One byte-oriented pass finds every TSRX control token and records its exact position. This is the real overlay for the file above:',
      body: tokensTable,
    },
    {
      id: 'project',
      label: 'Projection',
      text: `The TSRX syntax becomes ${kind === 'format' ? 'formatting-safe markers' : 'valid TSX placeholders'} in an in-memory copy; your code is copied verbatim. This is the actual projection:`,
      body: highlightHtml(example.projected, 'tsx'),
    },
    kind === 'format'
      ? {
          id: 'engine',
          label: 'Oxfmt formats',
          text: 'Canonical Oxfmt parses and lays out that copy exactly once. The markers are designed to survive formatting so nothing about your control flow is lost.',
          body: '',
        }
      : {
          id: 'engine',
          label: 'OXC lints',
          text: 'The real OXC parser and linter run on that copy, exactly once. These are the genuine diagnostics for this file:',
          body: diagnosticsList,
        },
    kind === 'format'
      ? {
          id: 'back',
          label: 'Lift back',
          text: 'A checked single pass converts the formatted copy back into TSRX: markers become @-controls again, raw <code>&lt;style&gt;</code> bytes are restored from your original, and the result must re-scan to the same structure before anything is written.',
          body: '',
        }
      : {
          id: 'back',
          label: 'Mapped back',
          text: 'Every diagnostic is translated to your original bytes. Anything that would point at placeholder code is dropped instead of shown, so errors always land on code you wrote.',
          body: '',
        },
  ]
  const prefix = `pl-${kind}`
  return `<div class="explorer pipeline" data-explorer>
  <div class="explorer-tabs pipeline-tabs" role="tablist" aria-label="${kind === 'format' ? 'Format' : 'Lint'} pipeline stages">
    ${stages
      .map(
        (stage, index) =>
          `<button type="button" role="tab" id="${prefix}-tab-${stage.id}" aria-controls="${prefix}-panel-${stage.id}" aria-selected="${index === 0}" ${index === 0 ? '' : 'tabindex="-1"'}><span class="pipeline-step" aria-hidden="true">${index + 1}</span>${stage.label}</button>`,
      )
      .join('\n')}
  </div>
  ${stages
    .map(
      (stage, index) =>
        `<div class="explorer-panel" role="tabpanel" id="${prefix}-panel-${stage.id}" aria-labelledby="${prefix}-tab-${stage.id}" ${index === 0 ? '' : 'hidden'}><p class="pipeline-text">${stage.text}</p>${stage.body}</div>`,
    )
    .join('\n')}
</div>`
}

// A page whose subject is not shipped says so directly under its title, in the
// same words every time, so a reader never has to infer status from prose.
const PAGE_STATUS = {
  proposal: {
    label: 'Proposal',
    text: 'Nothing on this page is required to use @tsrx/oxc. It is a design written down here and implemented in this repository only: no released OXC, Oxlint, Oxfmt, Vite+, or VS Code build reads it, and nothing has been submitted upstream.',
  },
}

function statusBannerHtml(status) {
  const entry = PAGE_STATUS[status]
  if (!entry) return ''
  return `<aside class="page-status page-status-${status}"><span class="page-status-label">${escapeHtml(
    entry.label,
  )}</span><span class="page-status-text">${escapeHtml(entry.text)}</span></aside>`
}

function renderDocPage({ page, article, headings, pageIndex, flat, leadWords = 0 }) {
  const banner = statusBannerHtml(page.status)
  const withBanner = banner
    ? article.replace(/(<\/h1>\n?)/, (match) => `${match}${banner}`)
    : article
  const main = `
<div class="layout">
  <div id="sidebar-backdrop" class="sidebar-backdrop" hidden></div>
  <aside id="sidebar" class="sidebar" aria-label="Sidebar">
    <nav aria-label="Docs navigation">
      ${sidebarHtml(page.link)}
    </nav>
  </aside>
  <main id="main-content" class="content">
    <div class="doc-toolbar">${pageMenuHtml(page.link)}</div>
    <article class="doc">
      ${withBanner}
    </article>
    ${prevNextHtml(pageIndex, flat)}
  </main>
  <aside class="aside" aria-label="Page outline">${outlineHtml(headings, leadWords)}</aside>
</div>`
  return pageShell({
    title: page.title,
    description: page.description,
    pathname: page.link,
    shell: 'doc',
    bodyClass: 'doc-page',
    header: headerHtml(),
    main,
  })
}

// The demo snippets live in docs/demo-sources.mjs so the clickable examples
// that derive variants from them cannot drift out of sync.

// Pre-generated real --type-aware output for the "Type-aware lint" example. The
// browser wasm engine cannot host tsgolint, so the published site replays this
// committed report instead of leaving the example dead. It ships as its own
// asset, fetched only when the example is clicked, because the home page is
// held to a frozen transfer budget it must not spend on an unclicked example.
const typeErrorExample = JSON.parse(
  await readFile(path.join(docsDir, 'type-error-example.json'), 'utf8'),
)
// The report's byte offsets only line up with the snippet it was generated
// from, so a snippet edit without a regenerate would underline the wrong
// bytes. Fail the build instead of shipping that.
if (typeErrorExample.tsrx !== typeAwareCode) {
  throw new Error(
    'docs/type-error-example.json is stale: the demo snippet changed. Re-run node docs/generate-type-error.mjs',
  )
}
const typeErrorAsset = JSON.stringify({
  tsrx: typeErrorExample.tsrx,
  note: typeErrorExample.note,
  pregeneratedNote: typeErrorExample.pregeneratedNote,
  ruleCount: typeErrorExample.ruleCount,
  parseCount: typeErrorExample.parseCount,
  diagnostics: typeErrorExample.diagnostics,
})

async function renderHomePage({ description }) {
  const hero = config.hero
  const main = `
<main id="main-content" class="home">
  <section class="hero">
    <img class="hero-logo" src="${withBase('/assets/logo.svg')}" alt="" width="64" height="64" />
    <h1 class="hero-name">${hero.name}</h1>
    <p class="hero-text">${hero.text}</p>
    <p class="hero-tagline">${hero.tagline}</p>
    <div class="hero-actions">
      ${hero.actions
        .map(
          (action) =>
            `<a class="action action-${action.theme}" href="${withBase(action.link)}">${action.text}</a>`,
        )
        .join('\n')}
    </div>
  </section>
  <section class="band" aria-label="TSRX example">
    <div class="code-panel" id="hero-demo">
      <div class="code-panel-bar">
        <span class="code-panel-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="code-panel-file">src/TaskList.tsrx</span>
        <span class="code-panel-hint" id="demo-hint"></span>
        <span class="code-panel-actions" id="demo-actions" hidden>
          <button type="button" class="demo-button" id="pg-scenario-clean">Clean</button>
          <button type="button" class="demo-button" id="pg-scenario-lint">Lint findings</button>
          <button type="button" class="demo-button" id="pg-scenario-messy">Messy → Format</button>
          <button type="button" class="demo-button" id="pg-scenario-types">Type-aware lint</button>
        </span>
      </div>
      <div class="code-panel-editor" id="demo-editor">
        ${highlightHtml(heroCode, 'tsrx')}
      </div>
      <div class="code-panel-status">
        <span id="demo-status" aria-live="polite">pre-generated example · static preview</span>
        <span id="demo-meta">native lint and format run only on the local development server</span>
      </div>
    </div>
    <p class="pg-note demo-scenario-note" id="pg-scenario-note" hidden></p>
  </section>
  <section class="home-bench" aria-label="Headline performance">
    <h2>Fast, and it stays fast</h2>
    <p>Every number below is read from a committed benchmark report, and every one is a release gate: cross a frozen budget and the release fails.</p>
    <h3 class="home-bench-sub">Lint the same 1,000 files, three tools</h3>
    ${await comparativeChartHtml()}
    <h3 class="home-bench-sub">Release gates we ship against</h3>
    ${await homeBenchmarksHtml()}
    <p class="home-bench-caption">Measured ${reportDate} on one machine. Your hardware will differ.</p>
    <p class="home-bench-link"><a href="${withBase('/reference/benchmarks')}">See every gate and report →</a></p>
  </section>
  <section class="features" aria-label="Feature highlights">
    <ul class="features-grid">
      ${config.features
        .map(
          (feature) => `
      <li class="feature">
        <span class="feature-icon">${feature.icon}</span>
        <h2 class="feature-title">${feature.title}</h2>
        <p class="feature-details">${feature.details}</p>
      </li>`,
        )
        .join('\n')}
    </ul>
  </section>
  <footer class="home-footer">
    <p class="footer-links"><a href="${config.repository}" target="_blank" rel="noreferrer">GitHub<span class="visually-hidden"> (opens in new tab)</span></a> · <a href="https://www.npmjs.com/package/@tsrx/oxc" target="_blank" rel="noreferrer">@tsrx/oxc<span class="visually-hidden"> (opens in new tab)</span></a></p>
    ${footerBadge}
    <p class="footer-disclaimer">${config.footer.disclaimer}</p>
  </footer>
</main>`
  return pageShell({
    title: config.title,
    description,
    pathname: '/',
    shell: 'home',
    bodyClass: 'home-page',
    header: headerHtml(),
    main,
  })
}

const PLAYGROUND_IDLE_NOTE =
  'Each example edits the file and runs the real engines; the note here explains which flags were used.'

// Two shapes for the same bar. A build that ships the in-browser engine sends
// the controls down visible and marked as still starting: hiding them until the
// engine is up is what made a phone look broken for six seconds. A build without
// the engine keeps them hidden, because there they never become usable at all.
function playgroundControlsHtml() {
  const buttons = [
    ['clean', 'Clean'],
    ['lint', 'Lint findings'],
    ['messy', 'Messy → Format'],
    ['types', 'Type-aware lint'],
    ['silence', 'Silence a rule'],
    ['config', 'Custom config'],
  ]
    .map(
      ([name, label]) =>
        `<button type="button" class="demo-button" id="pg-scenario-${name}">${label}</button>`,
    )
    .join('\n        ')
  if (!wasmDemo) {
    return `<div class="pg-toolbar pg-examples-bar" id="pg-side" hidden>
      <div class="pg-examples" role="group" aria-label="Clickable examples">
        <span class="pg-examples-label" id="pg-engine-label">Examples</span>
        ${buttons}
      </div>
      <p class="pg-note" id="pg-scenario-note" data-idle="${escapeHtml(PLAYGROUND_IDLE_NOTE)}">${PLAYGROUND_IDLE_NOTE}</p>
    </div>`
  }
  return `<div class="pg-toolbar pg-examples-bar" id="pg-side" data-engine="starting">
      <div class="pg-examples" role="group" aria-label="Clickable examples" aria-busy="true">
        <span class="pg-examples-label" id="pg-engine-label">Examples · starting…</span>
        ${buttons}
      </div>
      <p class="pg-note" id="pg-scenario-note" role="status" data-idle="${escapeHtml(PLAYGROUND_IDLE_NOTE)}">The in-browser engine is still starting. Tap an example now and it runs as soon as the engine is ready.</p>
    </div>`
}

function renderPlaygroundPage() {
  const main = `
<main id="main-content" class="home playground-page">
  <section class="pg" aria-label="Playground">
    <header class="pg-topbar">
      <h1 class="pg-title">TSRX Playground</h1>
      <p class="pg-tagline">Real <code>oxc-tsrx</code> · <code>oxc-tsrx-fmt</code>. <span id="pg-mode-note">On the published static preview, output is pre-generated; run the local development server for live editing.</span></p>
    </header>
    ${playgroundControlsHtml()}
    <div class="pg-panes">
      <div class="code-panel pg-panel" id="hero-demo">
        <div class="code-panel-bar">
          <span class="code-panel-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="code-panel-file">playground.tsrx</span>
          <span class="code-panel-hint" id="demo-hint"></span>
          <span class="code-panel-actions" id="demo-actions" hidden>
            <button type="button" class="demo-button" id="demo-share">Share</button>
            <button type="button" class="demo-button" id="demo-format">Format</button>
            <button type="button" class="demo-button" id="demo-reset">Reset</button>
          </span>
        </div>
        <div class="code-panel-editor" id="demo-editor">
          ${highlightHtml(playgroundCode, 'tsrx')}
        </div>
        <div class="code-panel-status">
          <span id="demo-status" aria-live="polite">pre-generated example · static preview</span>
          <span id="demo-meta">native lint and format run only on the local development server</span>
        </div>
      </div>
      <div class="code-panel pg-output" id="pg-output" data-explorer hidden>
        <div class="code-panel-bar pg-output-tabs" role="tablist" aria-label="Engine output">
          <span class="pg-pane-label" aria-hidden="true">Engine output</span>
          <button type="button" role="tab" id="pg-tab-projected" aria-controls="pg-panel-projected" aria-selected="true">Projected TSX</button>
          <button type="button" role="tab" id="pg-tab-structure" aria-controls="pg-panel-structure" aria-selected="false" tabindex="-1">Structure</button>
          <button type="button" role="tab" id="pg-tab-diagnostics" aria-controls="pg-panel-diagnostics" aria-selected="false" tabindex="-1">Diagnostics</button>
          <button type="button" role="tab" id="pg-tab-formatted" aria-controls="pg-panel-formatted" aria-selected="false" tabindex="-1">Formatted</button>
        </div>
        <div class="pg-output-body">
          <div role="tabpanel" id="pg-panel-projected" aria-labelledby="pg-tab-projected"><p class="pg-note pg-output-note">The legal TSX the real projection engine hands to OXC: your bytes copied verbatim, TSRX controls replaced by scaffold markers.</p><div class="pg-output-code" id="pg-projected"></div></div>
          <div role="tabpanel" id="pg-panel-structure" aria-labelledby="pg-tab-structure" hidden><p class="pg-note pg-output-note">The structural overlay from the byte-oriented scan: every TSRX control token and its byte span.</p><div class="pg-output-code" id="pg-structure"></div></div>
          <div role="tabpanel" id="pg-panel-diagnostics" aria-labelledby="pg-tab-diagnostics" hidden><p class="pg-note pg-output-note">Raw <code>oxc-tsrx --format=json</code> diagnostics, mapped to your original bytes.</p><div class="pg-output-code" id="pg-diagnostics"></div></div>
          <div role="tabpanel" id="pg-panel-formatted" aria-labelledby="pg-tab-formatted" hidden><p class="pg-note pg-output-note">What <code>oxc-tsrx-fmt</code> produces for the current source.</p><div class="pg-output-code" id="pg-formatted"></div></div>
        </div>
        <div class="code-panel-status"><span id="pg-output-status">output follows the editor as you type</span></div>
      </div>
    </div>
  </section>
</main>`
  return pageShell({
    title: 'Playground',
    description:
      'A static TSRX preview that becomes an interactive native lint and format playground on the localhost development server.',
    pathname: '/playground',
    shell: 'playground',
    bodyClass: 'home-page',
    header: headerHtml(),
    main,
  })
}

async function build() {
  execFileSync(process.execPath, [path.join(docsDir, 'render-diagrams.mjs')], { stdio: 'inherit' })
  await validateOutputDirectory()
  await rm(outDir, { recursive: true, force: true })
  await mkdir(siteDir, { recursive: true })

  const flat = config.sidebar.flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.text })),
  )
  const supplementalPages = [
    {
      text: 'Embedded CSS boundary',
      link: '/architecture/embedded-css-boundary',
      group: 'Architecture',
    },
  ]
  const pages = [...flat, ...supplementalPages]
  const searchDocs = []

  const markdownPages = []
  for (const [pageIndex, item] of pages.entries()) {
    const sourcePath = path.join(docsDir, `${item.link.replace(/^\//, '')}.md`)
    const source = await readFile(sourcePath, 'utf8')
    const { data, body: sourceBody } = parseFrontmatter(source)
    // Swap pm-install blocks for placeholders before markdown rendering; the
    // markdown twin keeps only the plain npm fence with the marker stripped.
    const pmInstallBlocks = []
    let body = sourceBody.replace(PM_TABS_PATTERN, (match, command) => {
      pmInstallBlocks.push(command)
      return `<!-- pm-tabs:${pmInstallBlocks.length - 1} -->`
    })
    // Same trick for a setup report: the component is built from the fence, so
    // the fence has to be read before markdown turns it into highlighted spans.
    const setupReportBlocks = []
    body = body.replace(SETUP_REPORT_PATTERN, (_match, report) => {
      setupReportBlocks.push(report)
      return `<!-- setup-rows:${setupReportBlocks.length - 1} -->`
    })
    let exportedBody = sourceBody
      .replace(/<!-- pm-(?:install|exec) -->\r?\n/g, '')
      .replace(/<!-- setup-report -->\r?\n/g, '')
    const page = {
      link: item.link,
      group: item.group,
      title: data.title || item.text,
      description: data.description || '',
      status: data.status || '',
    }
    const headings = []
    const marked = createMarked(makeSlugger(), headings)
    let article = marked.parse(body)
    article = article
      .replaceAll('<table>', '<div class="table-wrap"><table>')
      .replaceAll('</table>', '</table></div>')
      // A markdown table that opens its header row with a blank cell is a
      // cross-tab: the first column carries row labels, so it has no column
      // name to print. Marked still emits `<th></th>` for it, and a header
      // cell with no accessible text is a header that announces nothing, which
      // axe flags as empty-table-header. The corner cell of a cross-tab is a
      // plain `td` in the HTML spec's own example, so emit that instead.
      .replace(/<th([^>]*)>\s*<\/th>/g, '<td$1></td>')
    if (article.includes('<!-- benchmarks:auto -->')) {
      const benchmarkMarkdown = await benchmarksSectionsMarkdown()
      article = article.replace('<!-- benchmarks:auto -->', await benchmarksSectionsHtml())
      exportedBody = exportedBody.replace('<!-- benchmarks:auto -->', benchmarkMarkdown)
      const anchor = headings.findIndex((heading) => heading.text === 'How a number gets on this page')
      headings.splice(anchor === -1 ? headings.length : anchor, 0, ...benchmarkHeadings)
    }
    if (article.includes('<!-- projection-explorer -->')) {
      article = article.replace('<!-- projection-explorer -->', await projectionExplorerHtml())
    }
    if (article.includes('<!-- cli-builder -->')) {
      article = article.replace('<!-- cli-builder -->', cliBuilderHtml())
      exportedBody = exportedBody.replace('<!-- cli-builder -->', cliBuilderMarkdown)
    }
    if (article.includes('<!-- rule-sees -->')) {
      article = article.replace('<!-- rule-sees -->', ruleSeesHtml())
      exportedBody = exportedBody.replace('<!-- rule-sees -->', ruleSeesMarkdown)
    }
    if (article.includes('<!-- how-it-works -->')) {
      article = article.replace('<!-- how-it-works -->', await howItWorksHtml())
      exportedBody = exportedBody.replace('<!-- how-it-works -->', howItWorksMarkdown)
    }
    if (article.includes('<!-- terminal-demo -->')) {
      const example = await loadProjectionExample()
      article = article.replace('<!-- terminal-demo -->', terminalDemoHtml(example))
      exportedBody = exportedBody.replace('<!-- terminal-demo -->', terminalDemoMarkdown(example))
    }
    for (const match of article.matchAll(/<!-- extension:([a-z]+) -->/g)) {
      const extension = EXTENSIONS[match[1]]
      if (!extension) throw new Error(`unknown extension marker: ${match[0]}`)
      article = article.replace(match[0], extensionCardHtml(match[1]))
      exportedBody = exportedBody.replace(
        match[0],
        `[${extension.name} (\`${extension.id}\`)](https://marketplace.visualstudio.com/items?itemName=${extension.id}): ${extension.summary}`,
      )
    }
    for (const match of article.matchAll(/<!-- terminal-demo:([a-z0-9-]+) -->/g)) {
      const demo = (await loadTerminalTranscripts())?.demos?.[match[1]]
      const generator = 'docs/generate-transcripts.mjs'
      article = article.replace(match[0], terminalDemoHtml(demo, generator))
      exportedBody = exportedBody.replace(match[0], terminalDemoMarkdown(demo, generator))
    }
    if (article.includes('<!-- matrix-filter -->')) {
      article = matrixFilterHtml(article)
    }
    if (article.includes('<!-- review-route -->')) {
      article = reviewRouteHtml(article)
    }
    if (article.includes('<!-- chooser -->')) {
      article = chooserHtml(article)
    }
    for (const match of article.matchAll(/<!-- filetree:([a-z0-9/._-]+) -->/g)) {
      article = article.replace(match[0], await filetreeHtml(match[1]))
      exportedBody = exportedBody.replace(match[0], filetreeMarkdown(match[1]))
    }
    for (const [index, report] of setupReportBlocks.entries()) {
      article = article.replace(`<!-- setup-rows:${index} -->`, setupReportHtml(report))
    }
    if (article.includes('<!-- details:')) {
      article = disclosureHtml(article)
      exportedBody = disclosureMarkdown(exportedBody)
    }
    if (article.includes('<!-- editor-replay -->')) {
      article = article.replace('<!-- editor-replay -->', await editorReplayHtml())
      exportedBody = exportedBody.replace('<!-- editor-replay -->', await editorReplayMarkdown())
    }
    if (article.includes('<!-- annotate-config -->')) {
      article = annotateConfigBlocks(article)
    }
    if (article.includes('<!-- pipeline:lint -->')) {
      article = article.replace('<!-- pipeline:lint -->', await pipelineHtml('lint'))
    }
    if (article.includes('<!-- pipeline:format -->')) {
      article = article.replace('<!-- pipeline:format -->', await pipelineHtml('format'))
    }
    for (const match of article.matchAll(/<!-- diagram:([a-z0-9-]+) -->/g)) {
      article = article.replace(match[0], await diagramHtml(match[1]))
    }
    for (const [index, command] of pmInstallBlocks.entries()) {
      article = article.replace(`<!-- pm-tabs:${index} -->`, pmInstallTabsHtml(command, index))
    }
    article = addGlossary(article)
    searchDocs.push(...extractSections(new Marked(), exportedBody, page))
    const leadWords = annotateReadingTime(article, headings)
    const html = renderDocPage({
      page,
      article,
      headings,
      leadWords,
      pageIndex: pageIndex < flat.length ? pageIndex : -1,
      flat,
    })
    const outPath = path.join(siteDir, `${item.link.replace(/^\//, '')}.html`)
    await mkdir(path.dirname(outPath), { recursive: true })
    await writeFile(outPath, dedupeBrandIcons(html))
    // Raw markdown twin for the copy-as-Markdown button and llms-full.txt.
    await writeFile(outPath.replace(/\.html$/, '.md'), exportedBody)
    markdownPages.push({ ...page, body: exportedBody })
  }

  // llms.txt index and llms-full.txt corpus (https://llmstxt.org).
  const llmsIndex = [
    `# ${config.title}`,
    '',
    `> ${config.description}`,
    '',
    ...config.sidebar.map((group) =>
      [
        `## ${group.text}`,
        '',
        ...group.items.map((item) => {
          const page = markdownPages.find((candidate) => candidate.link === item.link)
          return `- [${item.text}](${withBase(`${item.link}.md`)})${page?.description ? `: ${page.description}` : ''}`
        }),
        '',
      ].join('\n'),
    ),
  ].join('\n')
  await writeFile(path.join(siteDir, 'llms.txt'), llmsIndex)
  await writeFile(
    path.join(siteDir, 'llms-full.txt'),
    markdownPages
      .map((page) => `<!-- ${page.group} / ${page.title} (${page.link}) -->\n\n${page.body}`)
      .join('\n\n---\n\n'),
  )

  const home = parseFrontmatter(await readFile(path.join(docsDir, 'index.md'), 'utf8'))
  await writeFile(
    path.join(siteDir, 'index.html'),
    dedupeBrandIcons(await renderHomePage({ description: home.data.description })),
  )
  await writeFile(path.join(siteDir, 'playground.html'), renderPlaygroundPage())

  await cp(path.join(docsDir, 'assets'), path.join(siteDir, 'assets'), { recursive: true })
  // Ship one stylesheet per page shell, without comments (the source keeps
  // them). The home page has a hard transfer budget in docs/verify.mjs, and
  // every byte here is on its critical path, so a page gets the rules it can
  // match and nothing else.
  //
  // The unsplit stylesheet still ships, at the path it has always had, and it is
  // deliberately not linked by anything this build emits. It is here for the
  // documents that were served BEFORE the split, which link
  // `/assets/style.css`: HTML is served `max-age=0, must-revalidate`, but an
  // open tab, a back/forward entry, or a within-session memory hit can still
  // render a pre-split document, and when this file was deleted from the output
  // that document lost every rule it had and came out as naked HTML. Deleting it
  // was the tidier output and the worse deploy.
  //
  // It costs a new visitor nothing, because no shell references it. If you are
  // adding a page, link a `style-<shell>.css` bundle; this copy is compatibility
  // ballast, not the stylesheet.
  await writeFile(
    path.join(siteDir, 'assets', 'style.css'),
    styleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n{3,}/g, '\n\n'),
  )
  for (const [shell, lines] of styleBundles) {
    await writeFile(
      path.join(siteDir, 'assets', `style-${shell}.css`),
      lines
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\n{3,}/g, '\n\n'),
    )
  }
  await rolldownBuild({
    input: path.join(docsDir, 'demo-highlighter-entry.mjs'),
    platform: 'browser',
    output: {
      format: 'esm',
      file: path.join(siteDir, 'assets', 'demo-highlighter.js'),
      minify: true,
    },
  })

  // In-browser demo engine: bundle the NAPI-RS wasm binding when it has been
  // built (npm run docs:wasm). Without it the site falls back to the static
  // preview contract, exactly as before the engine existed. The binary is
  // detected at module scope (wasmDemo) because the page markup depends on it.
  if (process.env.OXC_TSRX_REQUIRE_WASM === '1' && !wasmDemo) {
    throw new Error(`required docs WebAssembly artifact is missing: ${wasmBinary}`)
  }
  if (wasmDemo) {
    await mkdir(path.join(siteDir, 'assets', 'demo-wasm'), { recursive: true })
    await rolldownBuild({
      input: path.join(docsDir, 'demo-wasm-engine-entry.mjs'),
      platform: 'browser',
      output: {
        format: 'esm',
        file: path.join(siteDir, 'assets', 'demo-wasm', 'engine.js'),
        minify: true,
      },
    })
    await rolldownBuild({
      input: path.join(docsDir, 'demo-wasm-worker-entry.mjs'),
      platform: 'browser',
      output: {
        format: 'esm',
        file: path.join(siteDir, 'assets', 'demo-wasm', 'wasi-worker-browser.mjs'),
        minify: true,
      },
    })
    await cp(wasmBinary, path.join(siteDir, 'assets', 'demo-wasm', 'demo-wasm.wasm32-wasi.wasm'))
  }
  await rm(path.join(siteDir, 'assets', 'logos'), { recursive: true, force: true })
  await cp(
    path.join(docsDir, '..', 'node_modules', 'minisearch', 'dist', 'es'),
    path.join(siteDir, 'assets', 'minisearch'),
    { recursive: true },
  )
  await writeFile(path.join(siteDir, 'search-index.json'), JSON.stringify(searchDocs))
  await writeFile(path.join(siteDir, 'type-error-example.json'), `${typeErrorAsset}\n`)
  await writeFile(
    path.join(siteDir, 'demo-capabilities.json'),
    `${JSON.stringify({
      ok: true,
      mode: wasmDemo ? 'wasm' : 'static',
      native: false,
      wasm: wasmDemo,
      typeAware: false,
      projection: wasmDemo,
      completions: false,
    })}\n`,
  )
  // Site navigation links are extensionless (/guide/introduction); Vercel needs
  // cleanUrls to resolve them to the .html files. The COOP/COEP headers give the wasm demo
  // engine the cross-origin isolation SharedArrayBuffer requires; the site
  // loads no cross-origin subresources, so they cost nothing.
  await writeFile(
    path.join(outDir, 'vercel.json'),
    `${JSON.stringify({
      cleanUrls: true,
      trailingSlash: false,
      // /integrations/vite-plus is a real page again, so the redirect that
      // stood in for it while the walkthrough lived in the getting-started
      // guide is gone: a redirect here would shadow the page it points at. The
      // README published in oxc-tsrx@0.1.5 links that path, and an npm tarball
      // is immutable, so the path itself has to keep resolving.
      redirects: [],
      // Guessless docs are now embedded as static files under /guessless/ during
      // the site build (see .github/workflows/site-artifact.yml), so no rewrites
      // are needed. Vercel's cleanUrls handles /guessless -> /guessless/index.html.
      rewrites: [],
      headers: [
        {
          source: '/(.*)',
          headers: [
            { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          ],
        },
      ],
    })}\n`,
  )

  const publicPaths = ['/', ...pages.map(({ link }) => link), '/playground']
  await writeFile(
    path.join(outDir, 'robots.txt'),
    `User-agent: *\nAllow: ${base}\nSitemap: ${canonicalUrl('/sitemap.xml')}\n`,
  )
  await writeFile(
    path.join(siteDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${publicPaths
      .map((pathname) => `  <url><loc>${canonicalUrl(pathname)}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
  )

  // With a non-root base the domain root is not part of the docs site, so it
  // gets a minimal landing page that points visitors at the docs.
  if (trimmedBase) {
    const host = new URL(config.origin).host
    await writeFile(
      path.join(outDir, 'index.html'),
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="description" content="Projects served at ${host}." />
<title>${host}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #fdfdfd; color: #1a1a1a; }
main { text-align: center; padding: 2rem; }
h1 { font-size: 1.05rem; font-weight: 600; letter-spacing: 0.01em; margin: 0 0 1.5rem; color: #666; }
a { color: inherit; text-decoration: none; border: 1px solid #d4d4d4; border-radius: 8px; padding: 0.65rem 1.1rem; display: inline-block; font-size: 1rem; }
a:hover { border-color: #888; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #ededed; }
  h1 { color: #999; }
  a { border-color: #333; }
  a:hover { border-color: #777; }
}
</style>
</head>
<body>
<main>
<h1>${host}</h1>
<a href="${trimmedBase}">${escapeHtml(config.title)} &rarr;</a>
</main>
</body>
</html>
`,
    )
  }

  console.log(`built ${publicPaths.length} pages, ${searchDocs.length} search sections -> ${outDir}`)
}

await build()
