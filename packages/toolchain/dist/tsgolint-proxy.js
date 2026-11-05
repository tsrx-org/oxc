import { resolveNativeCommand } from "./runtime.js";
import { delimiter, dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";
//#region src/tsgolint-proxy.ts
const TSGOLINT_PROXY_ENV = "OXC_TSRX_TSGOLINT_PROXY";
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
*/
function withTsgolintProxy(env, cwd, resolveNative = () => resolveNativeCommand("lint").executable) {
	if (env["OXC_TSRX_TSGOLINT_PROXY"]) return env;
	const target = canonicalTsgolintExecutable(cwd, env);
	if (target === null) return env;
	let native;
	try {
		native = resolveNative();
	} catch {
		return env;
	}
	if (resolve(native) === resolve(target)) return env;
	return {
		...env,
		OXLINT_TSGOLINT_PATH: native,
		[TSGOLINT_PROXY_ENV]: target
	};
}
//#endregion
export { TSGOLINT_PROXY_ENV, canonicalTsgolintExecutable, withTsgolintProxy };
