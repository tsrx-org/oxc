export function Label(props: { text: string }) @{
  <span>{props.text}</span>;
}

export async function loadLabel(): Promise<string> {
  return "hello";
}

// A floating promise and a type error planted in a file the importer tests never name: while it
// is only read so its importers resolve, neither may be reported.
declare function save(): Promise<void>;
save();
export const wrong: number = "not a number";
