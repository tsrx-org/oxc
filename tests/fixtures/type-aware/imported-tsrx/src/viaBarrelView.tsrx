import { loadLabel } from "./barrel";

export function ViaBarrel() @{
  loadLabel();
  <span>{"hi"}</span>;
}
