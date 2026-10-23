// A JSX runtime that is not React, so a projection checked without its owning
// tsconfig's `jsxImportSource` reports TS2875 for `react/jsx-runtime`.
export namespace JSX {
  type Element = { readonly custom: true };
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}
export const Fragment: unknown;
export function jsx(type: unknown, properties: unknown): JSX.Element;
export function jsxs(type: unknown, properties: unknown): JSX.Element;
