import { resolveCanonicalOxlint } from "./package-binary.js";
import { runCaptured } from "./process.js";
import { withTsgolintProxy } from "./tsgolint-proxy.js";

export function startCanonicalOxlint(
  args,
  cwd = process.cwd(),
  env = withTsgolintProxy(process.env, cwd),
) {
  const binary = resolveCanonicalOxlint(import.meta.url, cwd);
  return {
    args,
    binary,
    result: runCaptured(process.execPath, [binary, ...args], { cwd, env }),
  };
}
