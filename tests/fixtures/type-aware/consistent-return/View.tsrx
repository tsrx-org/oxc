/// <reference path="./jsx.d.ts" />

export function Label(props: { text: string }) @{
  <span>{props.text}</span>
}

export function Guarded(props: { text?: string }) @{
  if (!props.text) return;
  <span>{props.text}</span>
}

export const Badge = (props: { text: string }) => @{
  <b>{props.text}</b>
};

export function Mixed(props: { text?: string }) @{
  if (props.text === "one") return 1;
  if (props.text === undefined) return;
  <span>{props.text}</span>
}

export function pick(flag: boolean) {
  if (flag) return 1;
}

export const usage = [<Label text="a" />, <Guarded />, <Badge text="b" />, <Mixed />];
