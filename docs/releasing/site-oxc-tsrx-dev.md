# Publishing the docs site at `oxc.tsrx.dev`

> **Status (2026-09-02):** `oxc.tsrx.dev` is live and canonical. The old
> `compiled.run/oxc-tsrx` location is kept as a **permanent redirect**: the
> compiled.run build sets `redirectTo` in `docs/site.config.mjs`, `docs/build.mjs`
> writes matching `redirects` into that artifact's `vercel.json`, and the
> `deploy` job in `.github/workflows/site-artifact.yml` proves the 308 instead of
> the page. Only `/oxc-tsrx` and its subpaths are redirected; the compiled.run
> root and `/guessless` are unaffected. The rest of this document describes the
> original hand-off and remains accurate for how the two deploys are wired.

This is a hand-off document. Every step below needs access this repository's
maintainers do not have: the `tsrx.dev` DNS zone and the TSRX Vercel team.
Nothing here is automated, nothing here has been run, and nothing here can be
run from a pull request.

The code side is already merged and inert. The workflow reads three pieces of
repository configuration that **do not exist yet**; until someone with access
creates them, the `oxc.tsrx.dev` build and deploy steps skip, CI stays green,
and the existing `https://compiled.run/oxc-tsrx` deploy is untouched.

## What is already true

- `docs/site.config.mjs` reads `SITE_ORIGIN` and `SITE_BASE` from the
  environment, defaulting to `https://compiled.run` and `/oxc-tsrx/`. With both
  unset the build output is byte-identical to what it was before.
- `.github/workflows/site-artifact.yml` builds a second copy of the site with
  `SITE_ORIGIN=https://oxc.tsrx.dev SITE_BASE=/` and uploads it as
  `oxc-tsrx-docs-tsrx-dev-<sha>`, then a `deploy-tsrx-dev` job ships that
  artifact to a Vercel project you control.
- No repository-root `vercel.json` is needed or present. `docs/build.mjs` writes
  a `vercel.json` into the root of the build output itself (`cleanUrls`,
  `trailingSlash: false`, and the COOP/COEP headers the WebAssembly playground
  requires), and the workflow deploys that directory with `vercel deploy --cwd`,
  so the generated file is the one Vercel reads. Do **not** add project-level
  build or output settings in the Vercel dashboard that would fight it.

## Why this is a second build, not a second deploy of one artifact

Absolute URLs — `<link rel="canonical">`, `og:image`, `sitemap.xml`,
`robots.txt` — and every in-page link are baked in at build time. A site built
for `compiled.run/oxc-tsrx` cannot be re-hosted at `oxc.tsrx.dev` without
advertising the wrong canonical origin to search engines and linking every page
to a `/oxc-tsrx/...` path that does not exist on that domain. The second build
costs roughly one extra minute; it reuses the WebAssembly artifact already on
the runner.

## Step 1 — the Vercel project

In the TSRX Vercel team:

1. Create a new project (or pick an existing one) for these docs. Suggested
   name: `oxc-tsrx-docs`.
2. **Do not connect a Git repository.** This site cannot be built on Vercel's
   image — it needs a Rust toolchain and a `wasm32-wasip1-threads` target — so
   the only bytes that may reach production are the artifact GitHub Actions
   built and proved. A connected Git integration would silently start producing
   broken builds alongside the good ones. This mirrors how the existing
   `compiled.run/oxc-tsrx` project is configured.
3. Leave the framework preset as **Other** and leave the build/output settings
   empty. The deploy uploads pre-built static files.
4. Note the project's **Project ID** (Project Settings → General) and the
   team's **Team ID** (Team Settings → General). Both look like
   `prj_…` / `team_…`.

## Step 2 — the domain and the DNS record

1. In the project: Settings → Domains → add `oxc.tsrx.dev`.
2. Vercel will show the exact record to create. For a subdomain that is
   currently a `CNAME` to `cname.vercel-dns.com`. **Use the value Vercel shows
   you, not the value in this document** — Vercel has changed this target
   before and the dashboard is authoritative.

   | Type    | Name  | Value                   |
   | ------- | ----- | ----------------------- |
   | `CNAME` | `oxc` | `cname.vercel-dns.com.` |

