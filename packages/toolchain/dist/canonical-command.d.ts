export type OxcTsrxCanonicalCommand = "oxlint" | "oxfmt";

export interface OxcTsrxCanonicalDecisionKept {
  readonly command: OxcTsrxCanonicalCommand;
  readonly owner: "@tsrx/oxc";
  readonly reason: "no-project-manifest" | "not-directly-declared" | "compatibility-facade";
  readonly projectRoot: string | null;
  readonly officialRoot?: string;
}

export interface OxcTsrxCanonicalDecisionDeferred {
  readonly command: OxcTsrxCanonicalCommand;
  readonly owner: "project";
  readonly reason: string;
  readonly projectRoot: string;
  readonly officialRoot: string;
  readonly officialVersion: string | null;
  readonly binPath: string;
}

export type OxcTsrxCanonicalDecision =
  | OxcTsrxCanonicalDecisionKept
  | OxcTsrxCanonicalDecisionDeferred;

export interface OxcTsrxCanonicalOptions {
  readonly cwd?: string;
}

export declare function decideCanonicalCommand(
  command: OxcTsrxCanonicalCommand,
  options?: OxcTsrxCanonicalOptions,
): Promise<OxcTsrxCanonicalDecision>;

export interface OxcTsrxCanonicalBinary {
  readonly command: OxcTsrxCanonicalCommand;
  readonly binPath: string;
  readonly version: string | null;
  readonly source: "project" | "vendored";
  readonly officialRoot: string;
  readonly vendoredVersion: string | null;
  readonly projectVersion: string | null;
  readonly projectRoot: string | null;
}

export interface OxcTsrxCanonicalBinaryOptions {
  readonly cwd?: string;
  readonly fromUrl?: string;
}

/**
 * The official binary that runs `command` when this package owns the name: the
 * newer of the project's installed official package and the vendored copy.
 */
export declare function resolveCanonicalBinary(
  command: OxcTsrxCanonicalCommand,
  options?: OxcTsrxCanonicalBinaryOptions,
): OxcTsrxCanonicalBinary;

export declare function runCanonicalBinary(
  resolved: OxcTsrxCanonicalBinary,
  options?: { spawn?: unknown },
): Promise<void>;

export declare function configurationRejectionNotice(
  resolved: OxcTsrxCanonicalBinary,
  output: string,
): string;

export declare function providedArguments(args: readonly string[]): string[];

export declare function usesNodeInterpreter(path: string): Promise<boolean>;

export declare function deferralNotice(
  decision: OxcTsrxCanonicalDecision,
  args: readonly string[],
): string | null;

export interface OxcTsrxRunOfficialOptions {
  readonly spawn?: typeof import("node:child_process").spawn;
}

export declare function runOfficialCommand(
  decision: OxcTsrxCanonicalDecisionDeferred,
  options?: OxcTsrxRunOfficialOptions,
): Promise<void>;
