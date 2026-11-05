import { pingA } from "./a.tsrx";

export async function pingB(): Promise<void> {
  await pingA();
}
