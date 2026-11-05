import { resolveNativeCommand } from "./runtime.js";
import { delimiter, dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";
//#region src/tsgolint-proxy.ts
const TSGOLINT_PROXY_ENV = "OXC_TSRX_TSGOLINT_PROXY";
const TSGOLINT_PROXY_SEARCH_ENV = "OXC_TSRX_TSGOLINT_PROXY_SEARCH";
function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
/**
* The tsgolint canonical Oxlint would run from `cwd` under `env`, found the
* way Oxlint finds it: `OXLINT_TSGOLINT_PATH`, then `node_modules/.bin` in
* `cwd` and every directory above it, then `PATH`. `null` when Oxlint would
* find none, or would refuse the configured one, so that Oxlint reports that
* itself, in its own words.
*/
function canonicalTsgolintExecutable(cwd, env = process.env, platform = process.platform) {
	const configured = env.OXLINT_TSGOLINT_PATH;
	if (configured !== void 0) {
		const path = resolve(cwd, configured);
		if (isDirectory(path)) {
			const candidate = join(path, "tsgolint");
			return isFile(candidate) ? candidate : null;
		}
		return isFile(path) ? path : null;
	}
	const names = platform === "win32" ? ["tsgolint.CMD", "tsgolint.exe"] : ["tsgolint"];
	let directory = resolve(cwd);
	for (;;) {
		for (const name of names) {
			const candidate = join(directory, "node_modules", ".bin", name);
			if (isFile(candidate)) return candidate;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	for (const entry of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (!entry) continue;
		for (const name of names) {
			const candidate = join(entry, name);
			if (isFile(candidate)) return candidate;
		}
	}
	return null;
}
/**
* `env` for a canonical Oxlint run from `cwd` whose tsgolint is the native
* proxy. `env` itself, unchanged, when there is no tsgolint for Oxlint to run
* or no native executable to stand in for it: Oxlint then behaves exactly as
* it would have without this package.
*
* With `perRoot`, for the language server, the tsgolint is not fixed here.
* One Oxlint server serves every workspace root and looks a tsgolint up from
* each root, so the proxy looks it up from the files of each payload it is
* handed, and uses the one found from `cwd`, if any, only when that finds
* none. A configured `OXLINT_TSGOLINT_PATH` is fixed for every root, by Oxlint
* and here alike.
*/
function withTsgolintProxy(env, cwd, options = {}) {
	const resolveNative = options.resolveNative ?? (() => resolveNativeCommand("lint").executable);
	if (env["OXC_TSRX_TSGOLINT_PROXY"] !== void 0) return env;
	const search = Boolean(options.perRoot) && env.OXLINT_TSGOLINT_PATH === void 0;
	const target = canonicalTsgolintExecutable(cwd, env);
	if (target === null && !search) return env;
	let native;
	try {
		native = resolveNative();
	} catch {
		return env;
	}
	if (target !== null && resolve(native) === resolve(target)) return env;
	const proxied = {
		...env,
		OXLINT_TSGOLINT_PATH: native,
		[TSGOLINT_PROXY_ENV]: target ?? ""
	};
	if (search) proxied[TSGOLINT_PROXY_SEARCH_ENV] = "1";
	return proxied;
}
/**
* Runs `body` with this process's own environment proxied, for a canonical
* Oxlint that runs inside this process and reads it there, and gives the
* environment back afterwards.
*/
async function withProcessTsgolintProxy(cwd, body, options = {}) {
	const proxied = withTsgolintProxy(process.env, cwd, options);
	if (proxied === process.env) return body();
	const keys = [
		TSGOLINT_PROXY_ENV,
		TSGOLINT_PROXY_SEARCH_ENV,
		"OXLINT_TSGOLINT_PATH"
	];
	const saved = keys.map((key) => [key, process.env[key]]);
	for (const key of keys) if (proxied[key] === void 0) delete process.env[key];
	else process.env[key] = proxied[key];
	try {
		return await body();
	} finally {
		for (const [key, value] of saved) if (value === void 0) delete process.env[key];
		else process.env[key] = value;
	}
}
//#endregion
export { TSGOLINT_PROXY_ENV, TSGOLINT_PROXY_SEARCH_ENV, canonicalTsgolintExecutable, withProcessTsgolintProxy, withTsgolintProxy };
