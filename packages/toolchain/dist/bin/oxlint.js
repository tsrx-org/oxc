#!/usr/bin/env node
//#region src/bin/oxlint.ts
try {
	const { enableCompileCache } = await import("node:module");
	enableCompileCache?.();
} catch {}
try {
	const { decideCanonicalCommand, deferralNotice, runOfficialCommand } = await import("../canonical-command.js");
	const args = process.argv.slice(2);
	const decision = await decideCanonicalCommand("oxlint");
	if (args.some((argument) => argument.split("=", 1)[0] === "--lsp")) {
		const { runOxlintLspMultiplexer } = await import("../oxlint-lsp-multiplexer.js");
		process.exitCode = await runOxlintLspMultiplexer(args, decision.owner === "project" ? { canonical: {
			binPath: decision.binPath,
			version: decision.officialVersion
		} } : {});
	} else if (decision.owner === "project") {
		const notice = deferralNotice(decision, args);
		if (notice !== null) console.error(notice);
		await runOfficialCommand(decision);
	} else {
		const { canRunCanonicalOxlint, importDeclaredPackageBinary, planCanonicalOxlintComposition } = await import("../lint-invocation.js");
		if (canRunCanonicalOxlint(args)) await importDeclaredPackageBinary("oxlint-current", "oxlint", import.meta.url);
		else {
			const plan = Boolean(process.env.VP_VERSION || process.env.VP_COMMAND || process.env.NODE_PACKAGE_MANAGER === "vite-plus") ? null : planCanonicalOxlintComposition(args);
			const prestart = plan === null ? Promise.resolve(null) : import("../lint-prestart.js").then(({ startCanonicalOxlint }) => startCanonicalOxlint(plan.args));
			const [{ runCli }, prestartedUpstream] = await Promise.all([import("../lint-cli.js"), prestart]);
			process.exitCode = await runCli(args, { prestartedUpstream });
		}
	}
} catch (error) {
	console.error(`oxlint (oxc-tsrx): ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
}
//#endregion
export {};
