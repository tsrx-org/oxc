import { pingB } from "./b.tsrx";

export async function pingA(): Promise<void> {}

export function A() @{
  pingB();
  <p>a</p>;
}
