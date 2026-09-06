#!/usr/bin/env node

// The canonical `oxlint` command name, as linked into `node_modules/.bin` by a
// plain `npm install oxc-tsrx`. See ../canonical-command.js for why this
// package publishes the name at all, and how it hands the name straight back to
// a project that pinned the official Oxlint package.
//
// When this package does own the name, the routing below is the whole drop-in
// contract: an invocation that cannot select TSRX enters the pinned Oxlint
// package's own declared launcher in this process, preserving its output,
// plugins, config loading, fixes, and exit behaviour exactly. Everything else
// goes through the TSRX-aware bridge in ../lint-cli.js.
//
// `--lsp` is the one invocation that composes instead of deferring. The editor
// starts exactly one `oxlint --lsp` and serves every file through it, so
// handing that process to the official package would leave `.tsrx` with no
// diagnostics and no formatter and nothing saying why (tsrx-org/oxc#69). The
// multiplexer keeps the project's own Oxlint as the server for ordinary files,
// the exact version the project pinned, and routes `.tsrx` to the native
// server. Command-line invocations keep deferring exactly as before.

// Persistent V8 compile cache shaves a few milliseconds off every launch;
// harmless where unsupported.
try {
  const { enableCompileCache } = await import("node:module");
  enableCompileCache?.();
} catch {}

try {
  const { decideCanonicalCommand, deferralNotice, runOfficialCommand } = await import(
    "../canonical-command.js"
  );
  const args = process.argv.slice(2);
  const decision = await decideCanonicalCommand("oxlint");
  if (args.some((argument) => argument.split("=", 1)[0] === "--lsp")) {
    const { runOxlintLspMultiplexer } = await import(
      "../oxlint-lsp-multiplexer.js"
    );
    process.exitCode = await runOxlintLspMultiplexer(
      args,
      decision.owner === "project"
        ? { canonical: { binPath: decision.binPath, version: decision.officialVersion } }
        : {},
    );
  } else if (decision.owner === "project") {
    const notice = deferralNotice(decision, args);
    if (notice !== null) console.error(notice);
    await runOfficialCommand(decision);
  } else {
    const {
      canRunCanonicalOxlint,
      importDeclaredPackageBinary,
      planCanonicalOxlintComposition,
    } = await import("../lint-invocation.js");
    if (canRunCanonicalOxlint(args)) {
      // This invocation cannot select TSRX. Execute the exact binary declared
      // by the pinned Oxlint package in this process, preserving canonical
      // output, plugins, config loading, fixes, LSP streams, and
      // cross-platform behavior.
      await importDeclaredPackageBinary("oxlint-current", "oxlint", import.meta.url);
    } else {
      const vitePlusHost = Boolean(
        process.env.VP_VERSION ||
        process.env.VP_COMMAND ||
        process.env.NODE_PACKAGE_MANAGER === "vite-plus"
      );
      const plan = vitePlusHost ? null : planCanonicalOxlintComposition(args);
      const prestart = plan === null
        ? Promise.resolve(null)
        : import("../lint-prestart.js").then(({ startCanonicalOxlint }) =>
            startCanonicalOxlint(plan.args));
      const [{ runCli }, prestartedUpstream] = await Promise.all([
        import("../lint-cli.js"),
        prestart,
      ]);
      process.exitCode = await runCli(args, { prestartedUpstream });
    }
  }
} catch (error) {
  console.error(`oxlint (oxc-tsrx): ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
