import assert from "node:assert/strict";
import test from "node:test";

import { parseModule } from "../../packages/tsrx-core-compat/dist/index.js";

// tsrx-org/oxc#92: a multiline spread attribute must not shift the line/column
// locations the compat parser reports. Locations are derived from offsets, so
// every node's `loc` has to agree with an independent line table built from
// the source text. The reporter's expected values are pinned verbatim, and the
// whole tree is walked so a drift on any node, not only the spread argument,
// fails the test.

function lineTable(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\n") starts.push(index + 1);
    else if (char === "\r" && source[index + 1] !== "\n") starts.push(index + 1);
  }
  return (offset) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
    return { line: line + 1, column: offset - starts[line] };
  };
}

function* nodes(root) {
  const pending = [root];
  const seen = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value.type === "string") yield value;
    for (const [key, child] of Object.entries(value)) {
      if (key === "parent" || key === "loc") continue;
      pending.push(child);
    }
  }
}

function assertLocationsAlign(source, filename) {
  const ast = parseModule(source, filename);
  const positionAt = lineTable(source);
  const lineCount = positionAt(source.length).line;
  let checked = 0;
  for (const node of nodes(ast)) {
    if (!Number.isInteger(node.start) || !Number.isInteger(node.end)) continue;
    assert.ok(node.loc, `${node.type} at ${node.start} has no loc`);
    const label = `${filename}: ${node.type} [${node.start}, ${node.end})`;
    assert.deepEqual(node.loc.start, positionAt(node.start), `${label} start`);
    assert.deepEqual(node.loc.end, positionAt(node.end), `${label} end`);
    assert.ok(node.loc.end.line <= lineCount, `${label} ends past line ${lineCount}`);
    checked += 1;
  }
  assert.ok(checked > 0, `${filename}: no located nodes`);
  return ast;
}

test("a multiline spread attribute keeps the spread argument on its own line", () => {
  const source = `function Demo(props) @{
  <div {...
    props
  } />
}`;
  const ast = assertLocationsAlign(source, "demo.tsrx");
  const attribute = ast.body[0].body.render.openingElement.attributes[0];
  assert.equal(attribute.type, "JSXSpreadAttribute");
  assert.deepEqual(
    { start: attribute.argument.start, end: attribute.argument.end, loc: attribute.argument.loc },
    {
      start: 40,
      end: 45,
      loc: { start: { line: 3, column: 4 }, end: { line: 3, column: 9 } },
    },
  );
});

test("attributes after a multiline spread stay inside the source's line count", () => {
  const source = `function Demo(props) @{
  <div {...
    props
  } id={props} />
}`;
  const ast = assertLocationsAlign(source, "demo.tsrx");
  const [spread, id] = ast.body[0].body.render.openingElement.attributes;
  assert.equal(spread.type, "JSXSpreadAttribute");
  assert.equal(id.type, "JSXAttribute");
  assert.deepEqual(spread.loc, { start: { line: 2, column: 7 }, end: { line: 4, column: 3 } });
  assert.deepEqual(id.loc, { start: { line: 4, column: 4 }, end: { line: 4, column: 14 } });
});

test("multiline spread locations align for CRLF sources, nested elements, and TSX lanes", () => {
  const tsrx = [
    "function Demo(props) @{",
    "  <section {...",
    "    props.section",
    "  }>",
    "    <div {...",
    "      props",
    "    } id={props.id} />",
    "  </section>",
    "}",
  ];
  assertLocationsAlign(`${tsrx.join("\r\n")}\r\n`, "demo.tsrx");
  assertLocationsAlign(`${tsrx.join("\n")}\n`, "demo.tsrx");
  assertLocationsAlign(
    "function Demo(props) {\n  return <div {...\n    props\n  } id={props} />;\n}\n",
    "demo.tsx",
  );
});
