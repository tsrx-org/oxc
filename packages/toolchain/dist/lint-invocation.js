import { importCanonicalOxlint, importDeclaredPackageBinary } from "./package-binary.js";
import { statSync } from "node:fs";
import { resolve } from "pathe";
//#region src/lint-invocation.ts
const VALUE_OPTIONS = /* @__PURE__ */ new Set([
	"-c",
	"--config",
	"--tsconfig",
	"-A",
	"--allow",
	"-W",
	"--warn",
	"-D",
	"--deny",
	"--ignore-path",
	"--ignore-pattern",
	"--max-warnings",
	"-f",
	"--format",
	"--debug",
	"--threads",
	"--report-unused-disable-directives-severity"
]);
const DELEGATE_ONLY = /* @__PURE__ */ new Set([
	"--help",
	"-h",
	"--version",
	"-V",
	"--rules",
	"--lsp",
	"--init"
]);
const FLAG_OPTIONS = /* @__PURE__ */ new Set([
	"--disable-unicorn-plugin",
	"--disable-oxc-plugin",
	"--disable-typescript-plugin",
	"--import-plugin",
	"--react-plugin",
	"--jsdoc-plugin",
	"--jest-plugin",
	"--vitest-plugin",
	"--jsx-a11y-plugin",
	"--nextjs-plugin",
	"--react-perf-plugin",
	"--promise-plugin",
	"--node-plugin",
	"--vue-plugin",
	"--fix",
	"--fix-suggestions",
	"--fix-dangerously",
	"--no-ignore",
	"--quiet",
	"--deny-warnings",
	"--silent",
	"--no-error-on-unmatched-pattern",
	"--print-config",
	"--report-unused-disable-directives",
	"--disable-nested-config",
	"--type-aware",
	"--type-check"
]);
const COMPACT_VALUE_OPTIONS = [
	"-c",
	"-A",
	"-W",
	"-D",
	"-f"
];
function parseOxlintOption(argument) {
	const equals = argument.indexOf("=");
	if (equals !== -1) return {
		name: argument.slice(0, equals),
		value: argument.slice(equals + 1)
	};
	const compact = COMPACT_VALUE_OPTIONS.find((name) => argument.startsWith(name) && argument.length > name.length);
	return compact === void 0 ? {
		name: argument,
		value: null
	} : {
		name: compact,
		value: argument.slice(compact.length)
	};
}
function parseOxlintInvocation(args) {
	const positionals = [];
	const positionalIndices = [];
	let positionalOnly = false;
	let delegateOnly = false;
	let known = true;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (positionalOnly) {
			positionals.push(argument);
			positionalIndices.push(index);
			continue;
		}
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (!argument.startsWith("-") || argument === "-") {
			positionals.push(argument);
			positionalIndices.push(index);
			continue;
		}
		const { name, value } = parseOxlintOption(argument);
		if (DELEGATE_ONLY.has(name)) {
			delegateOnly = true;
			continue;
		}
		if (VALUE_OPTIONS.has(name)) {
			if (value === null) index += 1;
			continue;
		}
		if (!FLAG_OPTIONS.has(name)) known = false;
	}
	return {
		positionals,
		positionalIndices,
		delegateOnly,
		known
	};
}
function withOxlintOutputFormat(args, format) {
	const output = [];
	let positionalOnly = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (positionalOnly) {
			output.push(argument);
			continue;
		}
		if (argument === "--") {
			positionalOnly = true;
			output.push(argument);
			continue;
		}
		const { name, value } = parseOxlintOption(argument);
		if (name === "--format" || name === "-f") {
			if (value === null) index += 1;
			continue;
		}
		output.push(argument);
	}
	const terminator = output.indexOf("--");
	const option = `--format=${format}`;
	if (terminator === -1) output.push(option);
	else output.splice(terminator, 0, option);
	return output;
}
function planCanonicalOxlintComposition(args) {
	const invocation = parseOxlintInvocation(args);
	if (!invocation.known || invocation.delegateOnly || invocation.positionals.length === 0) return null;
	const removed = /* @__PURE__ */ new Set();
	let ordinaryFiles = 0;
	let tsrxFiles = 0;
	for (let offset = 0; offset < invocation.positionals.length; offset += 1) if (invocation.positionals[offset].split("?")[0].endsWith(".tsrx")) {
		tsrxFiles += 1;
		removed.add(invocation.positionalIndices[offset]);
	} else ordinaryFiles += 1;
	if (ordinaryFiles === 0 || tsrxFiles === 0) return null;
	let positionalOnly = false;
	for (const argument of args) {
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (positionalOnly || !argument.startsWith("-")) continue;
		const { name } = parseOxlintOption(argument);
		if (name === "--fix" || name === "--fix-suggestions" || name === "--fix-dangerously" || name === "--print-config") return null;
	}
	return {
		args: withOxlintOutputFormat(args.filter((_, index) => !removed.has(index)), "json"),
		ordinaryFiles,
		tsrxFiles
	};
}
function canRunCanonicalOxlint(args, cwd = process.cwd()) {
	const invocation = parseOxlintInvocation(args);
	if (invocation.delegateOnly) return true;
	if (!invocation.known || invocation.positionals.length === 0) return false;
	return invocation.positionals.every((argument) => {
		if (argument.split("?")[0].endsWith(".tsrx")) return false;
		try {
			return statSync(resolve(cwd, argument)).isFile();
		} catch {
			return false;
		}
	});
}
//#endregion
export { DELEGATE_ONLY, VALUE_OPTIONS, canRunCanonicalOxlint, importCanonicalOxlint, importDeclaredPackageBinary, parseOxlintInvocation, parseOxlintOption, planCanonicalOxlintComposition, withOxlintOutputFormat };
