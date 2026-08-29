// Minimal static file server for the built docs site. Run: node docs/serve.mjs [port]
// Binds 127.0.0.1 explicitly so an already-taken port fails loudly instead of
// silently coexisting on another interface.
//
// It also exposes a small demo API for the home-page playground, backed by the
// REAL native binaries (target/release/oxc-tsrx and oxc-tsrx-fmt) and the same
// shiki highlighter the build uses. If the binaries are not built, the API
// reports native: false and the playground stays a static example.
import { execFile } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from './site.config.mjs'
import { resolveTsgolintExecutable } from '../tests/helpers/tsgolint-path.mjs'
import {
  DEMO_TSCONFIG,
  JSX_CONTRACT,
  TYPE_PREFIX,
  normalizeDiagnostics,
} from './demo-type-lane.mjs'

const docsDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(docsDir, 'dist')
const repoRoot = path.join(docsDir, '..')
const requestedPort = Number(process.argv[2] ?? 4519)
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error(`invalid docs port: ${process.argv[2] ?? requestedPort}`)
}
// '' when the site is served at the root, '/some/prefix' otherwise.
const baseSegments = config.base.split('/').filter(Boolean)
const basePath = baseSegments.length > 0 ? `/${baseSegments.join('/')}` : ''
let boundPort = requestedPort
const allowedHosts = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`])
const allowedOrigins = () => new Set([...allowedHosts()].map((host) => `http://${host}`))

const lintBin =
  process.env.OXC_TSRX_LINT_BIN ?? path.join(repoRoot, 'target', 'release', 'oxc-tsrx')
const fmtBin =
  process.env.OXC_TSRX_FORMAT_BIN ?? path.join(repoRoot, 'target', 'release', 'oxc-tsrx')
const projectionBin =
  process.env.OXC_TSRX_PROJECTION_BIN ??
  path.join(docsDir, 'tools', 'projection-dump', 'target', 'release', 'projection-dump')
const nativeAvailable = () => existsSync(lintBin) && existsSync(fmtBin)
const wasmAvailable = () =>
  existsSync(path.join(distDir, ...baseSegments, 'assets', 'demo-wasm', 'engine.js'))
// Type-aware lint needs the tsgolint executable resolvable from the workspace,
// and the linted file must live inside an inferable TypeScript program, which
// is why demo temp files go under the repo root instead of the OS tmpdir.
const typeAwareAvailable = () => resolveTsgolintExecutable(repoRoot) !== null
const demoTmpDir = path.join(repoRoot, '.docs-demo-tmp')

const MAX_DEMO_BYTES = 64 * 1024
const MAX_API_CONCURRENCY = 4
let activeApiRequests = 0

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length'])
    if (Number.isFinite(contentLength) && contentLength > MAX_DEMO_BYTES) {
      request.resume()
      reject(new Error('demo source too large'))
      return
    }
    let size = 0
    const chunks = []
    let rejected = false
    request.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_DEMO_BYTES) {
        rejected = true
        reject(new Error('demo source too large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
    request.on('aborted', () => reject(new Error('request aborted')))
  })
}

function run(bin, args, stdin) {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
      },
    )
    if (stdin !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
  })
}

// Body may be raw TSRX text (hero demo) or JSON:
// { source, config?, filters?: [{severity: allow|warn|deny, rule}], typeAware?, typeCheck? }
function parseLintRequest(body) {
  if (body.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(body)
      if (typeof parsed.source === 'string') return parsed
    } catch {}
  }
  return { source: body }
}

const SEVERITY_FLAGS = { allow: '-A', warn: '-W', deny: '-D' }

async function apiLint(body) {
  const request = parseLintRequest(body)
  const typeLane = Boolean(request.typeAware || request.typeCheck)
  if (typeLane && !typeAwareAvailable()) {
    return { error: 'type-aware lint is unavailable: oxlint-tsgolint is not resolvable' }
  }
  await mkdir(demoTmpDir, { recursive: true })
  const requestDir = await mkdtemp(path.join(demoTmpDir, 'request-'))
  const file = path.join(requestDir, 'demo.tsrx')
  try {
    if (typeLane) {
      await writeFile(path.join(requestDir, 'jsx.d.ts'), JSX_CONTRACT)
      await writeFile(path.join(requestDir, 'tsconfig.json'), DEMO_TSCONFIG)
    }
    const prefixBytes = typeLane ? Buffer.byteLength(TYPE_PREFIX) : 0
    await writeFile(file, typeLane ? TYPE_PREFIX + request.source : request.source)
    const args = ['--format=json']
    if (request.typeCheck) args.push('--type-check')
    else if (request.typeAware) args.push('--type-aware')
    if (typeof request.config === 'string' && request.config.trim()) {
      const configFile = path.join(requestDir, '.oxlintrc.json')
      await writeFile(configFile, request.config)
      args.push('--config', configFile)
    }
    for (const filter of Array.isArray(request.filters) ? request.filters : []) {
      const flag = SEVERITY_FLAGS[filter?.severity]
      if (flag && typeof filter.rule === 'string' && /^[\w@/-]+$/.test(filter.rule)) {
        args.push(flag, filter.rule)
      }
    }
    args.push(file)
    const startedAt = performance.now()
    const { code, stdout, stderr } = await run(lintBin, args)
    const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10
    if (code === 2 || !stdout.trim()) {
      return { error: (stderr.trim() || 'lint failed').split('\n')[0] }
    }
    const report = JSON.parse(stdout)
    return {
      diagnostics: normalizeDiagnostics(report.diagnostics, prefixBytes),
      parseCount: report.oxcTsrx?.parseCount ?? null,
      suppressed: report.oxcTsrx?.diagnosticsSuppressed ?? 0,
      ruleCount: report.number_of_rules ?? null,
      typeAware: Boolean(report.oxcTsrx?.typeAware),
      elapsedMs,
    }
  } finally {
    await rm(requestDir, { recursive: true, force: true })
  }
}