3. Create that record in the `tsrx.dev` zone and wait for Vercel to show the
   domain as **Valid Configuration**. If `tsrx.dev` is already a Vercel-managed
   domain on the same team, adding the domain is enough and no manual record is
   needed.
4. Confirm the domain is assigned to **Production** and that no Deployment
   Protection rule covers production. Standard protection only covers preview
   deployments, which is fine; "All Deployments" protection would make the
   post-deploy verification step in the workflow fail with a `401`.

## Step 3 — a deploy token

Create a Vercel access token scoped to the TSRX team (Account Settings →
Tokens). Give it the shortest useful expiry your rotation policy allows and
record the expiry somewhere you will see it, because an expired token turns
every `main` push red.

## Step 4 — the repository configuration

In `Settings → Secrets and variables → Actions` of this repository.

**Variables** (the `Variables` tab — these are not secret, and the workflow
gates on them, so a typo means the job silently skips):

| Name                    | Value                       |
| ----------------------- | --------------------------- |
| `TSRX_VERCEL_ORG_ID`    | the team ID from step 1     |
| `TSRX_VERCEL_PROJECT_ID`| the project ID from step 1  |

**Secret** (the `Secrets` tab):

| Name                 | Value                    |
| -------------------- | ------------------------ |
| `TSRX_VERCEL_TOKEN`  | the token from step 3    |

A repository secret is enough. The `deploy-tsrx-dev` job declares an
environment named `tsrx-dev` (GitHub creates it on the first run), so if you
would rather scope the token — or add required reviewers to the deploy — put
`TSRX_VERCEL_TOKEN` on that environment instead; an environment secret of the
same name takes precedence.

The names must match exactly. GitHub Actions cannot read a secret in an `if:`
condition, which is why the two **variables** are what gate the job: if either
is missing or empty, both the extra build step and the deploy job are skipped
cleanly. If the variables are set but the secret is not, the deploy fails loudly
with a message pointing back at this file — that is deliberate, because at that
point a deploy was clearly intended.

## Step 5 — the first deploy

Push to `main`, or run the **Build website artifact** workflow manually
(Actions → Build website artifact → Run workflow). Pull requests never deploy.

Then read the run:

- `Build the oxc.tsrx.dev variant of the site` and
  `Upload the oxc.tsrx.dev static artifact` must have run rather than been
  skipped. If they were skipped, one of the two variables is missing or
  misspelled.
- `Deploy oxc.tsrx.dev` → `Prove that deployment is serving this build` must
  pass. It fetches the deployment URL the Vercel CLI printed, checks that
  `demo-capabilities.json` reports the WebAssembly engine, and compares the
  SHA-256 of the served `index.html` against the one this run built. It
  verifies the deployment URL rather than `oxc.tsrx.dev` on purpose, so a
  first deploy can be proven before DNS has propagated.
- `Report whether oxc.tsrx.dev resolves to it` is informational and cannot fail
  the run. A warning here means the deploy was good but the domain is not
  pointing at it yet — go back to step 2.

Finally, check by hand: `https://oxc.tsrx.dev` loads, an interior page such as
`https://oxc.tsrx.dev/guide/introduction` loads (this proves `cleanUrls` from
the generated `vercel.json` is in effect), and the home-page playground reports
the WebAssembly engine rather than the static fallback.

## Turning it off

Delete either repository variable. The next push builds and deploys only
`compiled.run/oxc-tsrx`, exactly as before.

## Also outstanding after a repository transfer

Moving this repository to a new owner does not carry its Actions configuration
with it. The **existing** `compiled.run/oxc-tsrx` deploy path depends on a
`production` GitHub environment holding a `VERCEL_TOKEN` secret, and on the
`VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` values hardcoded in the `deploy` job of
`.github/workflows/site-artifact.yml`. That environment and secret have to be
recreated by whoever holds the compiled.run Vercel project, or the site stops
updating silently — the job is gated on the repository name and will simply not
run. See [external account prerequisites](external-prerequisites.md) for the
full list of accounts, tokens, and identities a transfer has to re-establish.

The two publications are independent by design: neither deploy job depends on
the other, and either can be broken, disabled, or removed without affecting the
other.
