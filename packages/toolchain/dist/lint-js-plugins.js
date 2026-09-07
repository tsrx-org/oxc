import { runCaptured } from "./process.js";
import { resolvePackageBinary } from "./package-binary.js";
import { pathArguments, resolveNativeCommand } from "./runtime.js";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
//#region src/lint-js-plugins.ts
const OXLINT_JS_PLUGIN_LANE_MINIMUM = "1.74.0";
const OXLINT_JS_PLUGIN_LANE_BELOW = "2.0.0";
const CONFIG_FILE_NAMES = [".oxlintrc.json", ".oxlintrc.jsonc"];
const BUILTIN_CATEGORIES = [
	"correctness",
	"nursery",
	"pedantic",
	"perf",
	"restriction",
	"style",
	"suspicious"
];
function versionParts(version) {
	return String(version).split(/[-+]/u, 1)[0].split(".").map((part) => Number.parseInt(part, 10));
}
function compareVersions(left, right) {
	const a = versionParts(left);
	const b = versionParts(right);
	for (let index = 0; index < 3; index += 1) {
		const first = Number.isInteger(a[index]) ? a[index] : 0;
		const second = Number.isInteger(b[index]) ? b[index] : 0;
		if (first !== second) return first < second ? -1 : 1;
	}
	return 0;
}
function laneSupportsOxlintVersion(version) {
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+/u.test(version)) return false;
	return compareVersions(version, "1.74.0") >= 0 && compareVersions(version, "2.0.0") < 0;
}
function oxlintVersionRefusal(version) {
	return `oxlint (oxc-tsrx): JS plugins on .tsrx require oxlint >=${OXLINT_JS_PLUGIN_LANE_MINIMUM} <${OXLINT_JS_PLUGIN_LANE_BELOW}; found ${version}. Refusing rather than silently skipping your rules.`;
}
/** The pinned Oxlint's own version, read through its public `./package.json` export. */
function installedOxlintVersion(fromUrl = import.meta.url) {
	const manifest = createRequire(fromUrl)("oxlint-current/package.json");
	return typeof manifest.version === "string" ? manifest.version : "unknown";
}
/**
* The one line this lane prints before the report.
*
* The extra parse is real and the user is told about it every time, on stderr,
* with the exact key that turns it off. `--silent` suppresses it along with
* everything else the command would have printed.
*/
function jsPluginDisclosure(fileCount) {
	return `oxlint (oxc-tsrx): running JS plugins on ${fileCount} .tsrx file(s) by linting the TSX projection; this parses each of those files once more. Disable with "settings": { "oxcTsrx": { "jsPluginsOnTsrx": false } }.`;
}
/**
* The line that reports plugin diagnostics this lane could not place.
*
* A diagnostic whose labels land on text the projection inserted has no
* position in the file the developer wrote, so it is dropped rather than
* reported somewhere they can see no such code. Dropping it quietly is the same
* silence this lane exists to remove, one level down: the rule looks like it
* simply found nothing. So the count reaches stderr, and
* `oxcTsrx.jsPluginProjection.unmapped` carries it in `--format=json` too.
*/
function jsPluginUnmappedNote(count) {
	return `oxlint (oxc-tsrx): ${count} JS plugin diagnostic(s) on .tsrx had no position in the source you wrote (they landed on text the TSX projection inserted) and were dropped. See oxcTsrx.jsPluginProjection.unmapped in --format=json.`;
}
/**
* Read a `.oxlintrc.json` or `.oxlintrc.jsonc`.
*
* Comments and trailing commas are stripped rather than parsed, because this
* file only ever re-emits plain JSON. Anything it does not understand is copied
* through untouched, so Oxlint keeps deciding what the configuration means.
*/
function parseOxlintConfigText(text) {
	let stripped = "";
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (character === "\"") {
			const start = index;
			index += 1;
			while (index < text.length) {
				if (text[index] === "\\") {
					index += 2;
					continue;
				}
				if (text[index] === "\"") {
					index += 1;
					break;
				}
				index += 1;
			}
			stripped += text.slice(start, index);
			continue;
		}
		if (character === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
			continue;
		}
		if (character === "/" && text[index + 1] === "*") {
			const end = text.indexOf("*/", index + 2);
			index = end === -1 ? text.length : end + 2;
			continue;
		}
		stripped += character;
		index += 1;
	}
	return JSON.parse(stripped.replace(/,(\s*[}\]])/gu, "$1"));
}
async function readOxlintConfig(path) {
	try {
		const parsed = parseOxlintConfigText(await readFile(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
/** The nearest Oxlint config at or above `directory`, the way Oxlint looks for one. */
function findOxlintConfig(directory) {
	let current = resolve(directory);
	const root = parse(current).root;
	for (;;) {
		for (const name of CONFIG_FILE_NAMES) {
			const candidate = join(current, name);
			if (existsSync(candidate)) return candidate;
		}
		if (current === root) return null;
		current = dirname(current);
	}
}
/**
* Every entry of one config's `jsPlugins`, normalized.
*
* Oxlint accepts both a bare specifier and `{ name, specifier }`, where `name`
* is the alias the plugin's rules are configured under. Vite+ writes the second
* form. The alias, when there is one, saves this lane from having to import the
* module to learn the plugin's namespace.
*/
function declaredJsPlugins(config) {
	const declared = config?.jsPlugins;
	if (!Array.isArray(declared)) return [];
	const entries = [];
	for (const entry of declared) {
		if (typeof entry === "string" && entry.length > 0) {
			entries.push({
				specifier: entry,
				name: null
			});
			continue;
		}
		if (entry !== null && typeof entry === "object" && typeof entry.specifier === "string") entries.push({
			specifier: entry.specifier,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : null
		});
	}
	return entries;
}
/**
* Every JavaScript plugin one configuration brings in, and whether the project
* turned this lane off.
*
* `extends` is followed because a project that keeps its shared rules in one
* file and its per-package config in another still expects its plugins to run.
* Missing this would not be a visible error; it would be the rule quietly not
* running, which is exactly the failure this lane exists to remove. Each plugin
* specifier travels with the directory of the config that declared it, because
* that is what it resolves against.
*/
async function collectLaneFacts(path, directoryOverride = null, seen = /* @__PURE__ */ new Set(), depth = 0) {
	const facts = {
		config: null,
		jsPlugins: [],
		optedOut: void 0
	};
	if (depth > 8 || seen.has(path)) return facts;
	seen.add(path);
	const config = await readOxlintConfig(path);
	if (config === null) return facts;
	facts.config = config;
	const directory = directoryOverride ?? dirname(path);
	if (Array.isArray(config.extends)) for (const specifier of config.extends) {
		if (typeof specifier !== "string") continue;
		const resolved = resolveSpecifier(specifier, directory);
		if (!isAbsolute(resolved) || !existsSync(resolved)) continue;
		const inherited = await collectLaneFacts(resolved, null, seen, depth + 1);
		facts.jsPlugins.push(...inherited.jsPlugins);
		if (inherited.optedOut !== void 0) facts.optedOut = inherited.optedOut;
	}
	for (const entry of declaredJsPlugins(config)) facts.jsPlugins.push({
		...entry,
		directory
	});
	if (Array.isArray(config.overrides)) for (const override of config.overrides) for (const entry of declaredJsPlugins(override)) facts.jsPlugins.push({
		...entry,
		directory
	});
	const own = config.settings?.oxcTsrx?.jsPluginsOnTsrx;
	if (typeof own === "boolean") facts.optedOut = own === false;
	return facts;
}
/** Resolve one plugin or extends specifier against the directory its config lives in. */
function resolveSpecifier(specifier, configDirectory) {
	if (isAbsolute(specifier)) return specifier;
	if (specifier.startsWith(".")) return resolve(configDirectory, specifier);
	try {
		return createRequire(join(configDirectory, "package.json")).resolve(specifier);
	} catch {
		return specifier;
	}
}
/**
* The plugin namespaces this project's `jsPlugins` contribute, or `null` when
* they cannot all be determined.
*
* A rule's diagnostic code is `<plugin meta.name>(<rule>)`, so this is what
* separates a diagnostic the user's own JavaScript produced from a built-in one
* that a `rules` entry re-enabled behind the categories this lane turns off.
* `null` means "do not filter by namespace", which is strictly more permissive
* and can only ever leave a duplicate in, never drop a user's rule.
*/
async function pluginNamespaces(declared) {
	const namespaces = /* @__PURE__ */ new Set();
	for (const { specifier, name: alias, directory } of declared) {
		if (alias !== null) {
			namespaces.add(alias);
			continue;
		}
		const resolved = resolveSpecifier(specifier, directory);
		try {
			const module = await (isAbsolute(resolved) ? import(pathToFileURL(resolved).href) : import(resolved));
			const name = module.default?.meta?.name ?? module.meta?.name;
			if (typeof name !== "string" || name.length === 0) return null;
			namespaces.add(name);
		} catch {
			return null;
		}
	}
	return namespaces;
}
/**
* A glob and the same glob with `.tsx` appended.
*
* The mirror names each projection `<authored name>.tsx`, so a project that
* wrote `overrides: [{ files: ["**\/*.tsrx"] }]` would match nothing there. This
* was measured rather than assumed: `**\/*.tsrx` does not match `demo.tsrx.tsx`,
* and `**\/*.tsrx.tsx` does.
*/
function projectedGlobs(globs) {
	if (!Array.isArray(globs)) return globs;
	const expanded = [];
	for (const glob of globs) {
		expanded.push(glob);
		if (typeof glob === "string" && !expanded.includes(`${glob}.tsx`)) expanded.push(`${glob}.tsx`);
	}
	return expanded;
}
/** One `jsPlugins` entry with its specifier resolved, in either form Oxlint accepts. */
function absoluteJsPlugin(entry, configDirectory) {
	if (typeof entry === "string") return resolveSpecifier(entry, configDirectory);
	if (entry !== null && typeof entry === "object" && typeof entry.specifier === "string") return {
		...entry,
		specifier: resolveSpecifier(entry.specifier, configDirectory)
	};
	return entry;
}
/**
* The user's configuration as the projection run should see it.
*
* Everything Oxlint understands survives, because Oxlint is the thing resolving
* it. Four edits, each for one reason:
*
*   * every built-in category off, so the native lane stays the only reporter of
*     built-in rules and nothing is printed twice;
*   * `jsPlugins` and `extends` made absolute, because the config is read from a
*     different directory than the one it was written in;
*   * `ignorePatterns` dropped, because the native lane has already applied them
*     and they were written against `.tsrx` names the mirror does not use;
*   * every `overrides` glob given a `.tsx` twin, so an override aimed at
*     `.tsrx` still selects that file's projection.
*/
function projectionConfig(config, configDirectory) {
	const projected = { ...config };
	delete projected.$schema;
	delete projected.ignorePatterns;
	projected.categories = { ...config.categories ?? {} };
	for (const category of BUILTIN_CATEGORIES) projected.categories[category] = "off";
	if (Array.isArray(config.jsPlugins)) projected.jsPlugins = config.jsPlugins.map((entry) => absoluteJsPlugin(entry, configDirectory));
	if (Array.isArray(config.extends)) projected.extends = config.extends.map((specifier) => typeof specifier === "string" ? resolveSpecifier(specifier, configDirectory) : specifier);
	if (Array.isArray(config.overrides)) projected.overrides = config.overrides.map((override) => {
		if (override === null || typeof override !== "object") return override;
		const mapped = { ...override };
		mapped.files = projectedGlobs(override.files);
		if (override.excludeFiles !== void 0) mapped.excludeFiles = projectedGlobs(override.excludeFiles);
		if (Array.isArray(override.jsPlugins)) mapped.jsPlugins = override.jsPlugins.map((entry) => absoluteJsPlugin(entry, configDirectory));
		return mapped;
	});
	return projected;
}
/** The user's configuration with `jsPlugins` removed, for the native lane. */
function nativeLaneConfig(config) {
	const stripped = { ...config };
	delete stripped.jsPlugins;
	if (Array.isArray(config.overrides)) stripped.overrides = config.overrides.map((override) => {
		if (override === null || typeof override !== "object") return override;
		const mapped = { ...override };
		delete mapped.jsPlugins;
		return mapped;
	});
	return stripped;
}
/** Where one authored path lives inside the mirror, relative to the mirror root. */
function mirrorRelativePath(cwd, path) {
	const relativePath = relative(cwd, path);
	if (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return `${relativePath}.tsx`;
	const flattened = path.replace(/^[A-Za-z]:/u, "").split(/[\\/]/u).filter((segment) => segment.length > 0 && segment !== "..").join(sep);
	return `${join("__outside_cwd__", flattened)}.tsx`;
}
async function writeMirrorFile(root, relativePath, contents) {
	const absolute = join(root, relativePath);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, contents);
	return absolute;
}
/**
* Decide whether the JavaScript plugin lane runs for this invocation, and set it
* up if it does.
*
* Returns `null` when there is nothing to do, or one of:
*
*   * `{ status: "opted-out" }` — the project turned the lane off, so the native
*     lane keeps `jsPlugins` and answers with its own refusal;
*   * `{ status: "version-refused", message }` — the installed Oxlint is outside
*     the supported range, so the command must stop rather than skip rules;
*   * `{ status: "active", ... }` — ready to run.
*/
async function preparePluginLane({ cwd, files, viteConfig, explicitConfig }) {
	if (files.length === 0) return null;
	const nativeSource = viteConfig ? {
		path: viteConfig.path,
		base: viteConfig.base,
		explicit: true,
		directory: viteConfig.base
	} : explicitConfig ? {
		path: resolve(cwd, explicitConfig),
		base: dirname(resolve(cwd, explicitConfig)),
		explicit: true
	} : (() => {
		const discovered = findOxlintConfig(cwd);
		return discovered === null ? null : {
			path: discovered,
			base: dirname(discovered),
			explicit: false
		};
	})();
	const configs = /* @__PURE__ */ new Map();
	const laneFiles = [];
	let sawOptOut = false;
	for (const file of files) {
		const path = nativeSource?.explicit ? nativeSource.path : findOxlintConfig(dirname(file));
		if (path === null || path === void 0) continue;
		let entry = configs.get(path);
		if (entry === void 0) {
			const directoryOverride = path === nativeSource?.path ? nativeSource.directory ?? null : null;
			const facts = await collectLaneFacts(path, directoryOverride);
			entry = {
				path,
				config: facts.config,
				directory: directoryOverride ?? dirname(path),
				jsPlugins: facts.jsPlugins,
				stripsNative: declaredJsPlugins(facts.config).length > 0,
				optedOut: facts.optedOut === true,
				files: []
			};
			configs.set(path, entry);
		}
		if (entry.jsPlugins.length === 0) continue;
		if (entry.optedOut) {
			sawOptOut = true;
			continue;
		}
		entry.files.push(file);
		laneFiles.push(file);
	}
	const nativeConfigEntry = nativeSource === null ? null : configs.get(nativeSource.path);
	const nativeNeedsStrip = Boolean(nativeConfigEntry && nativeConfigEntry.stripsNative && !nativeConfigEntry.optedOut);
	if (laneFiles.length === 0) return sawOptOut ? { status: "opted-out" } : null;
	const version = installedOxlintVersion();
	if (!laneSupportsOxlintVersion(version)) return {
		status: "version-refused",
		message: oxlintVersionRefusal(version)
	};
	const active = [...configs.values()].filter((entry) => entry.files.length > 0);
	const temporary = [];
	let nativeConfig = null;
	if (nativeNeedsStrip) {
		const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-native-config-"));
		temporary.push(directory);
		const path = join(directory, ".oxlintrc.json");
		await writeFile(path, `${JSON.stringify(nativeLaneConfig(nativeConfigEntry.config))}\n`);
		nativeConfig = {
			path,
			base: nativeSource.base,
			typeAware: viteConfig?.typeAware === true,
			typeCheck: viteConfig?.typeCheck === true
		};
	}
	return {
		status: "active",
		files: laneFiles,
		fileCount: laneFiles.length,
		nativeConfig,
		notice: jsPluginDisclosure(laneFiles.length),
		async run() {
			return runPluginLane({
				cwd,
				configs: active,
				nativeConfig,
				explicit: Boolean(nativeSource?.explicit),
				temporary
			});
		},
		async cleanup() {
			await Promise.all(temporary.map((directory) => rm(directory, {
				recursive: true,
				force: true
			})));
		}
	};
}
async function emitProjections(cwd, files, nativeConfig) {
	const args = ["--emit-plugin-projection"];
	if (nativeConfig) args.push("--config", nativeConfig.path, "--config-base", nativeConfig.base);
	const paths = await pathArguments(files);
	let result;
	try {
		const command = resolveNativeCommand("lint", [...args, ...paths.args]);
		result = await runCaptured(command.executable, command.args, { cwd });
	} finally {
		await paths.cleanup();
	}
	if (result.status !== 0) throw new Error(`the native TSRX projection needed for JS plugins failed:\n${result.stderr || result.stdout}`);
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`the native TSRX projection needed for JS plugins returned non-JSON output:\n${result.stdout}`);
	}
	return Array.isArray(parsed.projections) ? parsed.projections : [];
}
async function mapDiagnostics(cwd, byFile) {
	const command = resolveNativeCommand("lint", ["--map-plugin-diagnostics"]);
	const request = JSON.stringify({ files: [...byFile].map(([path, diagnostics]) => ({
		path,
		diagnostics
	})) });
	const result = await runCaptured(command.executable, command.args, {
		cwd,
		input: request
	});
	if (result.status !== 0) throw new Error(`mapping JS plugin diagnostics back to authored .tsrx positions failed:\n${result.stderr || result.stdout}`);
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`mapping JS plugin diagnostics back to authored .tsrx positions returned non-JSON output:\n${result.stdout}`);
	}
	return Array.isArray(parsed.files) ? parsed.files : [];
}
function diagnosticNamespace(diagnostic) {
	const code = typeof diagnostic.code === "string" ? diagnostic.code : "";
	const open = code.indexOf("(");
	return open === -1 ? code : code.slice(0, open);
}
/**
* The failures Oxlint's plugin host itself reported, in the user's own terms.
*
* A rule that throws does not come back as a diagnostic on a file: Oxlint reports
* it with an empty `filename`, no `code`, and no labels, which is exactly the
* shape every other filter in this file drops. Dropping it too would mean a
* broken rule looks like a rule that found nothing, which is the failure this
* whole lane exists to remove. `paths` rewrites the mirror path Oxlint saw back
* to the file the developer opened.
*/
/**
* Mirror paths to the authored paths they stand for, each mirror path recorded
* under both the name it was written with and the one a `realpath` resolves it
* to. Oxlint reports the resolved name, and on macOS a temporary directory is
* always a symlink away from it.
*/
function authoredPathMap(pairs) {
	const map = /* @__PURE__ */ new Map();
	for (const [mirrorPath, authored] of pairs) {
		map.set(mirrorPath, authored);
		try {
			map.set(realpathSync(mirrorPath), authored);
		} catch {}
	}
	return map;
}
function pluginHostFailures(report, paths = /* @__PURE__ */ new Map()) {
	const failures = [];
	for (const diagnostic of report?.diagnostics ?? []) {
		if (typeof diagnostic?.message !== "string" || diagnostic.message === "") continue;
		if (diagnostic.filename !== void 0 && diagnostic.filename !== "") continue;
		if ((diagnostic.labels ?? []).length > 0) continue;
		if (typeof diagnostic.code === "string" && diagnostic.code !== "") continue;
		let message = diagnostic.message.split(/\n\s+at /u, 1)[0].trim();
		const rewrites = [...paths].sort(([left], [right]) => right.length - left.length);
		for (const [from, to] of rewrites) message = message.split(from).join(to);
		failures.push(message);
	}
	return failures;
}
async function runPluginLane({ cwd, configs, nativeConfig, explicit, temporary }) {
	const projections = await emitProjections(cwd, configs.flatMap((entry) => entry.files), nativeConfig);
	if (projections.length === 0) return {
		diagnostics: [],
		files: 0,
		extraParses: 0,
		unmapped: 0,
		failures: []
	};
	const mirror = await mkdtemp(join(tmpdir(), "oxc-tsrx-js-plugins-"));
	temporary.push(mirror);
	const authoredByMirrorPath = /* @__PURE__ */ new Map();
	const mirrored = [];
	for (const projection of projections) {
		if (typeof projection?.path !== "string" || typeof projection.projected !== "string") continue;
		const relativePath = mirrorRelativePath(cwd, projection.path);
		await writeMirrorFile(mirror, relativePath, projection.projected);
		authoredByMirrorPath.set(relativePath, projection.path);
		mirrored.push(relativePath);
	}
	if (mirrored.length === 0) return {
		diagnostics: [],
		files: 0,
		extraParses: 0,
		unmapped: 0,
		failures: []
	};
	const namespaces = /* @__PURE__ */ new Set();
	let namespacesKnown = true;
	for (const entry of configs) {
		const projected = projectionConfig(entry.config, entry.directory);
		const relativeConfig = explicit ? ".oxlintrc.json" : (() => {
			const candidate = relative(cwd, entry.path);
			return candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate) ? candidate : ".oxlintrc.json";
		})();
		await writeMirrorFile(mirror, relativeConfig, `${JSON.stringify(projected, null, 2)}\n`);
		entry.mirrorConfig = relativeConfig;
		const found = await pluginNamespaces(entry.jsPlugins);
		if (found === null) namespacesKnown = false;
		else for (const name of found) namespaces.add(name);
	}
	const oxlintArgs = [resolvePackageBinary("oxlint-current", "oxlint", import.meta.url), "--format=json"];
	if (explicit) oxlintArgs.push("--config", configs[0].mirrorConfig);
	const result = await runCaptured(process.execPath, [...oxlintArgs, ...mirrored], {
		cwd: mirror,
		env: process.env
	});
	if (result.status > 1) throw new Error(`running your JS plugins over the .tsrx projection failed:\n${result.stderr || result.stdout}`);
	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		throw new Error(`running your JS plugins over the .tsrx projection returned non-JSON output:\n${result.stdout}${result.stderr}`);
	}
	const byFile = /* @__PURE__ */ new Map();
	for (const relativePath of mirrored) byFile.set(authoredByMirrorPath.get(relativePath), []);
	for (const diagnostic of report.diagnostics ?? []) {
		const authored = authoredByMirrorPath.get(diagnostic.filename);
		if (authored === void 0) continue;
		const namespace = diagnosticNamespace(diagnostic);
		if (namespace === "") continue;
		if (namespacesKnown && !namespaces.has(namespace)) continue;
		byFile.get(authored).push(diagnostic);
	}
	const nonEmpty = new Map([...byFile].filter(([, diagnostics]) => diagnostics.length > 0));
	const diagnostics = [];
	let unmapped = 0;
	if (nonEmpty.size > 0) for (const file of await mapDiagnostics(cwd, nonEmpty)) {
		if (Number.isSafeInteger(file.unmapped) && file.unmapped > 0) unmapped += file.unmapped;
		for (const diagnostic of file.diagnostics ?? []) diagnostics.push({
			...diagnostic,
			filename: file.path
		});
	}
	return {
		diagnostics,
		files: mirrored.length,
		extraParses: mirrored.length,
		unmapped,
		failures: pluginHostFailures(report, authoredPathMap([...authoredByMirrorPath].map(([relativePath, authored]) => [join(mirror, relativePath), authored])))
	};
}
/** The flag that turns this module into the editor's lane host. */
const LANE_HOST_FLAG = "--oxc-tsrx-js-plugin-lane-host";
/**
* The one line the editor session prints when the lane starts.
*
* An editor has no report to put a notice in front of, so this goes to the
* server's stderr, which every LSP client surfaces as its output log. It names
* the extra parse and the exact key that turns it off, the same way the command
* line's own notice does.
*/
function jsPluginEditorDisclosure() {
	return "oxc-tsrx-lsp: running this project's Oxlint JS plugins on .tsrx by linting each file's TSX projection; this parses every linted .tsrx file once more. Disable with \"settings\": { \"oxcTsrx\": { \"jsPluginsOnTsrx\": false } }.";
}
/** One long-lived mirror, config set, and Oxlint invocation for an editor session. */
var EditorPluginLane = class {
	cwd;
	mirror;
	configs;
	constructor(cwd) {
		this.cwd = resolve(cwd);
		this.mirror = null;
		this.configs = /* @__PURE__ */ new Map();
	}
	async mirrorRoot() {
		if (this.mirror === null) this.mirror = await mkdtemp(join(tmpdir(), "oxc-tsrx-js-plugins-lsp-"));
		return this.mirror;
	}
	/**
	* The configuration governing one directory, resolved and mirrored once.
	*
	* A configuration file that changes during the session is not re-read here:
	* the language server watches `.oxlintrc.json`, rebuilds its workspace tool on
	* a change, and that drops this whole process along with the stale cache.
	*/
	async entryFor(directory) {
		const path = findOxlintConfig(directory);
		if (path === null) return { active: false };
		const cached = this.configs.get(path);
		if (cached !== void 0) return cached;
		const facts = await collectLaneFacts(path);
		let entry = { active: false };
		if (facts.config !== null && facts.jsPlugins.length > 0 && facts.optedOut !== true) {
			const mirror = await this.mirrorRoot();
			const candidate = relative(this.cwd, path);
			await writeMirrorFile(mirror, candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate) ? candidate : ".oxlintrc.json", `${JSON.stringify(projectionConfig(facts.config, dirname(path)), null, 2)}\n`);
			entry = {
				active: true,
				namespaces: await pluginNamespaces(facts.jsPlugins)
			};
		}
		this.configs.set(path, entry);
		return entry;
	}
	/**
	* Run this project's JavaScript plugins over one projection.
	*
	* Returns Oxlint's own diagnostics with their label spans still measured in
	* projection bytes. Mapping them to authored bytes is the caller's job,
	* because the caller is the process that owns the span map.
	*/
	async lint(path, projection) {
		const entry = await this.entryFor(dirname(path));
		if (!entry.active) return [];
		const mirror = await this.mirrorRoot();
		const relativePath = mirrorRelativePath(this.cwd, path);
		await writeMirrorFile(mirror, relativePath, projection);
		const oxlintBinary = resolvePackageBinary("oxlint-current", "oxlint", import.meta.url);
		const result = await runCaptured(process.execPath, [
			oxlintBinary,
			"--format=json",
			relativePath
		], {
			cwd: mirror,
			env: process.env
		});
		if (result.status > 1) throw new Error(`running your JS plugins over the .tsrx projection failed:\n${result.stderr || result.stdout}`);
		let report;
		try {
			report = JSON.parse(result.stdout);
		} catch {
			throw new Error(`running your JS plugins over the .tsrx projection returned non-JSON output:\n${result.stdout}${result.stderr}`);
		}
		const failures = pluginHostFailures(report, authoredPathMap([[join(mirror, relativePath), path]]));
		if (failures.length > 0) throw new Error(failures.join("\n"));
		const diagnostics = [];
		for (const diagnostic of report.diagnostics ?? []) {
			if (diagnostic.filename !== relativePath) continue;
			const namespace = diagnosticNamespace(diagnostic);
			if (namespace === "") continue;
			if (entry.namespaces !== null && !entry.namespaces.has(namespace)) continue;
			const labels = [];
			for (const label of diagnostic.labels ?? []) {
				const offset = label?.span?.offset;
				if (!Number.isSafeInteger(offset) || offset < 0) continue;
				const length = label.span.length;
				labels.push({
					offset,
					length: Number.isSafeInteger(length) && length > 0 ? length : 0
				});
			}
			if (labels.length === 0) continue;
			diagnostics.push({
				code: typeof diagnostic.code === "string" ? diagnostic.code : null,
				message: typeof diagnostic.message === "string" ? diagnostic.message : "",
				severity: diagnostic.severity === "error" ? "error" : "warning",
				help: typeof diagnostic.help === "string" ? diagnostic.help : null,
				labels
			});
		}
		return diagnostics;
	}
	async cleanup() {
		if (this.mirror !== null) await rm(this.mirror, {
			recursive: true,
			force: true
		});
	}
};
/**
* Serve the editor's plugin lane over newline-delimited JSON on stdio.
*
* The first line out is the handshake: `{"ready":true,...}`, or
* `{"ready":false,"error":...}` when the installed Oxlint is outside the range
* this lane was established against. Refusing out loud is the point — an editor
* that quietly stopped running a developer's rule is the failure this whole lane
* exists to remove, and a squiggle that silently disappears is worse than one
* that never appeared.
*
* Every request is `{id, path, projection}` and every answer is either
* `{id, diagnostics}` or `{id, error}`. Requests are served one at a time and in
* order, so a burst of keystrokes cannot interleave two Oxlint runs over the
* same mirror file.
*/
async function runJsPluginLaneHost({ cwd = process.cwd(), input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
	const version = installedOxlintVersion();
	if (!laneSupportsOxlintVersion(version)) {
		output.write(`${JSON.stringify({
			ready: false,
			error: oxlintVersionRefusal(version)
		})}\n`);
		return 0;
	}
	const lane = new EditorPluginLane(cwd);
	errorOutput.write(`${jsPluginEditorDisclosure()}\n`);
	output.write(`${JSON.stringify({
		ready: true,
		oxlint: version
	})}\n`);
	let pending = Promise.resolve();
	let buffer = "";
	await new Promise((finished) => {
		const drain = () => {
			pending.then(() => finished(), () => finished());
		};
		input.setEncoding("utf8");
		input.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line === "") continue;
				let request;
				try {
					request = JSON.parse(line);
				} catch {
					continue;
				}
				pending = pending.then(async () => {
					let answer;
					try {
						answer = {
							id: request.id,
							diagnostics: await lane.lint(String(request.path), String(request.projection))
						};
					} catch (error) {
						answer = {
							id: request.id,
							error: error instanceof Error ? error.message : String(error)
						};
					}
					output.write(`${JSON.stringify(answer)}\n`);
				});
			}
		});
		input.once("end", drain);
		input.once("close", drain);
		input.once("error", drain);
	});
	await lane.cleanup();
	return 0;
}
/**
* Whether this module is the process entry point.
*
* `process.argv[1]` keeps the path the caller named while `import.meta.url`
* reports the real one, and the editor reaches this file through a package
* symlink often enough that comparing them raw would silently never match.
*/
function invokedAsLaneHost() {
	if (!process.argv.includes("--oxc-tsrx-js-plugin-lane-host")) return false;
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry === "") return false;
	for (const candidate of [entry, (() => {
		try {
			return realpathSync(entry);
		} catch {
			return entry;
		}
	})()]) try {
		if (pathToFileURL(candidate).href === import.meta.url) return true;
	} catch {}
	return false;
}
if (invokedAsLaneHost()) {
	const index = process.argv.indexOf("--cwd");
	runJsPluginLaneHost({ cwd: index === -1 ? process.cwd() : process.argv[index + 1] ?? process.cwd() }).then((status) => {
		process.exitCode = status;
	}, (error) => {
		process.stderr.write(`oxc-tsrx-lsp: the JS plugin lane host stopped: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
//#endregion
export { LANE_HOST_FLAG, OXLINT_JS_PLUGIN_LANE_BELOW, OXLINT_JS_PLUGIN_LANE_MINIMUM, installedOxlintVersion, jsPluginDisclosure, jsPluginEditorDisclosure, jsPluginUnmappedNote, laneSupportsOxlintVersion, mirrorRelativePath, nativeLaneConfig, oxlintVersionRefusal, parseOxlintConfigText, preparePluginLane, projectionConfig };
