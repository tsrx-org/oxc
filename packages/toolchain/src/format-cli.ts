import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  argumentValue,
  canonicalToolEnvironment,
  discoverTsrxFiles,
  pathArguments,
  isViteConfigPath,
  prepareVitePlusConfig,
  removeExplicitTsrx,
  replaceConfigArgument,
  resolveNativeCommand,
  resolvePackageBinary,
  runCaptured,
  runPassthrough,
} from "./runtime.js";
import { VALUE_OPTIONS, parseOxfmtInvocation, parseOxfmtOption } from "./format-invocation.js";

// Canonical Oxfmt's own wording for an option it has never heard of, reproduced
// verbatim, on the same stream and with the same exit code. A flag canonical
// Oxfmt does not know is not a TSRX gap: telling the user it "is not yet
// supported for .tsrx" sends them to the Oxfmt docs looking for an option that
// does not exist. Only a flag canonical Oxfmt really does accept gets that
// message.
function unknownOptionMessage(name) {
  return `Error: \`${name}\` is not expected in this context`;
}

// The first option in the command line that canonical Oxfmt's own option set
// does not contain, or null when every option is one it knows. `VALUE_OPTIONS`
// consume their value so an option-looking argument such as
// `--ignore-path -foo` is never mistaken for an option of its own.
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

// The native leaf prefixes its errors with its own name because that is correct
// when it is run directly as the capability target the provider manifest names.
// Relayed through this command the user typed `oxfmt`, so the lines this wrapper
// passes on are re-labelled with the name they ran, using the same prefix
// `bin/oxfmt` already puts on its own errors.
function attributeNativeErrors(stderr) {
  return stderr.replace(/^oxc-tsrx-fmt: /gmu, "oxfmt (oxc-tsrx): ");
}

function hasTsrxPositional(positionals) {
  return positionals.some((argument) => argument.split("?")[0].endsWith(".tsrx"));
}

const NATIVE_VALUE_OPTIONS = new Map([
  ["-c", "--config"],
  ["--config", "--config"],
  ["--threads", "--threads"],
]);
const WRAPPER_OPTIONS = new Set(["--no-error-on-unmatched-pattern"]);

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
    throw new Error(
      `${name} is not yet supported for .tsrx by the drop-in Oxfmt command; canonical Oxfmt still handles ordinary files`,
    );
  }
  if (resolvedConfig) {
    output.push("--config", resolvedConfig.path, "--config-base", resolvedConfig.base);
  }
  return [...output, ...files];
}

// Discovery hands back absolute paths, and the native formatter echoes back the
// path it was given. Handing it the same relative spelling canonical Oxfmt was
// given keeps one merged report from mixing the two spellings, in its file list
// and in its diagnostics alike. The child runs in this same directory, so the
// two spellings name the same file.
function withCwdRelativePaths(files, cwd) {
  return files.map((file) => {
    if (!isAbsolute(file)) return file;
    const relativePath = relative(cwd, file);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return file;
    }
    return relativePath;
  });
}

// --- Merging the two halves into one report ------------------------------
//
// Canonical Oxfmt has no machine-readable output, so a mixed run is rebuilt
// from the two rendered halves rather than concatenated. Concatenating printed
// one half's "All matched files use the correct format." directly above the
// other half's failing paths, and a file count that excluded every `.tsrx`
// file in the run.
//
// The shape both halves emit, verified against the pinned stock binary:
//
//   <preamble>\n\n<path> (Nms)\n...\n\n<verdict>\n<summary with a file count>\n
//
// and, when some file could not be read, truncated right after the path list,
// so no verdict and no count is ever printed above a failure.
//
// Nothing below hardcodes canonical wording. The preamble, the verdict, and
// the summary are taken from whichever half produced them and only their
// counts are rewritten, so the merged report keeps tracking upstream if its
// sentences move.

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
  if (!body.endsWith("\n")) {
    // Truncated by a failure: the paths that differ, and nothing that would
    // claim anything about the batch as a whole.
    return {
      preamble,
      files: body === "" ? [] : body.split("\n"),
      verdict: null,
      summary: null,
      count: null,
    };
  }
  const lines = body.slice(0, -1).split("\n");
  const summary = lines.pop() ?? null;
  const verdict = lines.pop() ?? null;
  if (lines.at(-1) === "") lines.pop();
  return { preamble, files: lines, verdict, summary, count: reportedFileCount(summary) };
}

