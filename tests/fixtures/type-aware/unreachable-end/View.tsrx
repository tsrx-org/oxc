/// <reference path="./jsx.d.ts" />

export function Returns(props: { text: string }) @{
  return <span>{props.text}</span>;
}

export function Throws() @{
  throw new Error("not rendered");
}

export const Branches = (props: { ready: boolean }) => @{
  if (props.ready) {
    return <b>ready</b>;
  } else {
    throw new Error("not ready");
  }
};

export function Loops() @{
  while (true) {}
}

export function Authored(props: { text: string }) @{
  return <i>{props.text}</i>;
  <span>never</span>
}

export const usage = [
  <Returns text="a" />,
  <Throws />,
  <Branches ready />,
  <Loops />,
  <Authored text="b" />,
];
