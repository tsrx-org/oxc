import { nativePackageName, nativeTargetForHost } from "./native-targets.js";
import { runCaptured, runPassthrough } from "./process.js";
import { resolvePackageBinary } from "./package-binary.js";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { existsSync, statSync } from "node:fs";
//#region src/runtime.ts
const require = createRequire(import.meta.url);
const runtimeManifest = require("../package.json");
const NATIVE_PROTOCOL_VERSION = 2;
const OXC_REVISION = "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40";
const ENVIRONMENTS = {
	lint: "OXC_TSRX_LINT_BIN",
	format: "OXC_TSRX_FORMAT_BIN",
	server: "OXC_TSRX_LSP_BIN"
};
/**
* Protocol 2 ships one multi-call native executable instead of three. A
* platform package that carried `oxc-tsrx`, `oxc-tsrx-fmt`, and `oxc-tsrx-lsp`
* linked the same oxc parser, linter, and formatter three times; one binary
* that dispatches on `argv[0]` and on a leading subcommand is a little over
* half the download.
*/
const EXECUTABLE = process.platform === "win32" ? "oxc-tsrx.exe" : "oxc-tsrx";
/**
* Arguments that select a tool inside the multi-call binary. Every JS caller
* uses the explicit subcommand rather than the `argv[0]` form, because
* `argv[0]` is not dependable across hosts: a Windows `.cmd` shim and anything
* that resolves a symlink before exec both report the real file name. Linting
* needs no subcommand, so `oxc-tsrx FILE...` is unchanged from protocol 1.
*/
const SUBCOMMANDS = {
	lint: [],
	format: ["fmt"],
	server: ["lsp"]
};
const VITE_CONFIG_FILES = [
	"vite.config.ts",
	"vite.config.mts",
	"vite.config.cts",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs"
];
function linuxLibc() {
	if (process.platform !== "linux") return null;
	return (process.report?.getReport?.())?.header?.glibcVersionRuntime ? "glibc" : "musl";
}
function platformPackage() {
	return nativePackageName(nativeTargetForHost(process.platform, process.arch, linuxLibc()));
}
function assertExecutable(path, source) {
	let metadata;
	try {
		metadata = statSync(path);
	} catch {
		throw new Error(`OXC for TSRX native artifact is missing at ${path} (${source})`);
	}
	if (!metadata.isFile()) throw new Error(`OXC for TSRX native artifact is not a file at ${path} (${source})`);
	if (process.platform !== "win32" && (metadata.mode & 73) === 0) throw new Error(`OXC for TSRX native artifact is not executable at ${path} (${source})`);
	return path;
}
function validateNativeManifest(manifest, packageName, executable) {
	const metadata = manifest.oxcTsrx;
	if (manifest.version !== runtimeManifest.version) throw new Error(`OXC for TSRX native package ${packageName} has version ${manifest.version}; runtime ${runtimeManifest.version} requires an exact match`);
	if (metadata?.nativeProtocolVersion !== NATIVE_PROTOCOL_VERSION) throw new Error(`OXC for TSRX native package ${packageName} has unsupported protocol ${metadata?.nativeProtocolVersion ?? "unknown"}; expected ${NATIVE_PROTOCOL_VERSION}`);
	const expectedTarget = nativeTargetForHost(process.platform, process.arch, linuxLibc()).target;
	if (metadata.target !== expectedTarget) throw new Error(`OXC for TSRX native package ${packageName} targets ${metadata.target}; this process requires ${expectedTarget}`);
	if (metadata.oxcRevision !== OXC_REVISION) throw new Error(`OXC for TSRX native package ${packageName} pins OXC ${metadata.oxcRevision}; runtime ${runtimeManifest.version} requires ${OXC_REVISION}`);
	if (!Array.isArray(metadata.binaries) || !metadata.binaries.includes(executable)) throw new Error(`OXC for TSRX native package ${packageName} does not declare ${executable}`);
}
function resolveNativeBinary(kind) {
	const environment = ENVIRONMENTS[kind];
	if (!environment || !SUBCOMMANDS[kind]) throw new Error(`unknown native binary kind: ${kind}`);
	const explicit = process.env[environment];
	if (explicit) return assertExecutable(resolve(explicit), environment);
	const packageName = platformPackage();
	let packageRoot;
	try {
		const manifestPath = require.resolve(`${packageName}/package.json`);
		validateNativeManifest(require(manifestPath), packageName, EXECUTABLE);
		packageRoot = dirname(manifestPath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`OXC for TSRX native package ${packageName} is unavailable; install it or set ${environment}. ${detail}`);
	}
	return assertExecutable(join(packageRoot, "bin", EXECUTABLE), packageName);
}
/**
* The subcommand arguments a native invocation of `kind` must lead with. Every
* caller that spawns a native binary prepends these to its own argument vector.
*/
function nativeSubcommand(kind) {
	const subcommand = SUBCOMMANDS[kind];
	if (!subcommand) throw new Error(`unknown native binary kind: ${kind}`);
	return [...subcommand];
}
/**
* The complete native invocation for `kind`: the multi-call executable plus the
* caller's arguments behind the subcommand that selects the tool.
*/
function resolveNativeCommand(kind, args = []) {
	return {
		executable: resolveNativeBinary(kind),
		args: [...nativeSubcommand(kind), ...args]
	};
}
function findViteConfig(cwd) {
	let directory = resolve(cwd);
	const root = parse(directory).root;
	for (;;) {
		for (const file of VITE_CONFIG_FILES) {
			const candidate = join(directory, file);
			if (existsSync(candidate)) return candidate;
		}
		if (directory === root) return null;
		directory = dirname(directory);
	}
}
function moduleEntry(manifest) {
	const rootExport = manifest.exports?.["."];
	if (typeof rootExport === "string") return rootExport;
	if (rootExport && typeof rootExport === "object") return rootExport.import ?? rootExport.default ?? rootExport.require;
	return manifest.module ?? manifest.main;
}
function strictConfigJson(config, field) {
	const ancestors = [];
	return JSON.stringify(config, function serialize(key, value) {
		if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new TypeError(`Vite+ ${field} config contains non-JSON value ${key || "<root>"}; the native TSRX lane requires serializable Oxlint/Oxfmt options`);
		if (value && typeof value === "object") {
			while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
			if (ancestors.includes(value)) throw new TypeError(`Vite+ ${field} config contains a circular object graph`);
			ancestors.push(value);
		}
		return value;
	});
}
function requiresAuthoredConfigBase(field, config) {
	return (field === "lint" ? [
		"extends",
		"overrides",
		"ignorePatterns",
		"jsPlugins"
	] : ["overrides", "ignorePatterns"]).some((name) => {
		const value = config[name];
		return Array.isArray(value) ? value.length > 0 : value !== void 0 && value !== null;
	});
}
/**
* Resolve Vite+'s public universal config once in the thin Node host and write only
* the selected Oxlint/Oxfmt field to a disposable JSON file for the native process.
*/
async function prepareVitePlusConfig(field, cwd = process.cwd(), explicitConfig = null) {
	if (!Boolean(process.env.VP_VERSION || process.env.VP_COMMAND || process.env.NODE_PACKAGE_MANAGER === "vite-plus")) return null;
	const configFile = explicitConfig ? isAbsolute(explicitConfig) ? explicitConfig : resolve(cwd, explicitConfig) : findViteConfig(cwd);
	if (configFile === null) return null;
	const manifestPath = createRequire(join(resolve(cwd), "package.json")).resolve("vite-plus/package.json");
	const packageRoot = dirname(manifestPath);
	const entry = moduleEntry(JSON.parse(await readFile(manifestPath, "utf8")));
	if (!entry) throw new Error("installed Vite+ package has no public module entry");
	const vitePlus = await import(pathToFileURL(resolve(packageRoot, entry)).href);
	if (typeof vitePlus.resolveConfig !== "function") throw new Error("installed Vite+ package does not export public resolveConfig");
	const selected = (await vitePlus.resolveConfig({ configFile }, "build"))[field] ?? {};
	if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new TypeError(`Vite+ ${field} config must resolve to an object`);
	const directory = await mkdtemp(join(tmpdir(), `oxc-tsrx-vite-plus-${field}-`));
	const path = join(directory, field === "lint" ? ".oxlintrc.json" : ".oxfmtrc.json");
	try {
		await writeFile(path, `${strictConfigJson(selected, field)}\n`);
	} catch (error) {
		await rm(directory, {
			recursive: true,
			force: true
		});
		throw error;
	}
	return {
		path,
		source: configFile,
		base: dirname(configFile),
		requiresAuthoredBase: requiresAuthoredConfigBase(field, selected),
		typeAware: field === "lint" && selected.options?.typeAware === true,
		typeCheck: field === "lint" && selected.options?.typeCheck === true,
		async cleanup() {
			await rm(directory, {
				recursive: true,
				force: true
			});
		}
	};
}
function isViteConfigPath(path) {
	if (!path) return false;
	return VITE_CONFIG_FILES.some((name) => path.endsWith(name));
}
function replaceConfigArgument(args, configPath) {
	const output = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "-c" || argument === "--config") {
			index += 1;
			continue;
		}
		if (argument.startsWith("-c=") || argument.startsWith("-c") && argument.length > 2 || argument.startsWith("--config=")) continue;
		output.push(argument);
	}
	const terminator = output.indexOf("--");
	const values = ["--config", configPath];
	if (terminator === -1) output.push(...values);
	else output.splice(terminator, 0, ...values);
	return output;
}
function canonicalToolEnvironment(useResolvedViteConfig) {
	if (!useResolvedViteConfig) return process.env;
	const environment = { ...process.env };
	delete environment.VP_VERSION;
	return environment;
}
function positionalIndices(args, valueOptions) {
	const indices = [];
	let positionalOnly = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (positionalOnly) {
			indices.push(index);
			continue;
		}
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (!argument.startsWith("-") || argument === "-") {
			indices.push(index);
			continue;
		}
		if (!argument.includes("=") && valueOptions.has(argument)) index += 1;
	}
	return indices;
}
function removeExplicitTsrx(args, valueOptions) {
	const positions = positionalIndices(args, valueOptions);
	const removed = new Set(positions.filter((index) => args[index].split("?")[0].endsWith(".tsrx")));
	return {
		args: args.filter((_, index) => !removed.has(index)),
		hadPositionals: positions.length > 0,
		remainingPositionals: positions.length - removed.size
	};
}
function slash(path) {
	return sep === "/" ? path : path.split(sep).join("/");
}
function hasMagic(path) {
	return /[*?[\]{}()!]/u.test(path);
}
async function classifyPattern(raw, cwd, positives, patterns, directories) {
	const negative = raw.startsWith("!");
	const value = negative ? raw.slice(1) : raw;
	const absolute = isAbsolute(value) ? value : resolve(cwd, value);
	if (!hasMagic(value)) try {
		const metadata = await stat(absolute);
		if (metadata.isFile()) {
			if (!negative && absolute.endsWith(".tsrx")) positives.add(absolute);
			else if (negative) patterns.push(`!${slash(absolute)}`);
			return;
		}
		if (metadata.isDirectory()) {
			if (negative) patterns.push(`!${slash(join(absolute, "**/*.tsrx"))}`);
			else directories.push(absolute);
			return;
		}
	} catch {}
	patterns.push(`${negative ? "!" : ""}${slash(value)}`);
}
async function classifyPatterns(inputs, cwd, positives, patterns, directories) {
	const classified = await Promise.all(inputs.map(async (input) => {
		const entryPositives = /* @__PURE__ */ new Set();
		const entryPatterns = [];
		const entryDirectories = [];
		await classifyPattern(input, cwd, entryPositives, entryPatterns, entryDirectories);
		return {
			entryPositives,
			entryPatterns,
			entryDirectories
		};
	}));
	for (const { entryPositives, entryPatterns, entryDirectories } of classified) {
		for (const positive of entryPositives) positives.add(positive);
		for (const pattern of entryPatterns) patterns.push(pattern);
		for (const directory of entryDirectories) directories.push(directory);
	}
}
/**
* A file list as arguments the native leaf accepts. A short list travels on the
* command line as before. A long one is written to a temporary file and named
* with `--paths-file`, because a host's argument limit is reached by a real
* repository (E2BIG past about a megabyte on macOS and Linux, a 32 KiB command
* line on Windows, which a few hundred paths fill). The caller disposes of it.
*/
async function pathArguments(files, budget = 24e3) {
	if (files.reduce((total, file) => total + Buffer.byteLength(file) + 1, 0) <= budget) return {
		args: [...files],
		cleanup: async () => {}
	};
	const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-paths-"));
	const path = join(directory, "paths.txt");
	await writeFile(path, `${files.join("\n")}\n`);
	return {
		args: ["--paths-file", path],
		cleanup: () => rm(directory, {
			recursive: true,
			force: true
		})
	};
}
/**
* Directories are walked by the native leaf, on the same `ignore` crate
* canonical Oxlint walks with, so `.gitignore` and `.ignore` files are honoured
* and `node_modules` and `.git` are never entered. Without that, a monorepo
* that keeps gitignored copies of itself handed every one of them to the leaf.
* Returns null when no native package is installed, and the caller falls back
* to the plain glob so the run can still reach the error that names the missing
* package.
*/
async function walkWithNativeLeaf(directories, cwd, kind) {
	let command;
	try {
		command = resolveNativeCommand(kind, ["--discover"]);
	} catch {
		return null;
	}
	const paths = await pathArguments(directories);
	try {
		const result = await runCaptured(command.executable, [...command.args, ...paths.args], { cwd });
		if (result.status !== 0) throw new Error(`.tsrx discovery failed: ${(result.stderr || result.stdout).trim()}`);
		const report = JSON.parse(result.stdout);
		if (!Array.isArray(report?.files)) throw new Error(".tsrx discovery returned no file list");
		return report.files.map((file) => resolve(file));
	} finally {
		await paths.cleanup();
	}
}
/**
* `kind` names the leaf that walks directories, `lint` or `format`: both
* answer `--discover` identically, and each command resolves its own binary.
*/
async function discoverTsrxFiles(positionals, cwd = process.cwd(), kind = "lint") {
	const positives = /* @__PURE__ */ new Set();
	const patterns = [];
	const directories = [];
	await classifyPatterns(positionals.length === 0 ? ["."] : positionals, cwd, positives, patterns, directories);
	const walked = directories.length > 0 && !patterns.some((pattern) => pattern.startsWith("!")) ? await walkWithNativeLeaf(directories, cwd, kind) : null;
	if (walked === null) for (const directory of directories) patterns.push(slash(join(directory, "**/*.tsrx")));
	else for (const file of walked) positives.add(file);
	if (patterns.length > 0) {
		const { glob } = await import("tinyglobby");
		const matches = await glob(patterns, {
			cwd,
			absolute: true,
			onlyFiles: true,
			dot: true,
			followSymbolicLinks: false,
			ignore: ["**/node_modules/**", "**/.git/**"]
		});
		for (const match of matches) if (match.endsWith(".tsrx")) positives.add(resolve(match));
	}
	return [...positives].sort();
}
function argumentValue(args, names) {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (names.has(argument)) return args[index + 1] ?? null;
		for (const name of names) {
			if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
			if (name.length === 2 && argument.startsWith(name) && argument.length > name.length) return argument.slice(name.length);
		}
	}
	return null;
}
function ensureSupportedOutput(format, files) {
	if (files.length > 0 && format !== "default" && format !== "json") throw new Error(`OXC for TSRX currently combines default and json lint output; ${format} is unavailable for mixed .tsrx runs`);
}
//#endregion
export { argumentValue, canonicalToolEnvironment, discoverTsrxFiles, ensureSupportedOutput, isViteConfigPath, pathArguments, platformPackage, prepareVitePlusConfig, removeExplicitTsrx, replaceConfigArgument, resolveNativeBinary, resolveNativeCommand, resolvePackageBinary, runCaptured, runPassthrough };