function parseWriteReport(stdout) {
  if (!stdout.endsWith("\n")) return null;
  const line = stdout.slice(0, -1);
  const count = reportedFileCount(line);
  if (line.includes("\n") || count === null) return null;
  return { line, count };
}

function mergeCheckStdout(upstream, native, failed) {
  const reports = [parseCheckReport(upstream.stdout), parseCheckReport(native.stdout)].filter(
    Boolean,
  );
  if (reports.length === 0) return upstream.stdout + native.stdout;
  const preamble = reports[0].preamble;
  const files = reports.flatMap((report) => report.files);
  if (failed) return preamble + files.join("\n");

  const verdict =
    files.length > 0
      ? reports.find((report) => report.files.length > 0)?.verdict
      : reports.find((report) => report.files.length === 0)?.verdict;
  const summary = reports.find((report) => report.summary !== null)?.summary;
  if (!verdict || !summary) return upstream.stdout + native.stdout;
  const count = reports.reduce((total, report) => total + (report.count ?? 0), 0);
  return `${preamble}${files.join("\n")}${files.length > 0 ? "\n\n" : ""}${withVerdictCount(
    verdict,
    files.length,
  )}\n${withReportedFileCount(summary, count)}\n`;
}

function mergeWriteStdout(upstream, native, failed) {
  const reports = [upstream.stdout, native.stdout].map(parseWriteReport).filter(Boolean);
  if (reports.length === 0) return upstream.stdout + native.stdout;
  // Canonical Oxfmt prints no summary at all once a file in the batch failed.
  if (failed) return "";
  const count = reports.reduce((total, report) => total + report.count, 0);
  return `${withReportedFileCount(reports[0].line, count)}\n`;
}

function mergeListDifferentStdout(upstream, native) {
  // Canonical Oxfmt joins these paths with newlines and prints no trailing one.
  return [upstream.stdout, native.stdout].filter((part) => part.length > 0).join("\n");
}

function mergeFormatStdout(mode, upstream, native) {
  // Exit 2 is what both halves use for a file they could not read or parse.
  const failed = upstream.status >= 2 || native.status >= 2;
  if (mode === "list-different") return mergeListDifferentStdout(upstream, native);
  if (mode === "check") return mergeCheckStdout(upstream, native, failed);
  return mergeWriteStdout(upstream, native, failed);
}

