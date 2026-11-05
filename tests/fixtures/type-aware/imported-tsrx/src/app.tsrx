import { Label, loadLabel } from "./label.tsrx";

export function App() @{
  loadLabel();
  <Label text="hi" />;
}