async function apiProject(source) {
  if (!existsSync(projectionBin)) {
    return { error: 'projection dump binary is not built' }
  }
  const { code, stdout, stderr } = await run(projectionBin, [], source)
  if (code !== 0) return { error: (stderr.trim() || 'projection failed').split('\n')[0] }
  try {
    return JSON.parse(stdout)
  } catch {
    return { error: 'projection output was not valid JSON' }
  }
}

// Real TypeScript completions: project the TSRX to its type-semantic TSX
// (authored bytes verbatim), locate the cursor by unique context, and ask the
// TypeScript language service.
let tsModule = null
async function createTsService(text) {
  tsModule ??= import('typescript').then((module) => module.default)
  const ts = await tsModule
  const fileName = '/oxc-tsrx-demo.tsx'
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    strict: false,
  }
  const defaultLib = ts.getDefaultLibFilePath(options)
  const libDir = path.dirname(defaultLib)
  const allowedLib = (name) => {
    const resolved = path.resolve(name)
    const relative = path.relative(libDir, resolved)
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      /^lib\..*\.d\.ts$/u.test(path.basename(resolved))
    )
  }
  const host = {
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) =>
      name === fileName
        ? ts.ScriptSnapshot.fromString(text)
        : allowedLib(name) && existsSync(name)
          ? ts.ScriptSnapshot.fromString(readFileSync(name, 'utf8'))
          : undefined,
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => defaultLib,
    fileExists: (name) => name === fileName || (allowedLib(name) && existsSync(name)),
    readFile: (name) =>
      allowedLib(name) && existsSync(name) ? readFileSync(name, 'utf8') : undefined,
  }
  return { ts, fileName, service: ts.createLanguageService(host) }
}


async function tsAtOffset(request) {
  if (
    typeof request.source !== 'string' ||
    !Number.isInteger(request.offset) ||
    request.offset < 0 ||
    request.offset > request.source.length
  ) {
    return null
  }
  const projection = await run(projectionBin, ['--types'], request.source)
  if (projection.code !== 0) return null
  let projected
  try {
    projected = JSON.parse(projection.stdout).projected
  } catch {
    return null
  }
  const before = request.source.slice(0, request.offset)
  let projectedOffset = -1
  for (let ctx = Math.min(64, before.length); ctx >= 3; ctx--) {
    const needle = before.slice(-ctx)
    const first = projected.indexOf(needle)
    if (first !== -1 && projected.indexOf(needle, first + 1) === -1) {
      projectedOffset = first + needle.length
      break
    }
  }
  if (projectedOffset === -1) return null
  const { service, fileName, ts } = await createTsService(projected)
  return { service, fileName, ts, projectedOffset }
}

async function apiQuickInfo(body) {
  let request
  try {
    request = JSON.parse(body)
  } catch {
    return { info: null }
  }
  try {
    const located = await tsAtOffset(request)
    if (!located) return { info: null }
    const quick = located.service.getQuickInfoAtPosition(located.fileName, located.projectedOffset)
    if (!quick) return { info: null }
    const display = located.ts.displayPartsToString(quick.displayParts ?? [])
    if (!display || display.includes('_t0_')) return { info: null }
    return { info: { display, docs: located.ts.displayPartsToString(quick.documentation ?? []) } }
  } catch {
    return { info: null }
  }
}

async function apiComplete(body) {
  let request
  try {
    request = JSON.parse(body)
  } catch {
    return { error: 'bad request' }
  }
  try {
    const located = await tsAtOffset(request)
    if (!located) return { entries: [] }
    const completions = located.service.getCompletionsAtPosition(
      located.fileName,
      located.projectedOffset,
      {},
    )
    return {
      entries: (completions?.entries ?? [])
        .filter((entry) => !entry.name.startsWith('_t0_'))
        .slice(0, 60)
        .map((entry) => ({ name: entry.name, kind: entry.kind })),
    }
  } catch {
    return { error: 'completion failed' }
  }
}

async function apiFormat(source) {
  const startedAt = performance.now()
  const { code, stdout, stderr } = await run(fmtBin, ['fmt', '--stdin-filepath=demo.tsrx'], source)
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10
  if (code !== 0) return { error: (stderr.trim() || 'format failed').split('\n')[0] }
  return { formatted: stdout, elapsedMs }
}