function lastNonEmptyLine(text) {
  const lines = text.split("\n").filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

function withoutLine(text, line) {
  const marker = `${line}\n`;
  const index = text.lastIndexOf(marker);
  return index === -1 ? text : text.slice(0, index) + text.slice(index + marker.length);
}

function mergeFormatStderr(upstream, native, stdout) {
  let leading = upstream.stderr;
  const summary = lastNonEmptyLine(native.stderr);
  // Each half closes its diagnostics with the same sentence about its own
  // files. One report states it once, under both halves' diagnostics.
  if (summary !== "" && lastNonEmptyLine(leading) === summary) {
    leading = withoutLine(leading, summary);
  }
  const merged = leading + native.stderr;
  // A report truncated by a failure ends without a newline, and the diagnostic
  // block that follows it supplies one. Canonical Oxfmt's block already opens
  // with that blank line; canonical Oxfmt's config notice, which only the
  // ordinary half prints, does not.
  if (merged === "" || merged.startsWith("\n") || stdout === "" || stdout.endsWith("\n")) {
    return merged;
  }
  return `\n${merged}`;
}

async function delegate(args, cwd, input) {
  const upstream = resolvePackageBinary("oxfmt-current", "oxfmt", import.meta.url);
  const upstreamArgs = [upstream, ...args];
  // --lsp starts a long-lived stdio LSP server, so the session must stream
  // through the wrapper instead of being captured and replayed on exit.
  if (args.some((argument) => argument.split("=")[0] === "--lsp")) {
    const result = await runPassthrough(process.execPath, upstreamArgs, { cwd });
    return result.status;
  }
  const result = await runCaptured(process.execPath, upstreamArgs, { cwd, input });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.status;
}

export async function runCli(args, options: any = {}) {
  const cwd = options.cwd ?? process.cwd();
  const invocation = parseOxfmtInvocation(args);
  if (invocation.delegateOnly) {
    return delegate(args, cwd, options.input);
  }

  const requestedStdin = invocation.stdinFilepath;
  if (requestedStdin !== null) {
    // The executable bridge owns stdin for TSRX. Keep bytes as a Buffer so the
    // native formatter receives the exact input without a UTF-8 decode/re-encode
    // round trip. Programmatic callers can still provide an explicit input.
    const input = options.input ?? readFileSync(0);
    if (!requestedStdin.split("?")[0].endsWith(".tsrx")) return delegate(args, cwd, input);
    const unknownStdinOption = unknownCanonicalOption(args);
    if (unknownStdinOption !== null) {
      process.stderr.write(`${unknownOptionMessage(unknownStdinOption)}\n`);
      return 1;
    }
    const explicitConfig = argumentValue(args, new Set(["-c", "--config"]));
    const bridgeViteConfig = explicitConfig === null || isViteConfigPath(explicitConfig);
    const viteConfig = bridgeViteConfig
      ? await prepareVitePlusConfig(
          "fmt",
          cwd,
          isViteConfigPath(explicitConfig) ? explicitConfig : null,
        )
      : null;
    try {
      let nativeArgs = args.filter((argument) => argument !== "--no-error-on-unmatched-pattern");
      if (viteConfig) {
        nativeArgs = replaceConfigArgument(nativeArgs, viteConfig.path);
        nativeArgs.push("--config-base", viteConfig.base);
      }
      const nativeCommand = resolveNativeCommand("format", nativeArgs);
      const result = await runCaptured(nativeCommand.executable, nativeCommand.args, {
        cwd,
        input,
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
  // Only this route answers for a `.tsrx` path. An ordinary-only invocation
  // keeps reaching canonical Oxfmt, which prints its own rejection itself, so
  // nothing here can drift from the tool it is reproducing on that path.
  if (files.length > 0 || hasTsrxPositional(positions)) {
    const unknown = unknownCanonicalOption(args);
    if (unknown !== null) {
      process.stderr.write(`${unknownOptionMessage(unknown)}\n`);
      return 1;
    }
  }
  const explicitConfig = argumentValue(args, new Set(["-c", "--config"]));
  const bridgeViteConfig = explicitConfig === null || isViteConfigPath(explicitConfig);
  const viteConfig =
    files.length > 0 && bridgeViteConfig
      ? await prepareVitePlusConfig(
          "fmt",
          cwd,
          isViteConfigPath(explicitConfig) ? explicitConfig : null,
        )
      : null;
  let nativePaths = null;
  try {
    const stripped = removeExplicitTsrx(args, VALUE_OPTIONS);
    const shouldRunUpstream = !stripped.hadPositionals || stripped.remainingPositionals > 0;
    const upstream = resolvePackageBinary("oxfmt-current", "oxfmt", import.meta.url);
    const useMaterializedUpstreamConfig = Boolean(viteConfig && !viteConfig.requiresAuthoredBase);
    const upstreamArgs = useMaterializedUpstreamConfig
      ? replaceConfigArgument(stripped.args, viteConfig.path)
      : stripped.args;
    nativePaths = files.length > 0 ? await pathArguments(withCwdRelativePaths(files, cwd)) : null;
    const nativeArgs = nativePaths ? nativeArguments(args, nativePaths.args, viteConfig) : null;
    // Resolve and validate every artifact before either tool can mutate a mixed batch.
    // In particular, a missing platform package must not let canonical Oxfmt
    // rewrite ordinary files before the TSRX lane fails.
    const nativeCommand = nativeArgs ? resolveNativeCommand("format", nativeArgs) : null;
    const [upstreamResult, nativeResult] = await Promise.all([
      shouldRunUpstream
        ? runCaptured(process.execPath, [upstream, ...upstreamArgs], {
            cwd,
            env: canonicalToolEnvironment(useMaterializedUpstreamConfig),
          })
        : Promise.resolve({ status: 0, stdout: "", stderr: "", signal: null }),
      nativeCommand
        ? runCaptured(nativeCommand.executable, nativeCommand.args, { cwd })
        : Promise.resolve({ status: 0, stdout: "", stderr: "", signal: null }),
    ]);
    const stdout = mergeFormatStdout(fileMode(args), upstreamResult, nativeResult);
    process.stdout.write(stdout);
    process.stderr.write(
      attributeNativeErrors(mergeFormatStderr(upstreamResult, nativeResult, stdout)),
    );
    return Math.max(upstreamResult.status, nativeResult.status);
  } finally {
    await nativePaths?.cleanup();
    await viteConfig?.cleanup();
  }
}
