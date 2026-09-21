import { runCaptured } from "./process.js";
import { resolveCanonicalOxlint } from "./package-binary.js";
//#region src/lint-prestart.ts
function startCanonicalOxlint(args, cwd = process.cwd(), env = process.env) {
	const binary = resolveCanonicalOxlint(import.meta.url, cwd);
	return {
		args,
		binary,
		result: runCaptured(process.execPath, [binary, ...args], {
			cwd,
			env
		})
	};
}
//#endregion
export { startCanonicalOxlint };
