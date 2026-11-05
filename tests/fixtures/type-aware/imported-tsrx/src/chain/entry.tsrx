import { middle } from "./middle.tsrx";

export function Entry() @{
  middle();
  <p>entry</p>;
}
