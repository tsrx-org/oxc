export type OxcTsrxCompatibilityState =
  | "missing"
  | "replaceable"
  | "active"
  | "stale"
  | "collision";

export interface OxcTsrxCompatibilitySlot {
  readonly name: "oxc-parser" | "oxlint" | "oxfmt";
  readonly capability: "parser" | "lint" | "format";
  /** The command name the slot's package publishes, or null for the parser slot. */
  readonly binary: "oxlint" | "oxfmt" | null;
  readonly path: string;
  readonly state: OxcTsrxCompatibilityState;
  /**
   * Why a `collision` slot is left alone. `direct-dependency` is the project's
   * own official package; `setup` works around it and the report explains it.
   * The other kinds are trees the bridge no longer owns and `setup` refuses.
   */
  readonly collision?:
    | "direct-dependency"
    | "foreign-package"
    | "reinstalled-over-facade"
    | "facade-without-backup";
  /** What occupies a `collision` slot, as its own package.json names it. */
  readonly occupant?: { readonly name: string | null; readonly version: string | null };
  readonly replacedPackage?: {
    readonly name: string;
    readonly version: string;
  };
}

/**
 * The editor slot is not a package. It is the single `oxc.path.oxlint` key in
 * the project's own `.vscode/settings.json`, written only when
 * `node_modules/.bin/oxlint` belongs to another tool.
 *
 * - `unnecessary` — the ordinary lookup already reaches this package.
 * - `missing` — needed, and the key is absent.
 * - `active` — the key points into this package.
 * - `stale` — this package wrote the key and it no longer resolves here.
 * - `collision` — the key is set to something else and is left untouched.
 * - `unreadable` — the settings file is not a single top-level JSON object.
 */
export type OxcTsrxEditorSlotState =
  | "unnecessary"
  | "missing"
  | "active"
  | "stale"
  | "collision"
  | "unreadable";

export interface OxcTsrxEditorSlot {
  readonly name: "oxc.path.oxlint";
  readonly capability: "editor";
  readonly key: "oxc.path.oxlint";
  /** Absolute path of the project's `.vscode/settings.json`. */
  readonly path: string;
  /** The value this package would write. */
  readonly value: string;
  readonly state: OxcTsrxEditorSlotState;
  readonly currentValue?: string | null;
  readonly linterShim: {
    readonly path: string;
    readonly target: string | null;
    readonly owner: "oxc-tsrx" | "other" | "none" | "unknown";
    readonly resolvedBy:
      | "symlink"
      | "shim-text"
      | "compatibility-facade"
      | "unresolved"
      | "absent";
  };
}

/**
 * TSRX editor support that this package deliberately does not own. Every field
 * is read-only reporting: nothing here is installed, edited, or configured.
 */
export interface OxcTsrxLanguageSupport {
  readonly typescriptPlugin: {
    readonly package: "@tsrx/typescript-plugin";
    readonly present: boolean;
    readonly version: string | null;
  };
  readonly frameworkBinding: {
    readonly candidates: readonly string[];
    readonly present: boolean;
    readonly name: string | null;
    readonly version: string | null;
  };
  readonly tsconfig: {
    readonly path: string | null;
    readonly readable: boolean;
    readonly declaresPlugin: boolean;
  };
  readonly typescript: {
    readonly requirement: ">=5.9 <6";
    readonly present: boolean;
    readonly version: string | null;
    readonly supported: boolean;
  };
  readonly notes: readonly string[];
  readonly ok: boolean;
}

export interface OxcTsrxCompatibilityOptions {
  readonly projectRoot?: string;
  readonly userAgent?: string;
  readonly dryRun?: boolean;
  /**
   * Opt in to `setup` adding the `@tsrx/typescript-plugin` entry under
   * `compilerOptions` in the tsconfig that owns your source. Without it,
   * `setup` reports the missing entry and edits no tsconfig at all.
   */
  readonly writeTsconfig?: boolean;
}

export interface OxcTsrxCompatibilityStatus {
  readonly projectRoot: string;
  readonly packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  readonly providerVersion: string;
  readonly selectedFrom: "dependencies" | "devDependencies" | "optionalDependencies";
  readonly slots: readonly OxcTsrxCompatibilitySlot[];
  readonly editorSlot: OxcTsrxEditorSlot;
  readonly languageSupport: OxcTsrxLanguageSupport;
}

export interface OxcTsrxTsconfigWrite {
  readonly path: string;
  /** `written` on a fresh entry, `present` when it already named the plugin. */
  readonly state: "written" | "present" | "preview";
}

export interface OxcTsrxSetupResult extends OxcTsrxCompatibilityStatus {
  readonly action: "preview" | "setup";
  /** Present only when `writeTsconfig` was requested. */
  readonly tsconfigWrite?: OxcTsrxTsconfigWrite;
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
}

export interface OxcTsrxRemoveResult extends OxcTsrxCompatibilityStatus {
  readonly action: "preview-remove" | "remove";
  readonly removed: readonly string[];
}

export declare function findProjectRoot(start?: string): Promise<string>;
export declare function compatibilityStatus(
  options?: OxcTsrxCompatibilityOptions,
): Promise<OxcTsrxCompatibilityStatus>;
export declare function setupCompatibility(
  options?: OxcTsrxCompatibilityOptions,
): Promise<OxcTsrxSetupResult>;
export declare function removeCompatibility(
  options?: OxcTsrxCompatibilityOptions,
): Promise<OxcTsrxRemoveResult>;
export declare function formatCompatibilityReport(
  result:
    | OxcTsrxCompatibilityStatus
    | OxcTsrxSetupResult
    | OxcTsrxRemoveResult,
): string;
