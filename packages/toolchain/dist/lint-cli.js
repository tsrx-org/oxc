import { runCaptured, runPassthrough } from "./process.js";
import { resolvePackageBinary } from "./package-binary.js";
import { argumentValue, canonicalToolEnvironment, discoverTsrxFiles, ensureSupportedOutput, isViteConfigPath, pathArguments, prepareVitePlusConfig, removeExplicitTsrx, replaceConfigArgument, resolveNativeCommand } from "./runtime.js";
import { DELEGATE_ONLY, VALUE_OPTIONS, parseOxlintInvocation, parseOxlintOption, withOxlintOutputFormat } from "./lint-invocation.js";
import { jsPluginUnmappedNote, preparePluginLane } from "./lint-js-plugins.js";
import { readFile } from "node:fs/promises";
import { relative } from "pathe";
//#region src/lint-cli.ts
async function runUpstreamOxlint(binary, args, options) {
	return runCaptured(process.execPath, [binary, ...args], options);
}
const NATIVE_VALUE_OPTIONS = /* @__PURE__ */ new Map([
	["-c", "--config"],
	["--config", "--config"],
	["-A", "--allow"],
	["--allow", "--allow"],
	["-W", "--warn"],
	["--warn", "--warn"],
	["-D", "--deny"],
	["--deny", "--deny"]
]);
const UNMATCHED_PATTERN_MESSAGE = "No files found to lint. Please check your paths and ignore patterns.";
function unknownOptionMessage(name) {
	return `Error: \`${name}\` is not expected in this context`;
}
function unknownCanonicalOption(args) {
	let positionalOnly = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (positionalOnly) continue;
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (!argument.startsWith("-") || argument === "-") continue;
		const { name, value } = parseOxlintOption(argument);
		if (VALUE_OPTIONS.has(name)) {
			if (value === null) index += 1;
			continue;
		}
		if (!parseOxlintInvocation([name]).known) return name;
	}
	return null;
}
function attributeNativeErrors(stderr) {
	return stderr.replace(/^oxc-tsrx(?:-lint)?: /gmu, "oxlint (oxc-tsrx): ");
}
function hasTsrxPositional(positionals) {
	return positionals.some((argument) => argument.split("?")[0].endsWith(".tsrx"));
}
const WRAPPER_OPTIONS = /* @__PURE__ */ new Set([
	"--quiet",
	"--silent",
	"--deny-warnings",
	"--no-ignore",
	"--no-error-on-unmatched-pattern"
]);
function nativeArguments(args, files, resolvedConfig) {
	const output = [];
	let positionalOnly = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (positionalOnly) continue;
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (!argument.startsWith("-") || argument === "-") continue;
		const { name, value: inlineValue } = parseOxlintOption(argument);
		if (NATIVE_VALUE_OPTIONS.has(name)) {
			const value = inlineValue ?? args[++index];
			if (!value) throw new Error(`${name} requires a value`);
			if (resolvedConfig && (name === "-c" || name === "--config")) continue;
			output.push(NATIVE_VALUE_OPTIONS.get(name), value);
			continue;
		}
		if (name === "--fix") {
			output.push("--fix");
			continue;
		}
		if (name === "--type-aware" || name === "--type-check") {
			output.push(name);
			continue;
		}
		if (name === "--format" || name === "-f") {
			if (inlineValue === null) index += 1;
			continue;
		}
		if (name === "--threads" || name === "--max-warnings") {
			if (inlineValue === null) index += 1;
			continue;
		}
		if (WRAPPER_OPTIONS.has(name)) continue;
		throw new Error(`${name} is not yet supported for .tsrx by the drop-in Oxlint command; canonical Oxlint still handles ordinary files`);
	}
	if (resolvedConfig) {
		output.push("--config", resolvedConfig.path, "--config-base", resolvedConfig.base);
		if (resolvedConfig.typeCheck && !output.includes("--type-check")) output.push("--type-check");
		else if (resolvedConfig.typeAware && !output.includes("--type-aware")) output.push("--type-aware");
	}
	return [
		...output,
		"--format=json",
		...files
	];
}
function resolveOxlintBytePositions(bytes, byteOffsets, filename = "<source>") {
	const offsets = [...new Set(byteOffsets)];
	for (const byteOffset of offsets) {
		if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset > bytes.length) throw new Error(`invalid diagnostic byte offset ${byteOffset} for ${filename}`);
		if (byteOffset < bytes.length && (bytes[byteOffset] & 192) === 128) throw new Error(`diagnostic byte offset ${byteOffset} splits UTF-8 in ${filename}`);
	}
	const positions = /* @__PURE__ */ new Map();
	const pending = new Set(offsets);
	let line = 1;
	let column = 1;
	let previousWasCarriageReturn = false;
	for (let cursor = 0; cursor <= bytes.length && pending.size > 0; cursor += 1) {
		if (pending.delete(cursor)) positions.set(cursor, {
			line,
			column
		});
		if (cursor === bytes.length) break;
		const byte = bytes[cursor];
		if (byte === 13) {
			line += 1;
			column = 1;
			previousWasCarriageReturn = true;
		} else if (byte === 10) {
			if (!previousWasCarriageReturn) line += 1;
			column = 1;
			previousWasCarriageReturn = false;
		} else {
			column += 1;
			previousWasCarriageReturn = false;
		}
	}
	return positions;
}
async function addLineColumns(diagnostics) {
	const labelsByFile = /* @__PURE__ */ new Map();
	for (const diagnostic of diagnostics) for (const label of diagnostic.labels ?? []) {
		if (label.span?.line !== void 0 && label.span?.column !== void 0 || label.span?.offset === void 0) continue;
		let labelsByOffset = labelsByFile.get(diagnostic.filename);
		if (labelsByOffset === void 0) {
			labelsByOffset = /* @__PURE__ */ new Map();
			labelsByFile.set(diagnostic.filename, labelsByOffset);
		}
		const labels = labelsByOffset.get(label.span.offset) ?? [];
		labels.push(label);
		labelsByOffset.set(label.span.offset, labels);
	}
	for (const [filename, labelsByOffset] of labelsByFile) {
		let bytes;
		try {
			bytes = await readFile(filename);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`cannot read diagnostic source ${filename}: ${detail}`);
		}
		const positions = resolveOxlintBytePositions(bytes, labelsByOffset.keys(), filename);
		for (const [byteOffset, labels] of labelsByOffset) {
			const location = positions.get(byteOffset);
			for (const label of labels) {
				label.span.line = location.line;
				label.span.column = location.column;
			}
		}
	}
}
function parseJson(result, label) {
	try {
		return result.stdout.trim() ? JSON.parse(result.stdout) : {
			diagnostics: [],
			number_of_files: 0
		};
	} catch {
		throw new Error(`${label} returned non-JSON output while composing diagnostics:\n${result.stdout}${result.stderr}`);
	}
}
function splitCapturedReport(result) {
	if (result.stdout.trim() === "") return {
		report: null,
		passthrough: ""
	};
	try {
		const parsed = JSON.parse(result.stdout);
		if (parsed !== null && typeof parsed === "object") return {
			report: parsed,
			passthrough: ""
		};
	} catch {}
	return {
		report: null,
		passthrough: result.stdout
	};
}
function combine(upstream, native) {
	return {
		...upstream,
		diagnostics: [...upstream.diagnostics ?? [], ...native.diagnostics ?? []],
		number_of_files: (upstream.number_of_files ?? 0) + (native.number_of_files ?? 0),
		number_of_rules: Math.max(upstream.number_of_rules ?? 0, native.number_of_rules ?? 0),
		threads_count: upstream.threads_count ?? native.threads_count,
		oxcTsrx: native.oxcTsrx
	};
}
function primaryLocation(diagnostic) {
	const span = diagnostic.labels?.[0]?.span;
	return {
		line: span?.line ?? 1,
		column: span?.column ?? 1
	};
}
const AGENT_ENVIRONMENT_VARIABLES = [
	"AI_AGENT",
	"CLAUDECODE",
	"CLAUDE_CODE",
	"CODEX_SANDBOX",
	"CODEX_THREAD_ID",
	"COPILOT_CLI",
	"CURSOR_AGENT",
	"GEMINI_CLI",
	"JUNIE_DATA",
	"JUNIE_SHIM_PATH",
	"OPENCODE",
	"REPL_ID"
];
function inAgentEnvironment(env) {
	if (AGENT_ENVIRONMENT_VARIABLES.some((name) => (env[name] ?? "") !== "")) return true;
	if ((env.EDITOR ?? "").includes("devin")) return true;
	return env.TERM_PROGRAM === "kiro";
}
function explicitOutputFormat(args) {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") return null;
		const { name, value } = parseOxlintOption(argument);
		if (name === "--format" || name === "-f") return value ?? args[index + 1] ?? null;
	}
	return null;
}
function effectiveOutputFormat(args, env = process.env) {
	const explicit = explicitOutputFormat(args);
	if (explicit !== null) return explicit;
	if (inAgentEnvironment(env)) return "agent";
	if (env.GITHUB_ACTIONS === "true") return "github";
	return "default";
}
const COMPOSABLE_FORMATS = /* @__PURE__ */ new Set([
	"default",
	"agent",
	"github",
	"json"
]);
function sortedDiagnostics(result) {
	return [...result.diagnostics ?? []].sort((left, right) => {
		const filename = left.filename.localeCompare(right.filename);
		if (filename !== 0) return filename;
		return (left.labels?.[0]?.span?.offset ?? 0) - (right.labels?.[0]?.span?.offset ?? 0);
	});
}
function renderCompact(result, cwd, elapsedMilliseconds) {
	const lines = sortedDiagnostics(result).map((diagnostic) => {
		const location = primaryLocation(diagnostic);
		const filename = relative(cwd, diagnostic.filename) || diagnostic.filename;
		const code = diagnostic.code ?? diagnostic.rule ?? "";
		const help = diagnostic.help ? ` help: ${diagnostic.help}` : "";
		return `${`${filename}:${location.line}:${location.column}: ${diagnostic.severity}`}${code ? ` ${code}` : ""}: ${diagnostic.message}${help}`.trimEnd();
	});
	lines.push(...summaryLines(result, elapsedMilliseconds));
	return `${lines.join("\n")}\n`;
}
function plural(count, noun) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function elapsedDisplay(milliseconds) {
	return milliseconds < 1e3 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1e3).toFixed(1)}s`;
}
function summaryLines(result, elapsedMilliseconds) {
	const diagnostics = result.diagnostics ?? [];
	const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
	const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
	const lines = [`Found ${plural(warnings, "warning")} and ${plural(errors, "error")}.`];
	if (typeof result.threads_count === "number") {
		const files = plural(result.number_of_files ?? 0, "file");
		const rules = plural(result.number_of_rules ?? 0, "rule");
		const threads = plural(result.threads_count, "thread");
		const elapsed = elapsedDisplay(elapsedMilliseconds);
		lines.push(`Finished in ${elapsed} on ${files} with ${rules} using ${threads}.`);
	}
	return lines;
}
function renderGitHub(result, cwd, elapsedMilliseconds) {
	const lines = sortedDiagnostics(result).map((diagnostic) => {
		const span = diagnostic.labels?.[0]?.span;
		const line = span?.line ?? 1;
		const column = span?.column ?? 1;
		const endLine = span?.endLine ?? line;
		const endColumn = span?.endColumn ?? column;
		const filename = relative(cwd, diagnostic.filename) || diagnostic.filename;
		const severity = diagnostic.severity === "error" ? "error" : "warning";
		const title = diagnostic.code || diagnostic.rule || "oxlint";
		return `::${severity} ${`file=${filename},line=${line},endLine=${endLine},col=${column},endColumn=${endColumn}`},title=${title}::${diagnostic.message}`;
	});
	if (lines.length > 0) lines.push("");
	lines.push(...summaryLines(result, elapsedMilliseconds));
	return `${lines.join("\n")}\n`;
}
async function addEndPositions(diagnostics) {
	const offsetsByFile = /* @__PURE__ */ new Map();
	for (const diagnostic of diagnostics) {
		const span = diagnostic.labels?.[0]?.span;
		if (span === void 0 || span.offset === void 0 || span.length === void 0) continue;
		if (span.endLine !== void 0 && span.endColumn !== void 0) continue;
		const spans = offsetsByFile.get(diagnostic.filename) ?? [];
		spans.push(span);
		offsetsByFile.set(diagnostic.filename, spans);
	}
	for (const [filename, spans] of offsetsByFile) {
		const positions = resolveOxlintBytePositions(await readFile(filename), spans.map((span) => span.offset + span.length), filename);
		for (const span of spans) {
			const location = positions.get(span.offset + span.length);
			span.endLine = location.line;
			span.endColumn = location.column;
		}
	}
}
async function renderReport(report, cwd, format, elapsedMilliseconds) {
	if (format === "json") return `${JSON.stringify(report)}\n`;
	if (format !== "github") return renderCompact(report, cwd, elapsedMilliseconds);
	try {
		await addEndPositions(report.diagnostics ?? []);
	} catch {}
	return renderGitHub(report, cwd, elapsedMilliseconds);
}
async function delegate(args, cwd) {
	const upstreamArgs = [resolvePackageBinary("oxlint-current", "oxlint", import.meta.url), ...args];
	if (args.some((argument) => argument.split("=")[0] === "--lsp")) return (await runPassthrough(process.execPath, upstreamArgs, { cwd })).status;
	const result = await runCaptured(process.execPath, upstreamArgs, { cwd });
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	return result.status;
}
async function runCli(args, options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const startedAt = performance.now();
	if (args.some((argument) => DELEGATE_ONLY.has(argument.split("=")[0]))) return delegate(args, cwd);
	const positions = parseOxlintInvocation(args).positionals;
	const files = await discoverTsrxFiles(positions, cwd);
	if (files.length > 0 || hasTsrxPositional(positions)) {
		const unknown = unknownCanonicalOption(args);
		if (unknown !== null) {
			process.stderr.write(`${unknownOptionMessage(unknown)}\n`);
			return 1;
		}
	}
	const format = effectiveOutputFormat(args);
	if (!COMPOSABLE_FORMATS.has(format)) ensureSupportedOutput(format, files);
	const explicitConfig = argumentValue(args, /* @__PURE__ */ new Set(["-c", "--config"]));
	const bridgeViteConfig = explicitConfig === null || isViteConfigPath(explicitConfig);
	const viteConfig = files.length > 0 && bridgeViteConfig ? await prepareVitePlusConfig("lint", cwd, isViteConfigPath(explicitConfig) ? explicitConfig : null) : null;
	let pluginLane = null;
	try {
		pluginLane = files.length > 0 ? await preparePluginLane({
			cwd,
			files,
			viteConfig,
			explicitConfig
		}) : null;
	} catch (error) {
		await viteConfig?.cleanup();
		throw error;
	}
	if (pluginLane?.status === "version-refused") {
		await viteConfig?.cleanup();
		process.stderr.write(`${pluginLane.message}\n`);
		return 1;
	}
	const pluginLaneActive = pluginLane?.status === "active";
	if (pluginLaneActive && !args.includes("--silent")) process.stderr.write(`${pluginLane.notice}\n`);
	let nativePaths = null;
	try {
		const stripped = removeExplicitTsrx(args, VALUE_OPTIONS);
		const shouldRunUpstream = !stripped.hadPositionals || stripped.remainingPositionals > 0;
		if (!shouldRunUpstream && files.length === 0) {
			if (args.includes("--no-error-on-unmatched-pattern")) return 0;
			process.stdout.write(`${UNMATCHED_PATTERN_MESSAGE}\n`);
			if (format === "json") process.stdout.write(`${JSON.stringify({
				diagnostics: [],
				number_of_files: 0
			})}\n`);
			return 1;
		}
		const upstreamBinary = resolvePackageBinary("oxlint-current", "oxlint", import.meta.url);
		const useMaterializedUpstreamConfig = Boolean(viteConfig && !viteConfig.requiresAuthoredBase);
		let upstreamArgs = withOxlintOutputFormat(stripped.args, "json");
		if (useMaterializedUpstreamConfig) upstreamArgs = replaceConfigArgument(upstreamArgs, viteConfig.path);
		const nativeResolvedConfig = pluginLane?.nativeConfig ?? viteConfig;
		nativePaths = files.length > 0 ? await pathArguments(files) : null;
		const nativeArgs = nativePaths ? nativeArguments(args, nativePaths.args, nativeResolvedConfig) : null;
		const nativeCommand = nativeArgs ? resolveNativeCommand("lint", nativeArgs) : null;
		let upstreamPromise;
		if (!shouldRunUpstream) upstreamPromise = Promise.resolve({
			status: 0,
			stdout: "",
			stderr: "",
			signal: null
		});
		else if (options.prestartedUpstream !== null && options.prestartedUpstream !== void 0) {
			if (JSON.stringify(options.prestartedUpstream.args) !== JSON.stringify(upstreamArgs)) {
				await options.prestartedUpstream.result;
				throw new Error("canonical Oxlint prestart arguments diverged from the composed batch");
			}
			upstreamPromise = options.prestartedUpstream.result;
		} else upstreamPromise = runUpstreamOxlint(upstreamBinary, upstreamArgs, {
			cwd,
			env: canonicalToolEnvironment(useMaterializedUpstreamConfig)
		});
		const lanePromise = pluginLaneActive ? pluginLane.run().then((value) => ({
			ok: true,
			value
		}), (error) => ({
			ok: false,
			error
		})) : Promise.resolve({
			ok: true,
			value: null
		});
		const [upstreamResult, nativeResult, laneOutcome] = await Promise.all([
			upstreamPromise,
			nativeCommand ? runCaptured(nativeCommand.executable, nativeCommand.args, { cwd }) : Promise.resolve({
				status: 0,
				stdout: "",
				stderr: "",
				signal: null
			}),
			lanePromise
		]);
		if (upstreamResult.status > 1 || nativeResult.status > 1) {
			const upstreamHalf = splitCapturedReport(upstreamResult);
			const nativeHalf = splitCapturedReport(nativeResult);
			if (nativeHalf.report) try {
				await addLineColumns(nativeHalf.report.diagnostics ?? []);
			} catch {}
			const report = upstreamHalf.report && nativeHalf.report ? combine(upstreamHalf.report, nativeHalf.report) : upstreamHalf.report ?? nativeHalf.report;
			const elapsed = performance.now() - startedAt;
			const rendered = report === null ? "" : await renderReport(report, cwd, format, elapsed);
			process.stdout.write(upstreamHalf.passthrough + nativeHalf.passthrough + rendered);
			process.stderr.write(upstreamResult.stderr + attributeNativeErrors(nativeResult.stderr));
			return Math.max(upstreamResult.status, nativeResult.status);
		}
		if (!laneOutcome.ok) throw laneOutcome.error;
		const upstream = parseJson(upstreamResult, "canonical Oxlint");
		const native = parseJson(nativeResult, "OXC for TSRX");
		if (laneOutcome.value !== null) {
			for (const failure of laneOutcome.value.failures ?? []) if (!args.includes("--silent")) process.stderr.write(`oxlint (oxc-tsrx): ${failure}\n`);
			const unmapped = laneOutcome.value.unmapped ?? 0;
			if (unmapped > 0 && !args.includes("--silent")) process.stderr.write(`${jsPluginUnmappedNote(unmapped)}\n`);
			native.diagnostics = [...native.diagnostics ?? [], ...laneOutcome.value.diagnostics];
			if (native.oxcTsrx) native.oxcTsrx.jsPluginProjection = {
				files: laneOutcome.value.files,
				extraParses: laneOutcome.value.extraParses,
				unmapped
			};
		}
		await addLineColumns(native.diagnostics ?? []);
		let result = combine(upstream, native);
		if (args.includes("--quiet")) result = {
			...result,
			diagnostics: result.diagnostics.filter((diagnostic) => diagnostic.severity !== "warning")
		};
		if (!args.includes("--silent")) {
			process.stderr.write(upstreamResult.stderr + attributeNativeErrors(nativeResult.stderr));
			process.stdout.write(await renderReport(result, cwd, format, performance.now() - startedAt));
		}
		const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
		const denyWarnings = args.includes("--deny-warnings");
		const maximum = argumentValue(args, /* @__PURE__ */ new Set(["--max-warnings"]));
		const exceedsMaximum = maximum !== null && warnings > Number.parseInt(maximum, 10);
		const pluginErrors = (laneOutcome.value?.diagnostics ?? []).some((diagnostic) => diagnostic.severity === "error") || (laneOutcome.value?.failures ?? []).length > 0;
		return Math.max(upstreamResult.status, nativeResult.status, denyWarnings && warnings > 0 ? 1 : 0, exceedsMaximum ? 1 : 0, pluginErrors ? 1 : 0);
	} finally {
		await pluginLane?.cleanup?.();
		await nativePaths?.cleanup();
		await viteConfig?.cleanup();
	}
}
//#endregion
export { resolveOxlintBytePositions, runCli };
