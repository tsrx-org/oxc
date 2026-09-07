import { runCaptured, runPassthrough } from "./process.js";
import { resolvePackageBinary } from "./package-binary.js";
import { argumentValue, canonicalToolEnvironment, discoverTsrxFiles, isViteConfigPath, pathArguments, prepareVitePlusConfig, removeExplicitTsrx, replaceConfigArgument, resolveNativeCommand } from "./runtime.js";
import { VALUE_OPTIONS, parseOxfmtInvocation, parseOxfmtOption } from "./format-invocation.js";
import { isAbsolute, relative } from "node:path";
import { readFileSync } from "node:fs";
//#region src/format-cli.ts
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
		const { name, value } = parseOxfmtOption(argument);
		if (VALUE_OPTIONS.has(name)) {
			if (value === null) index += 1;
			continue;
		}
		if (!parseOxfmtInvocation([name]).known) return name;
	}
	return null;
}
function attributeNativeErrors(stderr) {
	return stderr.replace(/^oxc-tsrx-fmt: /gmu, "oxfmt (oxc-tsrx): ");
}
function hasTsrxPositional(positionals) {
	return positionals.some((argument) => argument.split("?")[0].endsWith(".tsrx"));
}
const NATIVE_VALUE_OPTIONS = /* @__PURE__ */ new Map([
	["-c", "--config"],
	["--config", "--config"],
	["--threads", "--threads"]
]);
const WRAPPER_OPTIONS = /* @__PURE__ */ new Set(["--no-error-on-unmatched-pattern"]);
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
		const { name, value: inlineValue } = parseOxfmtOption(argument);
		if (NATIVE_VALUE_OPTIONS.has(name)) {
			const value = inlineValue ?? args[++index];
			if (!value) throw new Error(`${name} requires a value`);
			if (resolvedConfig && (name === "-c" || name === "--config")) continue;
			output.push(NATIVE_VALUE_OPTIONS.get(name), value);
			continue;
		}
		if (name === "--write" || name === "--check" || name === "--list-different") {
			output.push(name);
			continue;
		}
		if (WRAPPER_OPTIONS.has(name)) continue;
		throw new Error(`${name} is not yet supported for .tsrx by the drop-in Oxfmt command; canonical Oxfmt still handles ordinary files`);
	}
	if (resolvedConfig) output.push("--config", resolvedConfig.path, "--config-base", resolvedConfig.base);
	return [...output, ...files];
}
function withCwdRelativePaths(files, cwd) {
	return files.map((file) => {
		if (!isAbsolute(file)) return file;
		const relativePath = relative(cwd, file);
		if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return file;
		return relativePath;
	});
}
function fileMode(args) {
	let mode = "write";
	let positionalOnly = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (positionalOnly) continue;
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (!argument.startsWith("-") || argument === "-") continue;
		const { name, value: inlineValue } = parseOxfmtOption(argument);
		if (VALUE_OPTIONS.has(name)) {
			if (inlineValue === null) index += 1;
			continue;
		}
		if (name === "--check") mode = "check";
		else if (name === "--list-different") mode = "list-different";
		else if (name === "--write") mode = "write";
	}
	return mode;
}
function reportedFileCount(line) {
	const match = /\bon (\d+) files\b/u.exec(line ?? "");
	return match ? Number(match[1]) : null;
}
function withReportedFileCount(line, count) {
	return line.replace(/\bon \d+ files\b/u, `on ${count} files`);
}
function withVerdictCount(verdict, count) {
	return verdict.replace(/\b\d+ files\b/u, `${count} files`);
}
function parseCheckReport(stdout) {
	const separator = stdout.indexOf("\n\n");
	if (separator <= 0 || stdout.slice(0, separator).includes("\n")) return null;
	const preamble = stdout.slice(0, separator + 2);
	const body = stdout.slice(separator + 2);
	if (!body.endsWith("\n")) return {
		preamble,
		files: body === "" ? [] : body.split("\n"),
		verdict: null,
		summary: null,
		count: null
	};
	const lines = body.slice(0, -1).split("\n");
	const summary = lines.pop() ?? null;
	const verdict = lines.pop() ?? null;
	if (lines.at(-1) === "") lines.pop();
	return {
		preamble,
		files: lines,
		verdict,
		summary,
		count: reportedFileCount(summary)
	};
}
function parseWriteReport(stdout) {
	if (!stdout.endsWith("\n")) return null;
	const line = stdout.slice(0, -1);
	const count = reportedFileCount(line);
	if (line.includes("\n") || count === null) return null;
	return {
		line,
		count
	};
}
function mergeCheckStdout(upstream, native, failed) {
	const reports = [parseCheckReport(upstream.stdout), parseCheckReport(native.stdout)].filter(Boolean);
	if (reports.length === 0) return upstream.stdout + native.stdout;
	const preamble = reports[0].preamble;
	const files = reports.flatMap((report) => report.files);
	if (failed) return preamble + files.join("\n");
	const verdict = files.length > 0 ? reports.find((report) => report.files.length > 0)?.verdict : reports.find((report) => report.files.length === 0)?.verdict;
	const summary = reports.find((report) => report.summary !== null)?.summary;
	if (!verdict || !summary) return upstream.stdout + native.stdout;
	const count = reports.reduce((total, report) => total + (report.count ?? 0), 0);
	return `${preamble}${files.join("\n")}${files.length > 0 ? "\n\n" : ""}${withVerdictCount(verdict, files.length)}\n${withReportedFileCount(summary, count)}\n`;
}
function mergeWriteStdout(upstream, native, failed) {
	const reports = [upstream.stdout, native.stdout].map(parseWriteReport).filter(Boolean);
	if (reports.length === 0) return upstream.stdout + native.stdout;
	if (failed) return "";
	const count = reports.reduce((total, report) => total + report.count, 0);
	return `${withReportedFileCount(reports[0].line, count)}\n`;
}
function mergeListDifferentStdout(upstream, native) {
	return [upstream.stdout, native.stdout].filter((part) => part.length > 0).join("\n");
}
function mergeFormatStdout(mode, upstream, native) {
	const failed = upstream.status >= 2 || native.status >= 2;
	if (mode === "list-different") return mergeListDifferentStdout(upstream, native);
	if (mode === "check") return mergeCheckStdout(upstream, native, failed);
	return mergeWriteStdout(upstream, native, failed);
}
function lastNonEmptyLine(text) {
	return text.split("\n").filter((line) => line !== "").at(-1) ?? "";
}
function withoutLine(text, line) {
	const marker = `${line}\n`;
	const index = text.lastIndexOf(marker);
	return index === -1 ? text : text.slice(0, index) + text.slice(index + marker.length);
}
function mergeFormatStderr(upstream, native, stdout) {
	let leading = upstream.stderr;
	const summary = lastNonEmptyLine(native.stderr);
	if (summary !== "" && lastNonEmptyLine(leading) === summary) leading = withoutLine(leading, summary);
	const merged = leading + native.stderr;
	if (merged === "" || merged.startsWith("\n") || stdout === "" || stdout.endsWith("\n")) return merged;
	return `\n${merged}`;
}
async function delegate(args, cwd, input) {
	const upstreamArgs = [resolvePackageBinary("oxfmt-current", "oxfmt", import.meta.url), ...args];
	if (args.some((argument) => argument.split("=")[0] === "--lsp")) return (await runPassthrough(process.execPath, upstreamArgs, { cwd })).status;
	const result = await runCaptured(process.execPath, upstreamArgs, {
		cwd,
		input
	});
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	return result.status;
}
async function runCli(args, options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const invocation = parseOxfmtInvocation(args);
	if (invocation.delegateOnly) return delegate(args, cwd, options.input);
	const requestedStdin = invocation.stdinFilepath;
	if (requestedStdin !== null) {
		const input = options.input ?? readFileSync(0);
		if (!requestedStdin.split("?")[0].endsWith(".tsrx")) return delegate(args, cwd, input);
		const unknownStdinOption = unknownCanonicalOption(args);
		if (unknownStdinOption !== null) {
			process.stderr.write(`${unknownOptionMessage(unknownStdinOption)}\n`);
			return 1;
		}
		const explicitConfig = argumentValue(args, /* @__PURE__ */ new Set(["-c", "--config"]));
		const viteConfig = explicitConfig === null || isViteConfigPath(explicitConfig) ? await prepareVitePlusConfig("fmt", cwd, isViteConfigPath(explicitConfig) ? explicitConfig : null) : null;
		try {
			let nativeArgs = args.filter((argument) => argument !== "--no-error-on-unmatched-pattern");
			if (viteConfig) {
				nativeArgs = replaceConfigArgument(nativeArgs, viteConfig.path);
				nativeArgs.push("--config-base", viteConfig.base);
			}
			const nativeCommand = resolveNativeCommand("format", nativeArgs);
			const result = await runCaptured(nativeCommand.executable, nativeCommand.args, {
				cwd,
				input
			});
			process.stdout.write(result.stdout);
			process.stderr.write(attributeNativeErrors(result.stderr));
			return result.status;
		} finally {
			await viteConfig?.cleanup();
		}
	}
	const positions = invocation.positionals;
	const files = await discoverTsrxFiles(positions, cwd, "format");
	if (files.length > 0 || hasTsrxPositional(positions)) {
		const unknown = unknownCanonicalOption(args);
		if (unknown !== null) {
			process.stderr.write(`${unknownOptionMessage(unknown)}\n`);
			return 1;
		}
	}
	const explicitConfig = argumentValue(args, /* @__PURE__ */ new Set(["-c", "--config"]));
	const bridgeViteConfig = explicitConfig === null || isViteConfigPath(explicitConfig);
	const viteConfig = files.length > 0 && bridgeViteConfig ? await prepareVitePlusConfig("fmt", cwd, isViteConfigPath(explicitConfig) ? explicitConfig : null) : null;
	let nativePaths = null;
	try {
		const stripped = removeExplicitTsrx(args, VALUE_OPTIONS);
		const shouldRunUpstream = !stripped.hadPositionals || stripped.remainingPositionals > 0;
		const upstream = resolvePackageBinary("oxfmt-current", "oxfmt", import.meta.url);
		const useMaterializedUpstreamConfig = Boolean(viteConfig && !viteConfig.requiresAuthoredBase);
		const upstreamArgs = useMaterializedUpstreamConfig ? replaceConfigArgument(stripped.args, viteConfig.path) : stripped.args;
		nativePaths = files.length > 0 ? await pathArguments(withCwdRelativePaths(files, cwd)) : null;
		const nativeArgs = nativePaths ? nativeArguments(args, nativePaths.args, viteConfig) : null;
		const nativeCommand = nativeArgs ? resolveNativeCommand("format", nativeArgs) : null;
		const [upstreamResult, nativeResult] = await Promise.all([shouldRunUpstream ? runCaptured(process.execPath, [upstream, ...upstreamArgs], {
			cwd,
			env: canonicalToolEnvironment(useMaterializedUpstreamConfig)
		}) : Promise.resolve({
			status: 0,
			stdout: "",
			stderr: "",
			signal: null
		}), nativeCommand ? runCaptured(nativeCommand.executable, nativeCommand.args, { cwd }) : Promise.resolve({
			status: 0,
			stdout: "",
			stderr: "",
			signal: null
		})]);
		const stdout = mergeFormatStdout(fileMode(args), upstreamResult, nativeResult);
		process.stdout.write(stdout);
		process.stderr.write(attributeNativeErrors(mergeFormatStderr(upstreamResult, nativeResult, stdout)));
		return Math.max(upstreamResult.status, nativeResult.status);
	} finally {
		await nativePaths?.cleanup();
		await viteConfig?.cleanup();
	}
}
//#endregion
export { runCli };