let highlightModule = null
async function apiHighlight(body) {
  let source = body
  let lang = 'tsrx'
  if (body.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(body)
      if (typeof parsed.source === 'string') {
        source = parsed.source
        if (['tsx', 'tsrx', 'json'].includes(parsed.lang)) lang = parsed.lang
      }
    } catch {}
  }
  try {
    highlightModule ??= import('./highlight.mjs')
    const { highlightHtml } = await highlightModule
    return { html: await highlightHtml(source, lang) }
  } catch {
    return { html: null }
  }
}

async function handleApi(request, response, pathname) {
  const json = (status, body) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(JSON.stringify(body))
  }
  if (pathname === '/api/health') {
    json(200, {
      ok: true,
      native: nativeAvailable(),
      typeAware: nativeAvailable() && typeAwareAvailable(),
      projection: existsSync(projectionBin),
      completions: existsSync(projectionBin) && existsSync(path.join(repoRoot, 'node_modules', 'typescript', 'package.json')),
    })
    return
  }
  if (request.method !== 'POST') {
    json(405, { error: 'POST required' })
    return
  }
  let source
  try {
    source = await readBody(request)
  } catch (error) {
    json(413, { error: error.message })
    return
  }
  try {
    if (pathname === '/api/lint') json(200, await apiLint(source))
    else if (pathname === '/api/format') json(200, await apiFormat(source))
    else if (pathname === '/api/highlight') json(200, await apiHighlight(source))
    else if (pathname === '/api/project') json(200, await apiProject(source))
    else if (pathname === '/api/complete') json(200, await apiComplete(source))
    else if (pathname === '/api/quickinfo') json(200, await apiQuickInfo(source))
    else json(404, { error: 'unknown API endpoint' })
  } catch {
    json(500, { error: 'demo request failed' })
  }
}

function capabilities(response) {
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(
    JSON.stringify({
      ok: true,
      mode: nativeAvailable() ? 'native' : wasmAvailable() ? 'wasm' : 'static',
      native: nativeAvailable(),
      wasm: !nativeAvailable() && wasmAvailable(),
      typeAware: nativeAvailable() && typeAwareAvailable(),
      projection: existsSync(projectionBin) || wasmAvailable(),
      completions: existsSync(projectionBin) && existsSync(path.join(repoRoot, 'node_modules', 'typescript', 'package.json')),
    }),
  )
}

function reject(response, status, message, extraHeaders = {}) {
  response
    .writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    })
    .end(JSON.stringify({ error: message }))
}

function sameOriginPost(request) {
  const origin = request.headers.origin
  const fetchSite = request.headers['sec-fetch-site']
  if (origin !== undefined && !allowedOrigins().has(origin)) return false
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false
  return origin !== undefined || fetchSite === 'same-origin'
}

const server = http.createServer((request, response) => {
    // Cross-origin isolation lets the wasm demo engine use SharedArrayBuffer.
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    if (!allowedHosts().has(String(request.headers.host ?? '').toLowerCase())) {
      reject(response, 421, 'loopback Host required')
      return
    }
    let url
    try {
      url = new URL(request.url, `http://${request.headers.host}`)
    } catch {
      reject(response, 400, 'malformed URL')
      return
    }
    if (url.pathname === `${basePath}/demo-capabilities.json`) {
      capabilities(response)
      return
    }
    if (url.pathname.startsWith(`${basePath}/api/`)) {
      if (request.method === 'POST' && !sameOriginPost(request)) {
        reject(response, 403, 'same-origin POST required')
        return
      }
      if (request.method === 'POST' && activeApiRequests >= MAX_API_CONCURRENCY) {
        reject(response, 429, 'demo API is busy', { 'Retry-After': '1' })
        return
      }
      if (request.method === 'POST') activeApiRequests += 1
      void handleApi(request, response, url.pathname.slice(basePath.length)).finally(() => {
        if (request.method === 'POST') activeApiRequests -= 1
      })
      return
    }
    // The build nests the site under the base path inside dist, with the
    // landing page and robots.txt at the root, so URL paths map straight into
    // the output directory exactly as they do in production.
    let publicPath
    try {
      publicPath = decodeURIComponent(url.pathname || '/')
    } catch {
      reject(response, 400, 'malformed path encoding')
      return
    }
    let filePath = path.join(distDir, path.normalize(publicPath))
    const relative = path.relative(distDir, filePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
    if (!existsSync(filePath) && !path.extname(filePath) && existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`
    }
    if (!existsSync(filePath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    response.writeHead(200, {
      'Content-Type': types[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    createReadStream(filePath).pipe(response)
  })

server
  .listen(requestedPort, '127.0.0.1', () => {
    boundPort = server.address().port
    console.log(`docs served at http://127.0.0.1:${boundPort}${basePath}/`)
    console.log(`demo API: ${nativeAvailable() ? 'native binaries found' : 'native binaries missing (static demo)'}`)
  })
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`port ${requestedPort} is already in use — pass another: node docs/serve.mjs <port>`)
      process.exit(1)
    }
    throw error
  })
