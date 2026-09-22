import { resolveCanonicalBinary } from "./canonical-command.js";
import { runCaptured } from "./process.js";

export function startCanonicalOxlint(args, cwd = process.cwd(), env = process.env) {
  const binary = resolveCanonicalBinary("oxlint", { cwd, fromUrl: import.meta.url }).binPath;
  return {
    args,
    binary,
    result: runCaptured(process.execPath, [binary, ...args], { cwd, env }),
  };
}
