import { resolveCanonicalOxlint } from "./package-binary.js";
import { runCaptured } from "./process.js";

export function startCanonicalOxlint(args, cwd = process.cwd(), env = process.env) {
  const binary = resolveCanonicalOxlint(import.meta.url, cwd);
  return {
    args,
    binary,
    result: runCaptured(process.execPath, [binary, ...args], { cwd, env }),
  };
}
