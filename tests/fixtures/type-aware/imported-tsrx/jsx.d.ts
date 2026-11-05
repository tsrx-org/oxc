declare namespace JSX {
  interface Element {
    readonly __jsx: unique symbol;
  }
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}

declare module "react/jsx-runtime" {
  export const Fragment: unknown;
  export function jsx(type: unknown, properties: unknown): JSX.Element;
  export function jsxs(type: unknown, properties: unknown): JSX.Element;
}
