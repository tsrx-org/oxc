#!/usr/bin/env node

// The canonical `oxfmt` command name. See ../canonical-command.js.
//
// When this package owns the name, an invocation that cannot select TSRX is
// handed to Oxfmt's own declared launcher in this process: that launcher owns
// stdin, config callbacks, worker cleanup, output, and exit behavior, so
// importing it avoids a second Node process without duplicating private N-API
// wiring. Everything else goes through the TSRX-aware bridge in
// ../format-cli.js.
try {
  const {
    decideCanonicalCommand,
    deferralNotice,
    resolveCanonicalBinary,
    runCanonicalBinary,
    runOfficialCommand,
  } = await import("../canonical-command.js");
  const args = process.argv.slice(2);
  const decision = await decideCanonicalCommand("oxfmt");
  if (decision.owner === "project") {
    const notice = deferralNotice(decision, args);
    if (notice !== null) console.error(notice);
    await runOfficialCommand(decision);
  } else {
    const { canRunCanonicalOxfmt } = await import("../format-invocation.js");
    if (canRunCanonicalOxfmt(args)) {
      await runCanonicalBinary(resolveCanonicalBinary("oxfmt"));
    } else {
      const { runCli } = await import("../format-cli.js");
      process.exitCode = await runCli(args);
    }
  }
} catch (error) {
  console.error(`oxfmt (oxc-tsrx): ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
