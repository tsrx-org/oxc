// Site configuration for the static docs generator (docs/build.mjs).

// The same source tree is published at two places: https://compiled.run/oxc-tsrx
// (a sub-path of a shared domain) and https://oxc.tsrx.dev (its own domain, so
// the site sits at the root). Only the origin and the base path differ, so both
// are read from the environment with the compiled.run values as the defaults.
// With SITE_ORIGIN and SITE_BASE unset the build is byte-identical to before.
const DEFAULT_ORIGIN = 'https://compiled.run'
const DEFAULT_BASE = '/oxc-tsrx/'

// Trailing slashes are stripped so `${origin}${base}` never doubles up.
const origin = (process.env.SITE_ORIGIN ?? DEFAULT_ORIGIN).trim().replace(/\/+$/, '')
if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
  throw new Error(
    `SITE_ORIGIN must be a scheme and host with no path, got: ${process.env.SITE_ORIGIN}`,
  )
}

// Root-absolute, with a trailing slash. '' , '/' and '///' all mean the root.
const normalizeBase = (value) => {
  const segments = value.trim().split('/').filter(Boolean)
  return segments.length > 0 ? `/${segments.join('/')}/` : '/'
}
const base = normalizeBase(process.env.SITE_BASE ?? DEFAULT_BASE)

export default {
  title: 'OXC for TSRX',
  description:
    'Rust-native parsing, linting, formatting, and editor support for .tsrx source through canonical OXC. No fork, no patches, one parse.',
  origin,
  // Root-absolute base path the site is served under, with trailing slash.
  base,
  repository: 'https://github.com/tsrx-org/oxc',
  nav: [
    { text: 'Guide', link: '/guide/introduction' },
    { text: 'Playground', link: '/playground' },
    { text: 'Integrations', link: '/integrations/configuration' },
    { text: 'Architecture', link: '/architecture/rust-oxc-core' },
    { text: 'Reference', link: '/reference/cli' },
    { text: 'GitHub', link: 'https://github.com/tsrx-org/oxc' },
  ],
  sidebar: [
    {
      text: 'Guide',
      items: [
        { text: 'Introduction', link: '/guide/introduction' },
        { text: 'Getting Started', link: '/guide/getting-started' },
        { text: 'Walkthrough (Vite+)', link: '/integrations/vite-plus' },
        { text: 'TSRX Syntax Support', link: '/guide/tsrx-syntax' },
        { text: 'Linting', link: '/guide/linting' },
        { text: 'Formatting', link: '/guide/formatting' },
        { text: 'Parsing', link: '/guide/parsing' },
      ],
    },
    {
      text: 'Integrations',
      items: [
        { text: 'Configuration', link: '/integrations/configuration' },
        { text: 'Editor', link: '/integrations/editor' },
        { text: 'Custom JS Plugins', link: '/integrations/custom-js-plugins' },
      ],
    },
    {
      text: 'Architecture',
      items: [
        { text: 'Rust/OXC Core', link: '/architecture/rust-oxc-core' },
        { text: 'Upstreaming to OXC', link: '/architecture/upstreaming-to-oxc' },
        {
          text: 'Provider Protocol',
          link: '/architecture/provider-protocol',
          tag: 'Proposal',
        },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'CLI', link: '/reference/cli' },
        { text: 'Benchmarks', link: '/reference/benchmarks' },
        { text: 'Platform Support', link: '/reference/platform-support' },
        { text: 'Limitations', link: '/reference/limitations' },
      ],
    },
  ],
  hero: {
    name: 'OXC for TSRX',
    text: 'Bring .tsrx into your OXC and Vite+ toolchain',
    tagline:
      'One install, and your .tsrx files lint and format like .tsx does.',
    actions: [
      { theme: 'brand', text: 'Get Started', link: '/guide/getting-started' },
      { theme: 'alt', text: 'What is OXC for TSRX?', link: '/guide/introduction' },
    ],
  },
  features: [
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8.5v7a2 2 0 0 1-1 1.73l-6 3.5a2 2 0 0 1-2 0l-6-3.5A2 2 0 0 1 5 15.5v-7a2 2 0 0 1 1-1.73l6-3.5a2 2 0 0 1 2 0l6 3.5a2 2 0 0 1 1 1.73Z"/><path d="m5.3 7.3 7.7 4.5 7.7-4.5M13 21.5V11.8"/></svg>',
      title: 'Built on OXC, not a copy',
      details:
        'Nothing is snapshotted and nothing is patched. Every OXC call lives in one small adapter crate.',
    },
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5H7a2 2 0 0 0-2 2V10a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4.5a2 2 0 0 0 2 2h1"/><path d="M16 20.5h1a2 2 0 0 0 2-2V14a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5.5a2 2 0 0 0-2-2h-1"/></svg>',
      title: 'A real parser you can call',
      details:
        'Same API shape as official <code>oxc-parser</code>, plus <code>.tsrx</code>, for codemods, bundler plugins, and analysis tools.',
    },
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.5" fill="currentColor"/></svg>',
      title: 'Squiggles where you typed',
      details:
        'Real OXC rules run on a temporary in-memory TSX copy, but what you see is anchored to your authored source.',
    },
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 20V8m0 0L3.5 11.5M7 8l3.5 3.5M17 4v12m0 0 3.5-3.5M17 16l-3.5-3.5"/></svg>',
      title: 'Formatting that checks itself',
      details:
        'Oxfmt layout is carried back into your TSRX, then reparsed and compared before anything reaches disk.',
    },
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z"/></svg>',
      title: 'Speed you can check',
      details:
        'Every number on this page is read from a committed benchmark report when the site is built.',
    },
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="19" height="13.5" rx="2"/><path d="M8.5 21h7M12 17v4"/><path d="M7 11c.9-1.3 1.8-1.3 2.7 0s1.8 1.3 2.6 0 1.8-1.3 2.7 0"/></svg>',
      title: 'Your editor already knows',
      details:
        'The released official OXC VS Code extension picks up the project-local <code>oxlint</code> that <code>@tsrx/oxc</code> installs, then gets live <code>.tsrx</code> diagnostics, formatting, and validated quick fixes.',
    },
  ],
  footer: {
    disclaimer:
      'The official OXC integration for TSRX.',
    copyright: 'MIT Licensed',
  },
}
