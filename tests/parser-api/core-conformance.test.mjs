import assert from "node:assert/strict";
import test from "node:test";

import { parseModule } from "../../packages/tsrx-core-compat/dist/index.js";

// Regression tests for the @tsrx/core 0.5.0 conformance issues tsrx-org/oxc #110, #112, #113,
// #114, #115, #116, #117, #118, #125, #127, and #128. Every expected value below is what @tsrx/core 0.5.0 (tsrx main at
// f78fada) returns for the same source, so a difference here is a difference from the reference
// parser. The #111, #145, #146, #147, #148, #149, #150, #151, #152, and #153 tests, and the shape
// tests at the end, take theirs from @tsrx/core 0.5.2. The #200 test takes its from @tsrx/core 0.5.2
// and 0.5.4, which agree on it. The #201 test takes its from @tsrx/core 0.5.4.

function findAll(root, predicate) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push(value[index]);
      continue;
    }
    if (predicate(value)) found.push(value);
    for (const [key, child] of Object.entries(value).reverse()) {
      if (key === "loc" || key === "metadata" || key.endsWith("Comments")) continue;
      pending.push(child);
    }
  }
  return found;
}

const texts = (ast) =>
  findAll(ast, (node) => node.type === "JSXText").map(({ value, raw, start, end }) => ({
    value,
    raw,
    start,
    end,
  }));

const script = (ast) =>
  findAll(
    ast,
    (node) => node.type === "JSXElement" && node.openingElement?.name?.name === "script",
  )[0];

// Each element's children, as `[raw, start, end]` for a JSXText, `["{}", start, end]` for an
// empty expression container, and the tag name for an element.
const children = (ast) =>
  findAll(ast, (node) => node.type === "JSXElement").map((element) =>
    element.children.map((child) =>
      child.type === "JSXText"
        ? [child.raw, child.start, child.end]
        : child.expression?.type === "JSXEmptyExpression"
          ? (assert.deepEqual([child.expression.start, child.expression.end], [child.start, child.end]),
            ["{}", child.start, child.end, child.expression.innerComments.map(({ type, value }) => [type, value])])
          : (child.openingElement?.name.name ?? child.type),
    ),
  );

test("#118: an element's children have TSX's shape, with each comment an empty {} child", () => {
  // All text is kept as written, and a comment is read before tags and braces. A `//` is a
  // comment after whitespace or at the start of a text run; touching other text, it is text.
  const cases = [
    [
      "export function App() @{\n\t<p>\n\t\ta\n\t\t// note\n\t\tb\n\t</p>\n}",
      "App.tsrx",
      [[["\n\t\ta\n\t\t", 29, 36], ["{}", 36, 43, [["Line", " note"]]], ["\n\t\tb\n\t", 43, 49]]],
    ],
    [
      "export function App() {\n\treturn <p>a /* note */ b</p>;\n}",
      "App.tsrx",
      [[["a ", 35, 37], ["{}", 37, 47, [["Block", " note "]]], [" b", 47, 49]]],
    ],
    [
      "export function App({ a }) @{\n\t<div>\n\t\t// <b>x</b>\n\t\t<i>y</i>\n\t</div>\n}",
      "App.tsrx",
      [[["\n\t\t", 36, 39], ["{}", 39, 50, [["Line", " <b>x</b>"]]], ["\n\t\t", 50, 53], "i", ["\n\t", 61, 63]], [["y", 56, 57]]],
    ],
    [
      "export function App() {\n\treturn <div>a /* } */ b</div>;\n}",
      "App.tsrx",
      [[["a ", 37, 39], ["{}", 39, 46, [["Block", " } "]]], [" b", 46, 48]]],
    ],
    [
      "export function App() @{\n\t<p>see http://<b>x</b> a//b /* a */// b &#47;* c</p>\n}",
      "App.tsrx",
      [[["see http://", 29, 40], "b", [" a//b ", 48, 54], ["{}", 54, 61, [["Block", " a "]]], ["// b &#47;* c", 61, 74]], [["x", 43, 44]]],
    ],
    [
      "const x = <p>a &amp; /* c */ b &#47;/ d</p>;",
      "App.jsx",
      [[["a &amp; ", 13, 21], ["{}", 21, 28, [["Block", " c "]]], [" b &#47;/ d", 28, 39]]],
    ],
    [
      "const x = <p>\n  a /* c */ b\n  // d\n</p>;",
      "App.tsx",
      [[["\n  a ", 13, 18], ["{}", 18, 25, [["Block", " c "]]], [" b\n  ", 25, 30], ["{}", 30, 34, [["Line", " d"]]], ["\n", 34, 35]]],
    ],
    [
      "export function App({ x }) @{\n\t<div>@if (x) { <i /> } else text // e\n\t</div>\n}",
      "App.tsrx",
      [["JSXIfExpression", [" else text ", 53, 64], ["{}", 64, 68, [["Line", " e"]]], ["\n\t", 68, 70]], []],
    ],
    [
      "export function App({ x }) @{\n\t<div>@if (x) { <i /> } else\n\t</div>\n}",
      "App.tsrx",
      [["JSXIfExpression", [" else\n\t", 53, 60]], []],
    ],
    [
      "export function App() @{\n\t<p>a // e\u2028<b />\n\t</p>\n}",
      "App.tsrx",
      [[["a ", 29, 31], ["{}", 31, 41, [["Line", " e\u2028<b />"]]], ["\n\t", 41, 43]]],
    ],
    [
      "const x = <p>\n\t// <b> { }\n\t/* </p> a > b */\n</p>;",
      "App.tsx",
      [[["\n\t", 13, 15], ["{}", 15, 25, [["Line", " <b> { }"]]], ["\n\t", 25, 27], ["{}", 27, 43, [["Block", " </p> a > b "]]], ["\n", 43, 44]]],
    ],
  ];
  for (const [source, filename, expected] of cases) {
    assert.deepEqual(children(parseModule(source, filename)), expected, source);
  }
  // The comment itself, as core writes it.
  const [empty] = findAll(parseModule("const x = <p>a /* c */ b</p>;", "App.tsrx"), (node) => node.type === "JSXEmptyExpression");
  assert.deepEqual(empty.innerComments, [
    { type: "Block", value: " c ", start: 15, end: 22, loc: { start: { line: 1, column: 15 }, end: { line: 1, column: 22 } } },
  ]);
});

test("#118: collect mode records an unclosed element whose text holds a comment", () => {
  for (const source of [
    "export function App() @{\n\t<p>// c\n}\n",
    "export function App() @{\n\t<p>/* c */\n}\n",
    "export function App() @{\n\t<p>a\n// c\n}\n",
    "export function App() @{\n\t<p><b />\n// c\n}\n",
  ]) {
    const errors = [];
    parseModule(source, "App.tsrx", { collect: true, errors });
    assert.deepEqual(
      errors.map(({ message, code }) => [message, code]),
      [["Unclosed tag '<p>'. Expected '</p>' before end of template.", "TSRX1001"]],
      source,
    );
  }
});

test("#118: a .tsx or .jsx comment outside JSX text never hides an error core reports", () => {
  // The TSRX lane that reads text comments runs none of OXC's semantic checks, so a comment
  // anywhere else must not let it take over from the TSX lane's error.
  for (const source of [
    "// helper\nexport function f() { return 1; }\nbreak;\n",
    "const n = 010; // legacy\n",
    "with (o) {} /* c */\n",
  ]) {
    for (const filename of ["App.tsx", "App.jsx"]) {
      assert.throws(() => parseModule(source, filename), undefined, `${filename} ${source}`);
      const errors = [];
      let threw = false;
      try {
        parseModule(source, filename, { collect: true, errors });
      } catch {
        threw = true;
      }
      assert.ok(threw || errors.length > 0, `collect ${filename} ${source}`);
    }
  }
});

test("#110: a comment in JSX text is a comment to the parser, in source order", () => {
  const comments = [];
  parseModule("// top\nexport function App() @{\n\t<p>a /* x */ b\n\t\t// y\n\t</p>\n}", "App.tsrx", {
    comments,
  });
  assert.deepEqual(
    comments.map(({ type, value, start, end }) => [type, value, start, end]),
    [
      ["Line", " top", 0, 6],
      ["Block", " x ", 38, 45],
      ["Line", " y", 50, 54],
    ],
  );
});

test("#110: a comment that swallows a closing tag leaves the element unclosed, as core reports", () => {
  const unclosed = (tag) => `Unclosed tag '<${tag}>'. Expected '</${tag}>' before end of template.`;
  const strict = (source) => {
    try {
      parseModule(source, "App.tsrx");
    } catch (error) {
      return [error.message, error.pos, error.code ?? null, [error.loc.line, error.loc.column]];
    }
    return null;
  };
  const collected = (source) => {
    const errors = [];
    try {
      parseModule(source, "App.tsrx", { collect: true, errors });
    } catch (error) {
      return ["throws", error.message, error.pos, error.code];
    }
    return errors.map((error) => [error.message, error.pos, error.code]);
  };
  // A line comment runs over the closing tag; the element ends at the `}` closing the template.
  for (const [source, pos] of [
    ["export function App() @{\n\t<p>// c</p>\n}", 38],
    ["export function App() {\n\treturn <p>// c</p>;\n}", 45],
  ]) {
    assert.deepEqual(strict(source), [`${unclosed("p")} (3:0)`, pos, "TSRX1001", [3, 0]], source);
    assert.deepEqual(collected(source), [[unclosed("p"), pos, "TSRX1001"]], source);
  }
  const nested = "export function App() @{\n\t<div><p>// c</p></div>\n}";
  assert.deepEqual(collected(nested), [
    [unclosed("p"), 49, "TSRX1001"],
    [unclosed("div"), 49, "TSRX1001"],
  ]);
  // A block comment with no end runs to the end of the source.
  for (const [source, pos] of [
    ["export function App() @{\n\t<p>a /* open\n\t\tb</p>\n}", 48],
    ["export function App() {\n\treturn <p>a /* open\n\t\tb</p>;\n}", 55],
  ]) {
    assert.deepEqual(strict(source), [`${unclosed("p")} (4:1)`, pos, "TSRX1001", [4, 1]], source);
    assert.deepEqual(collected(source), ["throws", "'}' expected. (4:1)", pos, "TS1005"], source);
  }
});

test("#112: a non-breaking space next to a line break is text, not layout", () => {
  const cases = [
    [
      "export function App() @{\n\t<p>\u00a0\n\t\t<b /></p>\n}",
      [{ value: "\u00a0\n\t\t", raw: "\u00a0\n\t\t", start: 29, end: 33 }],
    ],
    [
      "export function App() @{\n\t<p><b />\n\t\t\u00a0</p>\n}",
      [{ value: "\n\t\t\u00a0", raw: "\n\t\t\u00a0", start: 34, end: 38 }],
    ],
    [
      "export function App() {\n\treturn <p>\u00a0\n\t\t<b /></p>;\n}",
      [{ value: "\u00a0\n\t\t", raw: "\u00a0\n\t\t", start: 35, end: 39 }],
    ],
  ];
  for (const [source, expected] of cases) {
    assert.deepEqual(texts(parseModule(source, "App.tsrx")), expected, JSON.stringify(source));
  }
});

test("#114: a plain function's <script> body is raw text on content, with no children", () => {
  const cases = [
    ["export function App({ code }) @{\n\t<div><script>{code}</script></div>\n}", "{code}"],
    ["export function App({ code }) {\n\treturn <div><script>{code}</script></div>;\n}", "{code}"],
    [
      "export function App({ code }) {\n\treturn <div><script>run(); {code}</script></div>;\n}",
      "run(); {code}",
    ],
    [
      "export function App() {\n\treturn (\n\t\t<script>\n\t\t\t// c\n\t\t\trun();\n\t\t</script>\n\t);\n}",
      "\n\t\t\t// c\n\t\t\trun();\n\t\t",
    ],
    ["export function App() {\n\treturn <script></script>;\n}", ""],
    ["export function App() {\n\treturn <script>if (a) { go(); }</script>;\n}", "if (a) { go(); }"],
    [
      'export function App() {\n\treturn <script type="application/json">{"a": 1}</script>;\n}',
      '{"a": 1}',
    ],
    ["export function App() {\n\treturn <script>if (a < b) go();</script>;\n}", "if (a < b) go();"],
    [
      "export function App() {\n\treturn <script>items.forEach((i) => log(i));</script>;\n}",
      "items.forEach((i) => log(i));",
    ],
  ];
  for (const [source, content] of cases) {
    const element = script(parseModule(source, "App.tsrx"));
    assert.equal(element.content, content, source);
    assert.deepEqual(element.children, [], source);
    const closeStart = source.lastIndexOf("</script>");
    assert.deepEqual(
      [element.closingElement.start, element.closingElement.end],
      [closeStart, closeStart + 9],
      source,
    );
  }
});

test("#116: a script body ends at </script, HTML whitespace, and >", () => {
  const cases = [
    ["export function App() @{\n\t<div><script>go();</script ></div>\n}", 44, 54],
    ["export function App() @{\n\t<div><script>go();</script\n\t></div>\n}", 44, 55],
    ["export function App() @{\n\t<div><script>go();</script\f></div>\n}", 44, 54],
    ["export function App() {\n\treturn <script>go();</script >;\n}", 45, 55],
  ];
  for (const [source, start, end] of cases) {
    for (const options of [undefined, { collect: true, errors: [] }, { loose: true, errors: [] }]) {
      const element = script(parseModule(source, "App.tsrx", options));
      assert.equal(element.content, "go();", source);
      assert.deepEqual([element.closingElement.start, element.closingElement.end], [start, end]);
      if (options) assert.deepEqual(options.errors, []);
    }
  }
});

test("#116: any other </script in a script body is TSRX1004", () => {
  const message = (written) =>
    `'${written}' can end a script in HTML, so a '<script>' body can't contain it. Write '<\\/${written.slice(2)}' instead.`;
  const cases = [
    ["</SCRIPT>", "</SCRIPT", 60, 69],
    ["</script/>", "</script", 61, 70],
    ["</scripts>", "</script", 61, 70],
  ];
  for (const [inner, written, closeStart, closeEnd] of cases) {
    const source = `export function App() @{\n\t<div><script>a = 1;${inner}b = 2;</script></div>\n}`;

    assert.throws(
      () => parseModule(source, "App.tsrx"),
      (error) => {
        assert.equal(error.message, message(written));
        assert.equal(error.code, "TSRX1004");
        assert.deepEqual([error.pos, error.end], [45, 53]);
        return true;
      },
      source,
    );

    for (const mode of ["collect", "loose"]) {
      const errors = [];
      const element = script(parseModule(source, "App.tsrx", { [mode]: true, errors }));
      assert.equal(element.content, `a = 1;${inner}b = 2;`, `${mode}: ${source}`);
      assert.deepEqual(element.children, []);
      assert.deepEqual(
        [element.closingElement.start, element.closingElement.end],
        [closeStart, closeEnd],
      );
      assert.deepEqual(
        errors.map(({ message, code, pos, end }) => ({ message, code, pos, end })),
        [{ message: message(written), code: "TSRX1004", pos: 45, end: 53 }],
        `${mode}: ${source}`,
      );
    }
  }
});

test("#116: a </script in a string outside a script body is not reported", () => {
  const source = 'export function App() {\n\tconst s = "</SCRIPT>";\n\treturn <script>a</script>;\n}';
  const errors = [];
  assert.equal(script(parseModule(source, "App.tsrx", { collect: true, errors })).content, "a");
  assert.deepEqual(errors, []);
});

const DYNAMIC_TAG_MESSAGE =
  "A dynamic tag expression must be an identifier, a member access such as `props.as` or `registry[name]`, or a string literal. Compute anything else before the element: `const Tag = c ? Child : Fallback;`, then `<{Tag} />`.";
const DYNAMIC_TAG_CODE = "TSRX2014";

const dynamicTagSource = (tag) =>
  `export function App({ tag, props, registry, name, c, A, B, Tag, getTag, getName, level, items, a }) @{\n\t<div>\n\t\t<{${tag}} />\n\t</div>\n}`;

const dynamicTagNames = (ast) =>
  findAll(ast, (node) => node.type === "JSXOpeningElement" && node.name?.type === "JSXExpressionContainer");

test("#115: identifiers, member chains, and string literals are dynamic tags", () => {
  for (const tag of ["tag", "props.as", "registry[name]", "'section'", "this.tag", "items[0]", "a.b[name][0].c"]) {
    const source = dynamicTagSource(tag);
    const errors = [];
    parseModule(source, "App.tsrx");
    parseModule(source, "App.tsrx", { collect: true, errors });
    assert.deepEqual(errors, [], tag);
  }
});

test("#115: any other dynamic tag expression is reported at the part core reports", () => {
  // [tag, the part @tsrx/core 0.5.0 reports]
  const cases = [
    ["c ? A : B", "c ? A : B"],
    ["props.as ?? 'div'", "props.as ?? 'div'"],
    ["(tag)", "(tag)"],
    ["(a).b", "(a)"],
    ["tag as any", "tag as any"],
    ["tag!", "tag!"],
    ["c && Tag", "c && Tag"],
    ["props?.as", "props?.as"],
    ["registry[getName()]", "getName()"],
    ["registry[(name)]", "(name)"],
    ["undefined", "undefined"],
    ["null", "null"],
    ["() => <b>x</b>", "() => <b>x</b>"],
    ["c || <b>x</b>", "c || <b>x</b>"],
    ["`div`", "`div`"],
    ["getTag()", "getTag()"],
    ["'h' + level", "'h' + level"],
    ["@if (c) {A} @else {B}", "@if (c) {A} @else {B}"],
  ];
  for (const [tag, part] of cases) {
    const source = dynamicTagSource(tag);
    const start = source.indexOf(part, source.indexOf("<{"));
    const end = start + part.length;
    assert.throws(
      () => parseModule(source, "App.tsrx"),
      (error) => {
        assert.equal(error.message, DYNAMIC_TAG_MESSAGE, tag);
        assert.equal(error.code, DYNAMIC_TAG_CODE, tag);
        assert.deepEqual([error.pos, error.end], [start, end], tag);
        return true;
      },
    );
    for (const mode of ["collect", "loose"]) {
      const errors = [];
      const ast = parseModule(source, "App.tsrx", { [mode]: true, errors });
      assert.deepEqual(
        errors.map((error) => [error.message, error.code, error.type, error.pos, error.end]),
        [[DYNAMIC_TAG_MESSAGE, DYNAMIC_TAG_CODE, "usage", start, end]],
        `${mode} ${tag}`,
      );
      // The check doesn't change the parse: the tag keeps its authored expression.
      const [opening] = dynamicTagNames(ast);
      assert.equal(opening.name.start, source.indexOf("<{") + 1, `${mode} ${tag}`);
    }
  }
});

test("#115: a paired element is reported once, and a nested tag reports before its parent", () => {
  const paired = "export function App({ c, A, B }) @{\n\t<div><{c ? A : B}>x</{c ? A : B}></div>\n}";
  const errors = [];
  parseModule(paired, "App.tsrx", { collect: true, errors });
  assert.deepEqual(
    errors.map((error) => [error.pos, error.end]),
    [[44, 53]],
  );

  const nested = "export function A() @{ const x=<{() => <{a()}/>}>x</{() => <{a()}/>}>; }";
  const nestedErrors = [];
  parseModule(nested, "A.tsrx", { collect: true, errors: nestedErrors });
  assert.deepEqual(
    nestedErrors.map((error) => nested.slice(error.pos, error.end) + "@" + error.pos),
    ["a()@41", "() => <{a()}/>@33", "a()@61"],
  );
  assert.throws(
    () => parseModule(nested, "A.tsrx"),
    (error) => error.pos === 41,
  );
});

test("#115: a spread or an empty dynamic tag is no expression and throws in every mode", () => {
  const cases = [
    ["export function App({ a }) @{\n\t<div><{...a} /></div>\n}", 37, "(2:7)"],
    ["export function App() @{\n\t<div><{} /></div>\n}", 33, "(2:8)"],
  ];
  for (const [source, pos, position] of cases) {
    for (const options of [undefined, { collect: true, errors: [] }, { loose: true, errors: [] }]) {
      assert.throws(
        () => parseModule(source, "App.tsrx", options),
        (error) => {
          assert.ok(error instanceof SyntaxError);
          assert.equal(error.message, `${DYNAMIC_TAG_MESSAGE} ${position}`);
          assert.equal(error.pos, pos);
          assert.equal(error.end, undefined);
          assert.equal(error.code, DYNAMIC_TAG_CODE);
          return true;
        },
      );
      // Core raises these through acorn, so collecting records nothing before the throw.
      assert.deepEqual(options?.errors ?? [], []);
    }
  }
});

// #113: every expected value is what @tsrx/core 0.5.0 reports for the source; `[message, pos, end]`.
function strictError(source) {
  try {
    parseModule(source, "App.tsrx");
  } catch (error) {
    return [error.message, error.pos, error.end ?? null];
  }
  return null;
}

function recordedErrors(source, mode) {
  const errors = [];
  parseModule(source, "App.tsrx", { [mode]: true, errors });
  return errors.map((error) => [error.message, error.pos, error.end]);
}

const REDECLARATIONS = [
  // let twice
  ["export function f() {\n\tlet count = 0;\n\tlet count = 1;\n\treturn count;\n}", [["Identifier 'count' has already been declared", 43, 44]]],
  // var in block vs let top
  ["let a; { var a; }", [["Identifier 'a' has already been declared", 13, 14]]],
  // function twice top
  ["function g() {} function g() {}", [["Identifier 'g' has already been declared", 25, 26]]],
  // function then var top
  ["function g() {} var g;", [["Identifier 'g' has already been declared", 20, 21]]],
  // function block vs let
  ["{ function g() {} let g; }", [["Identifier 'g' has already been declared", 22, 23]]],
  // import, then const
  ["import { a } from 'x';\nconst a = 1;", [["Identifier 'a' has already been declared", 29, 30]]],
  // import type then const
  ["import type { A } from 'x';\nconst A = 1;", [["Identifier 'A' has already been declared", 34, 35]]],
  // import then var
  ["import { a } from 'x';\nvar a;", [["Identifier 'a' has already been declared", 27, 28]]],
  // class twice
  ["class A {}\nclass A {}", [["Identifier 'A' has already been declared", 17, 18]]],
  // catch parameter, then let
  ["try {} catch (e) {\n\tlet e = 1;\n}", [["Identifier 'e' has already been declared", 24, 25]]],
  // catch pattern var
  ["try {} catch ({ e }) { var e = 1; }", [["Identifier 'e' has already been declared", 27, 28]]],
  // for of const var body
  ["for (const x of []) { var x; }", [["Identifier 'x' has already been declared", 26, 27]]],
  // switch case lets
  ["switch (1) { case 1: let a; case 2: let a; }", [["Identifier 'a' has already been declared", 40, 41]]],
  // using twice
  ["{ using a = null; using a = null; }", [["Identifier 'a' has already been declared", 24, 25]]],
  // declare const then let
  ["declare const a: number;\nlet a;", [["Identifier 'a' has already been declared", 29, 30]]],
  // declare class then class
  ["declare class A {}\nclass A {}", [["Identifier 'A' has already been declared", 25, 26]]],
  // enum then const
  ["enum E { A }\nconst E = 1;", [["Identifier 'E' has already been declared", 19, 20]]],
  // abstract class twice
  ["abstract class A {}\nabstract class A {}", [["Identifier 'A' has already been declared", 35, 36]]],
  // tsrx const then var in nested @{ }
  ["export function App({ ready }) @{\n\tconst count = 0;\n\t<div>@{\n\t\tif (ready) { var count = 1; }\n\t\t<span>{count}</span>\n\t}</div>\n}", [["Identifier 'count' has already been declared", 80, 81]]],
  // tsrx const then var in @if
  ["export function App({ ready }) @{\n\tconst count = 0;\n\t<div>@if (ready) {\n\t\tvar count = 1;\n\t\t<span>{count}</span>\n\t}</div>\n}", [["Identifier 'count' has already been declared", 78, 79]]],
  // tsrx let twice in body
  ["export function App() @{\n\tlet a = 1;\n\tlet a = 2;\n\t<div />\n}", [["Identifier 'a' has already been declared", 42, 43]]],
  // tsrx @for body var same
  ["export function App({ items }) @{\n\t<ul>@for (const x of items) { var x = 1; <li>{x}</li> }</ul>\n}", [["Identifier 'x' has already been declared", 69, 70]]],
  // tsrx @for var body vs outer const
  ["export function App({ items }) @{\n\tconst y = 0;\n\t<ul>@for (const x of items) { var y = 1; <li>{x}</li> }</ul>\n}", [["Identifier 'y' has already been declared", 83, 84]]],
  // tsrx @switch var vs const
  ["export function App({ k }) @{\n\tconst x = 0;\n\t<div>@switch (k) { @case 1: { var x = 1; <b>{x}</b> } }</div>\n}", [["Identifier 'x' has already been declared", 79, 80]]],
  // tsrx @try catch let
  ["export function App() @{\n\t<div>@try { <b /> } @catch (e) { const e = 1; <i>{e}</i> }</div>\n}", [["Identifier 'e' has already been declared", 65, 66]]],
  // tsrx @try catch reset same
  ["export function App() @{\n\t<div>@try { <b /> } @catch (e, e) { <i /> }</div>\n}", [["Identifier 'e' has already been declared", 57, 58]]],
  // tsrx @try pending var
  ["export function App() @{\n\tconst y = 1;\n\t<div>@try { <b /> } @pending { var y = 2; <p /> }</div>\n}", [["Identifier 'y' has already been declared", 75, 76]]],
  // tsrx function then var in body
  ["export function App() @{\n\tfunction h() {}\n\tvar h;\n\t<div />\n}", [["Identifier 'h' has already been declared", 47, 48]]],
  // tsrx component vs import
  ["import { App } from 'x';\nexport function App() @{ <div /> }", [["Identifier 'App' has already been declared", 41, 42]]],
  // tsrx @if in plain fn
  ["export function App({ a }) {\n\tconst x = 1;\n\treturn <div>@if (a) { var x = 2; <b /> }</div>;\n}", [["Identifier 'x' has already been declared", 70, 71]]],
  // tsrx var in two nested levels
  ["export function App() @{\n\tlet q = 1;\n\t<div><p>@{ @if (true) { var q = 2; <b /> } }</p></div>\n}", [["Identifier 'q' has already been declared", 66, 67]]],
  // order fn body then name
  ["let f;\nfunction f() { let a; let a; }", [["Identifier 'a' has already been declared", 33, 34], ["Identifier 'f' has already been declared", 16, 17]]],
  // component nested @for var
  ["export function App({ items }) @{\n\tlet i = 0;\n\t<ul>@for (const x of items) { @if (x) { var i = 1; <li /> } }</ul>\n}", [["Identifier 'i' has already been declared", 91, 92]]],
];

test("#113: a redeclared binding throws core's error, and collect and loose record it", () => {
  for (const [source, expected] of REDECLARATIONS) {
    assert.deepEqual(strictError(source), expected[0], source);
    assert.deepEqual(recordedErrors(source, "collect"), expected, source);
    assert.deepEqual(recordedErrors(source, "loose"), expected, source);
  }
});

const ARGUMENT_CLASHES = [
  // duplicate parameter
  ["export function f(a, a) {}", ["Argument name clash", 21, 22], [["Argument name clash", 18, 19], ["Argument name clash", 21, 22]]],
  // duplicate param two names
  ["function f(a, b, a, b) {}", ["Argument name clash", 17, 18], [["Argument name clash", 11, 12], ["Argument name clash", 17, 18], ["Argument name clash", 14, 15], ["Argument name clash", 20, 21]]],
  // duplicate param pattern
  ["function f({ a }, [a]) {}", ["Argument name clash", 19, 20], [["Argument name clash", 13, 14], ["Argument name clash", 19, 20]]],
  // duplicate param arrow
  ["const f = (a, a) => a;", ["Argument name clash", 14, 15], [["Argument name clash", 11, 12], ["Argument name clash", 14, 15]]],
  // param property dup
  ["class C { constructor(public a, a) {} }", ["Argument name clash", 32, 33], [["Argument name clash", 29, 30], ["Argument name clash", 32, 33]]],
  // tsrx dup params
  ["export function App(a, a) @{\n\t<div />\n}", ["Argument name clash", 23, 24], [["Argument name clash", 20, 21], ["Argument name clash", 23, 24]]],
  // tsrx arrow component
  ["export const App = (a, a) => @{ <div /> };", ["Argument name clash", 23, 24], [["Argument name clash", 20, 21], ["Argument name clash", 23, 24]]],
  // tsrx typed props dup
  ["export function App({ a }: { a: string }, a: number) @{ <div /> }", ["Argument name clash", 42, 43], [["Argument name clash", 22, 23], ["Argument name clash", 42, 51]]],
];

test("#113: a duplicate parameter throws at the second, and collect records both", () => {
  for (const [source, strict, recorded] of ARGUMENT_CLASHES) {
    assert.deepEqual(strictError(source), strict, source);
    assert.deepEqual(recordedErrors(source, "collect"), recorded, source);
    assert.deepEqual(recordedErrors(source, "loose"), recorded, source);
  }
});

const ACORN_RAISES = [
  // export of an undefined name
  ["export { missing };", ["Export 'missing' is not defined (1:9)", 9, null], [["Export 'missing' is not defined", 9, 10]]],
  // export two undefined
  ["export { m1, m2 };", ["Export 'm1' is not defined (1:9)", 9, null], [["Export 'm1' is not defined", 9, 10], ["Export 'm2' is not defined", 13, 14]]],
  // export let in block
  ["{ let a; }\nexport { a };", ["Export 'a' is not defined (2:9)", 20, null], [["Export 'a' is not defined", 20, 21]]],
  // export overload only
  ["function f(): void;\nexport { f };", ["Export 'f' is not defined (2:9)", 29, null], [["Export 'f' is not defined", 29, 30]]],
  // tsrx export undefined
  ["export function App() @{ <div /> }\nexport { Missing };", ["Export 'Missing' is not defined (2:9)", 44, null], [["Export 'Missing' is not defined", 44, 45]]],
  // type twice
  ["type A = 1;\ntype A = 2;", ["type 'A' has already been declared. (2:5)", 17, null], [["type 'A' has already been declared.", 17, 18]]],
  // interface and type
  ["interface A {}\ntype A = 1;", ["type 'A' has already been declared. (2:5)", 20, null], [["type 'A' has already been declared.", 20, 21]]],
];

test("#113: an undefined export and a redeclared type alias throw acorn's error shape", () => {
  for (const [source, strict, recorded] of ACORN_RAISES) {
    assert.deepEqual(strictError(source), strict, source);
    assert.deepEqual(recordedErrors(source, "collect"), recorded, source);
    assert.deepEqual(recordedErrors(source, "loose"), recorded, source);
  }
  assert.throws(
    () => parseModule("export { missing };", "App.tsrx"),
    (error) =>
      error instanceof SyntaxError &&
      error.message === "Export 'missing' is not defined (1:9)" &&
      error.pos === 9 &&
      error.loc.line === 1 &&
      error.loc.column === 9,
  );
});

const VALID_SCOPES = [
  // var twice fn
  "function f() { var a; var a; }",
  // var twice top
  "var a; var a;",
  // let in block shadows
  "let a; { let a; }",
  // function twice in fn
  "function f() { function g() {} function g() {} }",
  // function then var in fn
  "function f() { function g() {} var g; }",
  // catch param var
  "try {} catch (e) { var e = 1; }",
  // param then var
  "function f(a) { var a; }",
  // destructure dup var
  "var [a, a] = [];",
  // for let shadow
  "for (let i = 0; i < 1; i++) { let i; }",
  // for twice sibling
  "for (let i of []) {} for (let i of []) {}",
  // static block var
  "var a; class C { static { var a; } }",
  // export declared later
  "export { a };\nconst a = 1;",
  // export import
  "import { a } from 'x';\nexport { a };",
  // export type
  "type A = 1;\nexport { A };",
  // export interface
  "interface A {}\nexport type { A };",
  // export from
  "export { missing } from 'x';",
  // export var in block
  "{ var a; }\nexport { a };",
  // export namespace
  "namespace N {}\nexport { N };",
  // export declare fn
  "declare function f(): void;\nexport { f };",
  // export enum
  "enum E { A }\nexport { E };",
  // overloads
  "function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: any) {}",
  // export overloads
  "export function f(a: string): void;\nexport function f(a: any) {}",
  // overload then let
  "function f(): void;\nlet f;",
  // declare function twice
  "declare function f(): void;\ndeclare function f(): void;",
  // declare var twice
  "declare var a: number;\ndeclare var a: number;",
  // interface twice
  "interface A {}\ninterface A {}",
  // interface and class
  "interface A {}\nclass A {}",
  // type and interface
  "type A = 1;\ninterface A {}",
  // type and const
  "type A = 1;\nconst A = 1;",
  // enum twice
  "enum E { A }\nenum E { B }",
  // const enum twice
  "const enum E { A }\nconst enum E { B }",
  // enum and namespace
  "enum E { A }\nnamespace E {}",
  // namespace twice
  "namespace N {}\nnamespace N {}",
  // function and namespace
  "function f() {}\nnamespace f {}",
  // class and namespace
  "class C {}\nnamespace C {}",
  // declare module string
  "declare module 'x' { const a: number; }\nconst a = 1;",
  // declare global
  "declare global { var a: number; }\nvar a: number;",
  // this param
  "function f(this: any, a) {}",
  // generic param names
  "function f<T, T>() {}",
  // import type then interface
  "import type { A } from 'x';\ninterface A {}",
  // tsrx param then const in body
  "export function App({ a }) @{\n\tconst a = 1;\n\t<div>{a}</div>\n}",
  // tsrx param then var in body
  "export function App(a) @{\n\tvar a = 1;\n\t<div>{a}</div>\n}",
  // tsrx param then let in body plain name
  "export function App(count) @{\n\tlet count = 1;\n\t<div />\n}",
  // tsrx sibling @if bodies each const x
  "export function App({ a }) @{\n\t<div>@if (a) { const x = 1; <b>{x}</b> } @else { const x = 2; <i>{x}</i> }</div>\n}",
  // tsrx @if const shadows outer
  "export function App({ a }) @{\n\tconst x = 0;\n\t<div>@if (a) { const x = 1; <b>{x}</b> }</div>\n}",
  // tsrx @if var vs outer var
  "export function App({ a }) @{\n\tvar x = 0;\n\t<div>@if (a) { var x = 1; <b>{x}</b> }</div>\n}",
  // tsrx @for shadow
  "export function App({ items }) @{\n\tconst x = 0;\n\t<ul>@for (const x of items) { <li>{x}</li> }</ul>\n}",
  // tsrx @for body const same
  "export function App({ items }) @{\n\t<ul>@for (const x of items) { const x = 1; <li>{x}</li> }</ul>\n}",
  // tsrx @for index same as item
  "export function App({ items }) @{\n\t<ul>@for (const x of items; index x) { <li>{x}</li> }</ul>\n}",
  // tsrx @switch cases const
  "export function App({ k }) @{\n\t<div>@switch (k) { @case 1: { const x = 1; <b>{x}</b> } @case 2: { const x = 2; <i>{x}</i> } }</div>\n}",
  // tsrx @try catch var
  "export function App() @{\n\t<div>@try { <b /> } @catch (e) { var e = 1; <i>{e}</i> }</div>\n}",
  // tsrx sibling @{ } const
  "export function App() @{\n\t<div>@{ const x = 1; <b>{x}</b> }<span>@{ const x = 2; <i>{x}</i> }</span></div>\n}",
  // tsrx sibling @{ } var
  "export function App() @{\n\t<div>@{ var x = 1; <b>{x}</b> }<span>@{ var x = 2; <i>{x}</i> }</span></div>\n}",
  // tsrx sibling @{ } var vs let
  "export function App() @{\n\t<div>@{ let x = 1; <b>{x}</b> }<span>@{ var x = 2; <i>{x}</i> }</span></div>\n}",
  // tsrx nested fn var
  "export function App() @{\n\tconst x = 1;\n\tfunction h() { var x = 2; }\n\t<div />\n}",
  // tsrx arrow component body let vs param
  "export const App = (a) => @{ let a; <div /> };",
  // tsrx method component
  "export const o = { Render(a) @{ let a = 1; <div /> } };",
  // tsrx var in element handler arrow
  "export function App() @{\n\tconst x = 1;\n\t<button onClick={() => { var x = 2; }} />\n}",
  // nested component var
  "export function Outer() @{\n\tconst x = 1;\n\tfunction Inner() @{ var x = 2; <b /> }\n\t<div />\n}",
  // class method overloads
  "class C { m(a: string): void; m(a: any) {} constructor(a: string); constructor(a: any) {} }",
  // declare fn dup params
  "declare function f(a, a): void;",
  // overload dup params
  "function f(a, a): void;\nfunction f() {}",
  // abstract method dup
  "abstract class C { abstract m(a, a): void; }",
  // ts fn type dup
  "type F = (a: string, a: number) => void;",
  // const with same name in two components
  "export function A() @{ const x = 1; <b /> }\nexport function B() @{ const x = 1; <i /> }",
  // catch no param
  "try {} catch { let e; }",
];

test("#113: merging, shadowing, overloads, and template scopes core accepts stay valid", () => {
  for (const source of VALID_SCOPES) {
    assert.equal(strictError(source), null, source);
    assert.deepEqual(recordedErrors(source, "collect"), [], source);
    assert.deepEqual(recordedErrors(source, "loose"), [], source);
  }
});

const first = (ast, type) => findAll(ast, (node) => node.type === type)[0];

test("#125: a type parameter's name is an Identifier with its position", () => {
  // [source, name, start, line, column of the name, the type parameter's start and end]
  const cases = [
    ["function f<T>(x: T) {}", "T", 11, 1, 11, 11, 12],
    ["class A<in /* c */ out T> {}", "T", 23, 1, 23, 8, 24],
    ['function f<const T extends string = "a">() {}', "T", 17, 1, 17, 11, 39],
    ["function f<\n  const /* c */ T,\n>() {}", "T", 28, 2, 16, 14, 29],
    ["type M = { [K in keyof X]: X[K] };", "K", 12, 1, 12, 12, 24],
    ["type M = {\n  readonly [/* c */ K in keyof X as `k${K}`]?: X[K];\n};", "K", 31, 2, 20, 31, 43],
    ["type I = X extends Array<infer U> ? U : never;", "U", 31, 1, 31, 31, 32],
    ["type I = X extends Array<infer U extends string> ? U : never;", "U", 31, 1, 31, 31, 47],
  ];
  for (const [source, name, start, line, column, parameterStart, parameterEnd] of cases) {
    const parameter = first(parseModule(source, "App.tsrx"), "TSTypeParameter");
    assert.deepEqual([parameter.start, parameter.end], [parameterStart, parameterEnd], source);
    assert.deepEqual(
      parameter.name,
      {
        type: "Identifier",
        name,
        start,
        end: start + 1,
        loc: { start: { line, column }, end: { line, column: column + 1 } },
      },
      source,
    );
  }
  // A mapped type's key and constraint are its `typeParameter`, as in core.
  const mapped = first(parseModule(cases[5][0], "App.tsrx"), "TSMappedType");
  assert.deepEqual(Object.keys(mapped).sort(), [
    "end", "loc", "nameType", "optional", "readonly", "start", "type", "typeAnnotation", "typeParameter",
  ]);
  assert.equal(mapped.typeParameter.constraint.type, "TSTypeOperator");
});

test("#127: an enum's members are in a TSEnumBody that spans its braces", () => {
  // [source, the body's start, end, line, column, and member count]
  const cases = [
    ["enum E { A, B = 2 }", 7, 19, 1, 7, 2],
    ["enum E /* c */ { A }", 15, 20, 1, 15, 1],
    ["enum E // c\n{ A }", 12, 17, 2, 0, 1],
    ["declare const enum E {}", 21, 23, 1, 21, 0],
    ["export enum E {\n  A,\n}", 14, 22, 1, 14, 1],
  ];
  for (const [source, start, end, line, column, count] of cases) {
    const declaration = first(parseModule(source, "App.tsrx"), "TSEnumDeclaration");
    const { body } = declaration;
    assert.equal(body.type, "TSEnumBody", source);
    assert.deepEqual([body.start, body.end, body.loc.start], [start, end, { line, column }], source);
    assert.equal(body.members.length, count, source);
    assert.equal("members" in declaration, false, source);
  }
});

const SWITCH_ARMS = `export function App({ x }) @{
  @switch (x) {
    @case 1: /* c */ {
      const y = 1;
      <b>{y}</b>
    }
    @case 2: {
      {x}
    }
    @default: {
      // only a comment
    }
  }
}
function g(x) {
  switch (x) {
    case 1: { f(); }
    default: g();
  }
}`;

test("#128: each @case and @default arm is one BlockStatement from its { to its }", () => {
  const comments = [];
  const ast = parseModule(SWITCH_ARMS, "App.tsrx", { collect: true, errors: [], comments });
  const metadata = {
    path: [],
    native_tsrx_template_block: true,
    templateMode: "script",
    allows_native_return: false,
  };
  const arms = first(ast, "JSXSwitchExpression").cases.map(({ consequent }) => {
    assert.equal(consequent.length, 1);
    const [block] = consequent;
    assert.equal(block.type, "BlockStatement");
    assert.deepEqual(block.metadata, metadata);
    return [block.start, block.end, block.loc.start, block.body.map(({ type }) => type)];
  });
  assert.deepEqual(arms, [
    [67, 110, { line: 3, column: 21 }, ["VariableDeclaration", "JSXElement"]],
    [124, 141, { line: 7, column: 13 }, ["JSXExpressionContainer"]],
    [156, 187, { line: 10, column: 14 }, []],
  ]);
  // The empty arm's comment is inside its block.
  const comment = comments.find(({ value }) => value === " only a comment");
  assert.ok(comment.start > 156 && comment.end < 187);
  // A JavaScript switch is unchanged.
  const plain = first(ast, "SwitchStatement");
  assert.deepEqual(
    plain.cases.map(({ consequent }) => consequent.map(({ type }) => type)),
    [["BlockStatement"], ["ExpressionStatement"]],
  );
});

test("#128: each arm's block is a scope of its own", () => {
  const arm = (body) => `export function App({ x }) @{\n  @switch (x) {\n${body}\n  }\n}`;
  assert.equal(
    strictError(arm("    @case 1: {\n      const y = 1;\n      <b>{y}</b>\n    }\n    @default: {\n      const y = 2;\n      <i>{y}</i>\n    }")),
    null,
  );
  const error = strictError(arm("    @case 1: {\n      const y = 1;\n      let y;\n      <b>{y}</b>\n    }"));
  assert.deepEqual([error[0], error[1]], ["Identifier 'y' has already been declared", 90]);
});

// #117: each code is the one @tsrx/core (tsrx main at 21bb71e) gives the same mistake, where the
// messages can differ: a TSRX code for a mistake only TSRX reports, TypeScript's code otherwise.
const ERROR_CODES = [
  ["export function App() @{\n\t<div>\n}", "TSRX1001"],
  ["const a = <div></span>;", "TSRX1002"],
  ["const a = <div>@if (x) <b /></div>;", "TSRX1008"],
  ["const a = <div>@if (x) { <b /> } else { <i /> }</div>;", "TSRX1009"],
  ["const a = <div>@try { <b /> }</div>;", "TSRX1010"],
  ["function App() @{\n\t@for (const x of xs; index 0) {\n\t\t<li />\n\t}\n}", "TSRX1011"],
  ["function App() @{\n\t<a />\n\t<b />\n}", "TSRX2011"],
  ["function App() @{\n\t<a />\n\tconst x = 1;\n}", "TSRX2012"],
  ["function App() @{\n\t<>\n\t\t<style>p { color: red; </style>\n\t\t<p />\n\t</>\n}", "TSRX3013"],
  ["if (a) {", "TS1005"],
  ["let x = );", "TS1012"],
  ["class A {\n\treadonly public x = 1;\n}", "TS1029"],
  ["class A {\n\treadonly readonly a;\n}", "TS1030"],
  ["let a = 1;\nlet a = 2;", "TS2300"],
  ["function f(a, a) {}", "TS2300"],
  ["type A = 1;\ntype A = 2;", "TS2300"],
  ["export { missing };", "TS2304"],
  ["a ?? b || c;", "TS5076"],
  ["import a from 'a' with { type: 1 };", "TS2858"],
];

test("#117: an error carries the code @tsrx/core gives the same mistake", () => {
  for (const [source, code] of ERROR_CODES) {
    assert.throws(
      () => parseModule(source, "App.tsrx"),
      (error) => error.code === code,
      `${code} ${source}`,
    );
  }
  // A recorded error has its code too.
  for (const [source, code] of [
    ["function App() @{\n\t<a />\n\t<b />\n}", "TSRX2011"],
    ["let a = 1;\nlet a = 2;", "TS2300"],
    ["export function App() @{\n\t<p>// c\n}\n", "TSRX1001"],
  ]) {
    const errors = [];
    parseModule(source, "App.tsrx", { collect: true, errors });
    assert.deepEqual(errors.map((error) => error.code), [code], source);
  }
  // OXC gives a parameter property outside a constructor TS1090. TypeScript gives TS2369, as core
  // does when it records the error.
  assert.throws(() => parseModule("function f(private a) {}", "App.tsrx"), { code: "TS2369" });
});

// #111: character references in JSX text and string attributes. `value` is decoded as
// acorn-typescript's `jsx_readEntity` decodes it for @tsrx/core 0.5.2, and `raw` is as written.

// `[value, raw]` of every text that isn't only ASCII whitespace.
const textValues = (ast) =>
  findAll(ast, (node) => node.type === "JSXText")
    .filter(({ raw }) => raw.trim() !== "")
    .map(({ value, raw }) => [value, raw]);

// `[value, raw]` of every string attribute value.
const attributeValues = (ast) =>
  findAll(ast, (node) => node.type === "JSXAttribute" && node.value?.type === "Literal").map(
    ({ value }) => [value.value, value.raw],
  );

const inTemplate = (jsx) => `export function App() @{\n\t${jsx}\n}`;
const inFunction = (jsx) => `export function App() {\n\treturn ${jsx};\n}`;
const inModule = (jsx) => `const el = ${jsx};\nexport default el;`;

test("#111: attribute strings and text decode their references into value, in every JSX", () => {
  for (const wrap of [inTemplate, inFunction, inModule]) {
    for (const filename of ["App.tsrx", "App.tsx"]) {
      const attributes = parseModule(
        wrap(`<div title="a &amp;lt;b&amp;gt; &quot;q&quot; &#x2713;" alt='&apos;' />`),
        filename,
      );
      assert.deepEqual(attributeValues(attributes), [
        ['a &lt;b&gt; "q" ✓', '"a &amp;lt;b&amp;gt; &quot;q&quot; &#x2713;"'],
        ["'", "'&apos;'"],
      ]);
      const text = parseModule(wrap(`<p>a &quot;b&quot; &amp;lt; &nbsp;&#x1F600; &bogus;</p>`), filename);
      assert.deepEqual(textValues(text), [
        ['a "b" &lt;  😀 &bogus;', "a &quot;b&quot; &amp;lt; &nbsp;&#x1F600; &bogus;"],
      ]);
    }
  }
});

test("#111: only acorn-jsx's references decode; anything else stays as written", () => {
  const ast = parseModule(
    inTemplate(
      `<p a="AT&T & &; &&amp; &check; &amp &#1114112; &#X41;">AT&T & &; &&amp; &check; &amp &#1114112; &#X41; &#x10FFFF; &hearts; &#; &#xG;</p>`,
    ),
    "App.tsrx",
  );
  assert.deepEqual(attributeValues(ast), [
    ["AT&T & &; && &check; &amp &#1114112; A", '"AT&T & &; &&amp; &check; &amp &#1114112; &#X41;"'],
  ]);
  assert.deepEqual(textValues(ast), [
    [
      "AT&T & &; && &check; &amp &#1114112; A \u{10ffff} ♥ &#; &#xG;",
      "AT&T & &; &&amp; &check; &amp &#1114112; &#X41; &#x10FFFF; &hearts; &#; &#xG;",
    ],
  ]);
  // A name that is also an Object.prototype key is no table name.
  const proto = parseModule(inFunction(`<p a="&constructor;">&toString; &__proto__;</p>`), "App.tsrx");
  assert.deepEqual(attributeValues(proto), [["&constructor;", '"&constructor;"']]);
  assert.deepEqual(textValues(proto), [["&toString; &__proto__;", "&toString; &__proto__;"]]);
});

test("#111: a reference is read from at most 10 characters after the &, its ; included", () => {
  const ast = parseModule(
    inFunction(`<p a="&#00000065;&#000000065;">&#x0000041; &#x00000041; &thetasym; &abcdefghij;</p>`),
    "App.tsrx",
  );
  assert.deepEqual(attributeValues(ast), [["A&#000000065;", '"&#00000065;&#000000065;"']]);
  assert.deepEqual(textValues(ast), [
    ["A &#x00000041; ϑ &abcdefghij;", "&#x0000041; &#x00000041; &thetasym; &abcdefghij;"],
  ]);
});

test("#111: a reference cut off by a comment or a child is text", () => {
  for (const wrap of [inTemplate, inFunction]) {
    const ast = parseModule(wrap(`<b>&amp/* c */;</b>`), "App.tsrx");
    assert.deepEqual(textValues(ast), [
      ["&amp", "&amp"],
      [";", ";"],
    ]);
    const [element] = findAll(ast, (node) => node.type === "JSXElement");
    assert.deepEqual(
      element.children.map(({ type }) => type),
      ["JSXText", "JSXExpressionContainer", "JSXText"],
    );
  }
  assert.deepEqual(textValues(parseModule(inFunction(`<b>&amp<i />;</b>`), "App.tsrx")), [
    ["&amp", "&amp"],
    [";", ";"],
  ]);
  assert.deepEqual(textValues(parseModule(inTemplate(`<b>&amp{x};</b>`), "App.tsrx")), [
    ["&amp", "&amp"],
    [";", ";"],
  ]);
});

test("#111: text split by a comment decodes each piece on its own", () => {
  const ast = parseModule(inTemplate(`<b>&lt;x/* c */&gt;y // d\n&amp;</b>`), "App.tsrx");
  assert.deepEqual(textValues(ast), [
    ["<x", "&lt;x"],
    [">y ", "&gt;y "],
    ["\n&", "\n&amp;"],
  ]);
});

test("#111: text value reads CRLF as LF and raw keeps it; attribute strings keep CRLF", () => {
  const ast = parseModule(inFunction(`<p title="a\r\n&amp;b">\r\n  a &amp;\r\n  b\r c\r\n</p>`), "App.tsrx");
  assert.deepEqual(attributeValues(ast), [["a\r\n&b", '"a\r\n&amp;b"']]);
  assert.deepEqual(textValues(ast), [["\n  a &\n  b\r c\n", "\r\n  a &amp;\r\n  b\r c\r\n"]]);

  const file = "export function App() @{\r\n\t<p>\r\n\t\ta b\r\n\t</p>\r\n}\r\n";
  const [text] = findAll(parseModule(file, "App.tsrx"), (node) => node.type === "JSXText");
  assert.deepEqual([text.value, text.raw, text.start, text.end], ["\n\t\ta b\n\t", "\r\n\t\ta b\r\n\t", 30, 40]);
});

test("#111: strings in expression containers are JavaScript strings and are not decoded", () => {
  const ast = parseModule(inFunction(`<p a={"&amp;"}>{"&lt;"}{\`&gt;\`}</p>`), "App.tsrx");
  const strings = findAll(ast, (node) => node.type === "Literal" || node.type === "TemplateElement").map(
    (node) => (node.type === "Literal" ? node.value : node.value.cooked),
  );
  assert.deepEqual(strings.sort(), ["&amp;", "&gt;", "&lt;"]);
});

test("#111: the native parser keeps its JSX strings as written; only the compat facade decodes", async () => {
  const { parseSync } = await import("../../packages/toolchain/dist/parser.js");
  for (const filename of ["App.tsx", "App.tsrx"]) {
    const { program } = parseSync(filename, `const a = <p t="&amp;&nbsp;">&nbsp;\r\n</p>;`);
    assert.deepEqual(attributeValues(program), [["&amp;&nbsp;", '"&amp;&nbsp;"']], filename);
    assert.deepEqual(
      findAll(program, (node) => node.type === "JSXText").map(({ value, raw }) => [value, raw]),
      [["&nbsp;\r\n", "&nbsp;\r\n"]],
      filename,
    );
  }
});

// #145 and #146: text core reads where TSX would not. Each element's and fragment's children in
// source order, `[value, raw, start, end]` for a text and `[type, start, end]` for anything else.
const childShapes = (ast) =>
  findAll(ast, (node) => node.type === "JSXElement" || node.type === "JSXFragment")
    .sort((left, right) => left.start - right.start)
    .map((element) =>
      element.children.map((child) =>
        child.type === "JSXText"
          ? [child.value, child.raw, child.start, child.end]
          : [child.type, child.start, child.end],
      ),
    );

const everyJsxFile = ["App.tsrx", "App.tsx", "App.jsx"];

test("#145: a `>` in JSX text is text, in every JSX and every JSX file", () => {
  const cases = [
    [inTemplate, [[["a > b", "a > b", 29, 34]]]],
    [inFunction, [[["a > b", "a > b", 35, 40]]]],
    [inModule, [[["a > b", "a > b", 14, 19]]]],
  ];
  for (const filename of everyJsxFile) {
    for (const [wrap, expected] of cases) {
      assert.deepEqual(childShapes(parseModule(wrap("<p>a > b</p>"), filename)), expected, filename);
    }
  }
});

test("#145: a `>` at a text's edges, beside comments, children, entities, and line breaks", () => {
  for (const filename of everyJsxFile) {
    assert.deepEqual(
      childShapes(parseModule(inFunction("<div>>/* c */>{x}>>a<b />></div>"), filename)),
      [
        [
          [">", ">", 37, 38],
          ["JSXExpressionContainer", 38, 45],
          [">", ">", 45, 46],
          ["JSXExpressionContainer", 46, 49],
          [">>a", ">>a", 49, 52],
          ["JSXElement", 52, 57],
          [">", ">", 57, 58],
        ],
        [],
      ],
      filename,
    );
    assert.deepEqual(
      childShapes(parseModule(inModule("<div>a > <b>c > d</b> > e</div>"), filename)),
      [
        [
          ["a > ", "a > ", 16, 20],
          ["JSXElement", 20, 32],
          [" > e", " > e", 32, 36],
        ],
        [["c > d", "c > d", 23, 28]],
      ],
      filename,
    );
    assert.deepEqual(
      childShapes(parseModule(inModule("<p>&gt; > &amp;></p>"), filename)),
      [[["> > &>", "&gt; > &amp;>", 14, 27]]],
      filename,
    );
    assert.deepEqual(
      childShapes(parseModule(inModule("<>-> =></>"), filename)),
      [[["-> =>", "-> =>", 13, 18]]],
      filename,
    );
    assert.deepEqual(
      childShapes(parseModule(inModule("<p>\r\n>\r\n</p>"), filename)),
      [[["\n>\n", "\r\n>\r\n", 14, 19]]],
      filename,
    );
    assert.deepEqual(
      childShapes(parseModule(inModule("<p>😀>é</p>"), filename)),
      [[["😀>é", "😀>é", 14, 18]]],
      filename,
    );
  }
});

test("#145: a `>` in text in every control-flow body", () => {
  const ast = parseModule(
    inTemplate(
      "<div>@if (a) {<p>a > b</p>} @else {<p>c > d</p>}" +
        "@for (const v of vs) {<li>e > f</li>} @empty {<li>g > h</li>}" +
        "@try {<p>i > j</p>} @pending {<p>k > l</p>} @catch (e) {<p>m > n</p>}" +
        "@switch (k) {@case 1: {<p>o > p</p>} @default: {<p>q > r</p>}}</div>",
    ),
    "App.tsrx",
  );
  assert.deepEqual(childShapes(ast), [
    [
      ["JSXIfExpression", 31, 74],
      ["JSXForExpression", 74, 135],
      ["JSXTryExpression", 135, 204],
      ["JSXSwitchExpression", 204, 266],
    ],
    [["a > b", "a > b", 43, 48]],
    [["c > d", "c > d", 64, 69]],
    [["e > f", "e > f", 100, 105]],
    [["g > h", "g > h", 124, 129]],
    [["i > j", "i > j", 144, 149]],
    [["k > l", "k > l", 168, 173]],
    [["m > n", "m > n", 194, 199]],
    [["o > p", "o > p", 230, 235]],
    [["q > r", "q > r", 255, 260]],
  ]);
});

test("#145: a `>` in a .tsx script body leaves the element no children, as in core", () => {
  for (const filename of everyJsxFile) {
    assert.deepEqual(childShapes(parseModule(inModule("<script>a > b</script>"), filename)), [[]], filename);
  }
});

test("#145: a `>` outside JSX text is still an operator or a type argument's end", () => {
  const ast = parseModule(
    "const m = new Map<string, number>();\nconst f = <T,>(a: T) => m.size > 0 && <p>{a} > 0</p>;\nexport { f };",
    "App.tsx",
  );
  assert.deepEqual(childShapes(ast), [[["JSXExpressionContainer", 78, 81], [" > 0", " > 0", 81, 85]]]);
  assert.equal(findAll(ast, (node) => node.type === "BinaryExpression" && node.operator === ">").length, 1);
});

test("#145: the native TSRX parser keeps a `>` in text as written", async () => {
  const { parseSync } = await import("../../packages/toolchain/dist/parser.js");
  const { program, errors } = parseSync("App.tsrx", "const a = <p>>a > b<i />></p>;");
  assert.deepEqual(errors, []);
  assert.deepEqual(
    findAll(program, (node) => node.type === "JSXText").map(({ value, raw, start, end }) => [value, raw, start, end]),
    [
      [">a > b", ">a > b", 13, 19],
      [">", ">", 24, 25],
    ],
  );
});

test("#146: @empty, @case, @default, @else, @catch, and @pending in JSX text are text", () => {
  for (const filename of everyJsxFile) {
    for (const word of ["empty", "case", "default", "else", "catch", "pending"]) {
      assert.deepEqual(
        childShapes(parseModule(inTemplate(`<code>@${word}</code>`), filename)),
        [[[`@${word}`, `@${word}`, 32, 32 + word.length + 1]]],
        `${filename} @${word}`,
      );
    }
    assert.deepEqual(
      childShapes(
        parseModule(inFunction("<p>me@else.com @empty@pending @catch (e) {x} @case (1): y @default:</p>"), filename),
      ),
      [
        [
          ["me@else.com @empty@pending @catch (e) ", "me@else.com @empty@pending @catch (e) ", 35, 73],
          ["JSXExpressionContainer", 73, 76],
          [" @case (1): y @default:", " @case (1): y @default:", 76, 99],
        ],
      ],
      filename,
    );
    assert.deepEqual(
      childShapes(parseModule(inModule("<p>@elsewhere @emptyish @if @for x</p>"), filename)),
      [[["@elsewhere @emptyish @if @for x", "@elsewhere @emptyish @if @for x", 14, 45]]],
      filename,
    );
  }
});

test("#146: a branch keyword that no control owns is text, and one a control owns is its branch", () => {
  assert.deepEqual(childShapes(parseModule(inTemplate("<div>@if (a) {<b />} text @else {<i />}</div>"), "App.tsrx")), [
    [
      ["JSXIfExpression", 31, 46],
      [" text @else ", " text @else ", 46, 58],
      ["JSXExpressionContainer", 58, 65],
    ],
    [],
    [],
  ]);
  assert.deepEqual(
    childShapes(parseModule(inTemplate("<div>@if (a) {<p>@else</p>} @else {<p>@empty</p>}</div>"), "App.tsrx")),
    [[["JSXIfExpression", 31, 75]], [["@else", "@else", 43, 48]], [["@empty", "@empty", 64, 70]]],
  );
  // Outside JSX text, a branch with no owner is still an error.
  assert.throws(() => parseModule(inTemplate("@else {<p />}"), "App.tsrx"));
});

// #147 and #148: a shorthand attribute, `{name}`, is `name={name}` with `shorthand: true` in every
// JSX, on a dynamic tag too, as @tsrx/core 0.5.2 reads it. The values are core's, and the same
// ones tsrx-org/yuku#25 takes from it.
const shorthandAttributes = (ast) =>
  findAll(ast, (node) => node.type === "JSXOpeningElement")[0].attributes.map((attribute) =>
    attribute.type === "JSXSpreadAttribute"
      ? [attribute.type, attribute.start, attribute.end, attribute.argument.name]
      : [
          attribute.start,
          attribute.end,
          attribute.name.name,
          attribute.name.start,
          attribute.name.end,
          "shorthand" in attribute ? attribute.shorthand : "-",
          attribute.value?.type ?? null,
          attribute.value?.start,
          attribute.value?.end,
          attribute.value?.expression?.type,
          attribute.value?.expression?.name,
          attribute.value?.expression?.start,
          attribute.value?.expression?.end,
        ],
  );

const shorthandCases = {
  "a template": [
    "export function Link({ href }) @{\n\t<a {href} />\n}",
    [[38, 44, "href", 39, 43, true, "JSXExpressionContainer", 38, 44, "Identifier", "href", 39, 43]],
  ],
  "plain JSX in a function": [
    "export function link({ href }) {\n\treturn <a {href} />;\n}",
    [[44, 50, "href", 45, 49, true, "JSXExpressionContainer", 44, 50, "Identifier", "href", 45, 49]],
  ],
  "an arrow function's JSX": [
    "const link = (href) => <a {href} />;",
    [[26, 32, "href", 27, 31, true, "JSXExpressionContainer", 26, 32, "Identifier", "href", 27, 31]],
  ],
  "a template's dynamic tag": [
    "export function Heading({ tag, id }) @{\n\t<{tag} {id} />\n}",
    [[48, 52, "id", 49, 51, true, "JSXExpressionContainer", 48, 52, "Identifier", "id", 49, 51]],
  ],
  "an element mixing every attribute form": [
    'const v = <a x { a } y="1" {...r} {/* c */ b} {this} />;',
    [
      [13, 14, "x", 13, 14, "-", null, undefined, undefined, undefined, undefined, undefined, undefined],
      [15, 20, "a", 17, 18, true, "JSXExpressionContainer", 15, 20, "Identifier", "a", 17, 18],
      [21, 26, "y", 21, 22, "-", "Literal", 23, 26, undefined, undefined, undefined, undefined],
      ["JSXSpreadAttribute", 27, 33, "r"],
      [34, 45, "b", 43, 44, true, "JSXExpressionContainer", 34, 45, "Identifier", "b", 43, 44],
      [46, 52, "this", 47, 51, true, "JSXExpressionContainer", 46, 52, "Identifier", "this", 47, 51],
    ],
  ],
  "a reserved word, a line comment, and a name glued to the tag": [
    "const v = <a{class} {await // c\n} {\\u0061} />;",
    [
      [12, 19, "class", 13, 18, true, "JSXExpressionContainer", 12, 19, "Identifier", "class", 13, 18],
      [20, 33, "await", 21, 26, true, "JSXExpressionContainer", 20, 33, "Identifier", "await", 21, 26],
      [34, 42, "a", 35, 41, true, "JSXExpressionContainer", 34, 42, "Identifier", "a", 35, 41],
    ],
  ],
};

test("#147/#148: a shorthand attribute is name={name} in every JSX and every JSX file", () => {
  for (const [name, [source, expected]] of Object.entries(shorthandCases)) {
    for (const filename of everyJsxFile) {
      assert.deepEqual(shorthandAttributes(parseModule(source, filename)), expected, `${name} in ${filename}`);
    }
  }
});

test("#147: a shorthand attribute on a dynamic tag in plain JSX, after another attribute", () => {
  const ast = parseModule(
    'export function heading({ tag, id }) {\n\treturn <{tag} class="h" {id}>{id}</{tag}>;\n}',
    "App.tsrx",
  );
  assert.deepEqual(shorthandAttributes(ast), [
    [54, 63, "class", 54, 59, "-", "Literal", 60, 63, undefined, undefined, undefined, undefined],
    [64, 68, "id", 65, 67, true, "JSXExpressionContainer", 64, 68, "Identifier", "id", 65, 67],
  ]);
});

test("#148: `{await}` and `{yield}` are names in a template, as core reads them", () => {
  const ast = parseModule("export function App() @{\n\t<a {await} {yield} />\n}", "App.tsrx");
  assert.deepEqual(shorthandAttributes(ast), [
    [29, 36, "await", 30, 35, true, "JSXExpressionContainer", 29, 36, "Identifier", "await", 30, 35],
    [37, 44, "yield", 38, 43, true, "JSXExpressionContainer", 37, 44, "Identifier", "yield", 38, 43],
  ]);
});

test("#148: a malformed shorthand attribute fails with core's code at core's position", () => {
  for (const [source, code, pos] of [
    ["const v = <a {a.b} />;", "TS1005", 15],
    ["const v = <a {} />;", "TS1012", 14],
    ['const v = <a {"s"} />;', "TS1012", 14],
    ["const v = <a {a />;", "TS1005", 16],
    ["const v = <a {enum} />;", "TS1012", 14],
    ["const v = <a {a}={b} />;", "TS1012", 16],
  ]) {
    for (const filename of everyJsxFile) {
      assert.throws(
        () => parseModule(source, filename),
        (error) => error.code === code && error.pos === pos,
        `${source} in ${filename}`,
      );
    }
  }
});

test("#148: a shorthand name with escapes is read, and a bad or keyword escape fails, as in core", () => {
  // Bugbot on tsrx-org/oxc#158: escapes are decoded before `enum`, `interface`, and `type` are
  // refused, an escaped keyword fails at the name, and a bad escape fails where acorn fails it.
  for (const filename of everyJsxFile) {
    assert.deepEqual(
      shorthandAttributes(parseModule("const v = <a {\\u0061} {\\u{62}c} {a\\u0031} {\\u00e9} />;", filename)),
      [
        [13, 21, "a", 14, 20, true, "JSXExpressionContainer", 13, 21, "Identifier", "a", 14, 20],
        [22, 31, "bc", 23, 30, true, "JSXExpressionContainer", 22, 31, "Identifier", "bc", 23, 30],
        [32, 41, "a1", 33, 40, true, "JSXExpressionContainer", 32, 41, "Identifier", "a1", 33, 40],
        [42, 50, "é", 43, 49, true, "JSXExpressionContainer", 42, 50, "Identifier", "é", 43, 49],
      ],
      filename,
    );
    for (const [source, code, pos] of [
      ["const v = <a {t\\u0079pe} />;", "TS1012", 14],
      ["const v = <a {\\u0065num} />;", "TS1012", 14],
      ["const v = <a {\\u0063lass} />;", "TS1260", 14],
      ["const v = <a {\\u0031a} />;", "TS1127", 14],
      ["const v = <a {a\\u{0}} />;", "TS1127", 15],
      ["const v = <a {\\x61} />;", "TS1127", 15],
      ["const v = <a {ab\\u00} />;", "TS1125", 18],
      ["const v = <a {\\u{zz}} />;", "TS1125", 17],
      ["const v = <a {ab\\u{110000}} />;", "TS1198", 19],
    ]) {
      assert.throws(
        () => parseModule(source, filename),
        (error) => error.code === code && error.pos === pos,
        `${source} in ${filename}`,
      );
    }
  }
});

test("#148: an escaped combining mark or ID scalar continues a shorthand name, and a symbol fails", () => {
  // Bugbot on tsrx-org/oxc#158: an escaped continue character is any ID_Continue scalar, not
  // only a letter or digit, and an escaped Other_ID_Start scalar starts a name.
  for (const filename of everyJsxFile) {
    assert.deepEqual(
      shorthandAttributes(parseModule("const v = <a {a\\u0301} {\\u212E} {a\\u203F} />;", filename)),
      [
        [13, 22, "á", 14, 21, true, "JSXExpressionContainer", 13, 22, "Identifier", "á", 14, 21],
        [23, 31, "℮", 24, 30, true, "JSXExpressionContainer", 23, 31, "Identifier", "℮", 24, 30],
        [32, 41, "a‿", 33, 40, true, "JSXExpressionContainer", 32, 41, "Identifier", "a‿", 33, 40],
      ],
      filename,
    );
    for (const source of ["const v = <a {a\\u{1F600}} />;", "const v = <a {a\\u2192} />;"]) {
      assert.throws(
        () => parseModule(source, filename),
        (error) => error.code === "TS1127" && error.pos === 15,
        `${source} in ${filename}`,
      );
    }
  }
});

// #149: an `@if`, `@for`, `@switch`, or `@try` expression that starts a larger expression, or
// ends the file with nothing after its `}`. Each node outside the control, and the control itself,
// as `[type, start, end, "line:column-line:column"]`, in source order.
const controlOutline = (ast) => {
  const outline = [];
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type === "string" && node.loc) {
      const { start, end } = node.loc;
      outline.push([
        node.type,
        node.start,
        node.end,
        `${start.line}:${start.column}-${end.line}:${end.column}`,
      ]);
    }
    if (/^JSX(?:If|For|Switch|Try)Expression$/u.test(node.type)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "loc" || key === "metadata" || /omments$/u.test(key)) continue;
      visit(child);
    }
  };
  visit(ast);
  return outline;
};

test("#149: a control-flow expression is the left operand, test, or first expression, as in core", () => {
  for (const [source, outline] of [
    [
      "const content = @if (ready) {\n\t<p>Ready</p>\n} || 'Loading';",
      [
        ["Program", 0, 59, "1:0-3:15"],
        ["VariableDeclaration", 0, 59, "1:0-3:15"],
        ["VariableDeclarator", 6, 58, "1:6-3:14"],
        ["Identifier", 6, 13, "1:6-1:13"],
        ["LogicalExpression", 16, 58, "1:16-3:14"],
        ["JSXIfExpression", 16, 45, "1:16-3:1"],
        ["Literal", 49, 58, "3:5-3:14"],
      ],
    ],
    [
      "const x = @if (a) {\n\t<p />\n} || @if (b) {\n\t<q />\n} && 'y';",
      [
        ["Program", 0, 58, "1:0-5:9"],
        ["VariableDeclaration", 0, 58, "1:0-5:9"],
        ["VariableDeclarator", 6, 57, "1:6-5:8"],
        ["Identifier", 6, 7, "1:6-1:7"],
        ["LogicalExpression", 10, 57, "1:10-5:8"],
        ["JSXIfExpression", 10, 28, "1:10-3:1"],
        ["LogicalExpression", 32, 57, "3:5-5:8"],
        ["JSXIfExpression", 32, 50, "3:5-5:1"],
        ["Literal", 54, 57, "5:5-5:8"],
      ],
    ],
    [
      "const content = @if (ready) {\n\t<p>Ready</p>\n} ? a : b;",
      [
        ["Program", 0, 54, "1:0-3:10"],
        ["VariableDeclaration", 0, 54, "1:0-3:10"],
        ["VariableDeclarator", 6, 53, "1:6-3:9"],
        ["Identifier", 6, 13, "1:6-1:13"],
        ["ConditionalExpression", 16, 53, "1:16-3:9"],
        ["JSXIfExpression", 16, 45, "1:16-3:1"],
        ["Identifier", 48, 49, "3:4-3:5"],
        ["Identifier", 52, 53, "3:8-3:9"],
      ],
    ],
    [
      "const rows = @for (const item of items) {\n\t<li>{item}</li>\n} as unknown;",
      [
        ["Program", 0, 72, "1:0-3:13"],
        ["VariableDeclaration", 0, 72, "1:0-3:13"],
        ["VariableDeclarator", 6, 71, "1:6-3:12"],
        ["Identifier", 6, 10, "1:6-1:10"],
        ["TSAsExpression", 13, 71, "1:13-3:12"],
        ["JSXForExpression", 13, 60, "1:13-3:1"],
        ["TSUnknownKeyword", 64, 71, "3:5-3:12"],
      ],
    ],
    [
      "const rows = @switch (v) {\n\t@case 1: {\n\t\t<p />\n\t}\n} satisfies unknown;",
      [
        ["Program", 0, 70, "1:0-5:20"],
        ["VariableDeclaration", 0, 70, "1:0-5:20"],
        ["VariableDeclarator", 6, 69, "1:6-5:19"],
        ["Identifier", 6, 10, "1:6-1:10"],
        ["TSSatisfiesExpression", 13, 69, "1:13-5:19"],
        ["JSXSwitchExpression", 13, 51, "1:13-5:1"],
        ["TSUnknownKeyword", 62, 69, "5:12-5:19"],
      ],
    ],
    [
      "x = (@try {\n\t<p />\n} @catch (e) {\n\t<q />\n}, 1);",
      [
        ["Program", 0, 47, "1:0-5:6"],
        ["ExpressionStatement", 0, 47, "1:0-5:6"],
        ["AssignmentExpression", 0, 46, "1:0-5:5"],
        ["Identifier", 0, 1, "1:0-1:1"],
        ["SequenceExpression", 5, 45, "1:5-5:4"],
        ["JSXTryExpression", 5, 42, "1:5-5:1"],
        ["Literal", 44, 45, "5:3-5:4"],
      ],
    ],
  ]) {
    assert.deepEqual(controlOutline(parseModule(source, "App.tsrx")), outline, source);
  }
});

test("#149: a control-flow expression ends the file with nothing after its `}`, as in core", () => {
  for (const [source, outline] of [
    [
      "const content = @if (ready) {\n\t<p>Ready</p>\n}",
      [
        ["Program", 0, 45, "1:0-3:1"],
        ["VariableDeclaration", 0, 45, "1:0-3:1"],
        ["VariableDeclarator", 6, 45, "1:6-3:1"],
        ["Identifier", 6, 13, "1:6-1:13"],
        ["JSXIfExpression", 16, 45, "1:16-3:1"],
      ],
    ],
    [
      "const rows = @for (const item of items) {\n\t<li>{item}</li>\n}",
      [
        ["Program", 0, 60, "1:0-3:1"],
        ["VariableDeclaration", 0, 60, "1:0-3:1"],
        ["VariableDeclarator", 6, 60, "1:6-3:1"],
        ["Identifier", 6, 10, "1:6-1:10"],
        ["JSXForExpression", 13, 60, "1:13-3:1"],
      ],
    ],
    [
      "const f = () => @switch (v) {\n\t@case 1: {\n\t\t<p />\n\t}\n}",
      [
        ["Program", 0, 54, "1:0-5:1"],
        ["VariableDeclaration", 0, 54, "1:0-5:1"],
        ["VariableDeclarator", 6, 54, "1:6-5:1"],
        ["Identifier", 6, 7, "1:6-1:7"],
        ["ArrowFunctionExpression", 10, 54, "1:10-5:1"],
        ["JSXSwitchExpression", 16, 54, "1:16-5:1"],
      ],
    ],
    [
      "x = @try {\n\t<p />\n} @pending {\n\t<q />\n}",
      [
        ["Program", 0, 39, "1:0-5:1"],
        ["ExpressionStatement", 0, 39, "1:0-5:1"],
        ["AssignmentExpression", 0, 39, "1:0-5:1"],
        ["Identifier", 0, 1, "1:0-1:1"],
        ["JSXTryExpression", 4, 39, "1:4-5:1"],
      ],
    ],
  ]) {
    assert.deepEqual(controlOutline(parseModule(source, "App.tsrx")), outline, source);
  }
});

test("#149: a member access, call, or `!` after a control-flow expression fails as in core", () => {
  // Core reads no subscript after a control-flow expression, so each is an unexpected token at
  // the first character after the control's `}`.
  for (const tail of [".length", "()", "[0]", "?.x", "`t`", "!", "\n.length"]) {
    const source = `const x = @if (a) {\n\t<p />\n}${tail};`;
    const pos = source.indexOf(tail.trim(), 27);
    assert.throws(
      () => parseModule(source, "App.tsrx"),
      (error) => error.code === "TS1012" && error.pos === pos,
      source,
    );
  }
  // `!=` is an operator, and a parenthesized control takes a subscript.
  assert.doesNotThrow(() => parseModule("const x = @if (a) {\n\t<p />\n} != 1;", "App.tsrx"));
  assert.doesNotThrow(() => parseModule("const x = (@if (a) {\n\t<p />\n}).length;", "App.tsrx"));
});

// `undefined` spelled out, so a row tells a key core leaves undefined apart from a null.
const spelled = (value) => (value === undefined ? "undefined" : value);

test("a signature's and a function type's parameters and return type have core's names", () => {
  const source = [
    "interface I {",
    "\t(a: A): R;",
    "\tnew (b: B): I;",
    "\tm?<T extends unknown>(c: T): R;",
    "\tn();",
    "}",
    "type F = (d: D) => R;",
    "type C = abstract new () => R;",
    "type G = new () => R;",
  ].join("\n");
  const rows = findAll(parseModule(source, "App.tsrx"), (node) => /Signature|FunctionType|ConstructorType/u.test(node.type ?? ""))
    .sort((left, right) => left.start - right.start)
    .map((node) => [
      node.type,
      node.start,
      node.end,
      "typeParameters" in node,
      node.typeParameters?.params.map(({ name, constraint, default: fallback }) => [name.name, constraint?.type, spelled(fallback)]),
      node.parameters.map(({ name }) => name),
      spelled(node.typeAnnotation?.start),
      spelled(node.abstract),
      "params" in node || "returnType" in node,
    ]);
  assert.deepEqual(rows, [
    ["TSCallSignatureDeclaration", 15, 25, true, undefined, ["a"], 21, "undefined", false],
    ["TSConstructSignatureDeclaration", 27, 41, true, undefined, ["b"], 37, "undefined", false],
    ["TSMethodSignature", 43, 74, true, [["T", "TSUnknownKeyword", "undefined"]], ["c"], 70, "undefined", false],
    ["TSMethodSignature", 76, 80, true, undefined, [], "undefined", "undefined", false],
    ["TSFunctionType", 92, 103, true, undefined, ["d"], 99, "undefined", false],
    ["TSConstructorType", 114, 134, true, undefined, [], 130, true, false],
    ["TSConstructorType", 145, 156, true, undefined, [], 152, false, false],
  ]);
  // A declared function keeps `params` and `returnType`, as it does in core.
  const declared = parseModule("declare function d(a: A): R;", "App.tsrx").body[0];
  assert.deepEqual([declared.params.length, declared.returnType.type, "parameters" in declared], [1, "TSTypeAnnotation", false]);
});

test("a type parameter without a constraint or default leaves both undefined, as core does", () => {
  const [parameter] = parseModule("type X<P> = P;", "App.tsrx").body[0].typeParameters.params;
  assert.deepEqual(
    ["constraint" in parameter, spelled(parameter.constraint), "default" in parameter, spelled(parameter.default)],
    [true, "undefined", true, "undefined"],
  );
});

test("a JSX member name is not computed, as core gives it", () => {
  const names = findAll(parseModule("const v = <main><UI.List /><a.b.c /></main>;", "App.tsrx"), (node) => node.type === "JSXMemberExpression")
    .map(({ start, end, computed }) => [start, end, computed])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  assert.deepEqual(names, [[17, 24, false], [28, 31, false], [28, 33, false]]);
});

// #151: in an `@for` with `index` or `key`, a value may be parenthesized, as @tsrx/core 0.5.2
// reads it. Core drops the parentheses, so each value spans the expression inside them and has no
// `extra.parenthesized`. Each value is `[type, start, end, loc…, parenthesized]`, from core.
const forHeaderValue = (node) =>
  node && [
    node.type,
    node.start,
    node.end,
    node.loc.start.line,
    node.loc.start.column,
    node.loc.end.line,
    node.loc.end.column,
    node.extra?.parenthesized ?? false,
  ];

const forHeader = (ast) => {
  const loop = findAll(ast, (node) => node.type === "JSXForExpression")[0];
  return [forHeaderValue(loop.right), forHeaderValue(loop.index ?? null), forHeaderValue(loop.key ?? null)];
};

const inForStatement = (header) =>
  `export function List({ items, version, list }) @{\n\t@for (${header}) {\n\t\t<li>{item}</li>\n\t}\n}`;
const inForExpression = (header) => `const rows = @for (${header}) {\n\t<li>{item}</li>\n};`;

const parenthesizedForHeaders = {
  "a parenthesized iterable with a key": [
    "const item of (items); key item",
    [["Identifier", 72, 77, 2, 22, 2, 27, false], null, ["Identifier", 84, 88, 2, 34, 2, 38, false]],
    [["Identifier", 34, 39, 1, 34, 1, 39, false], null, ["Identifier", 46, 50, 1, 46, 1, 50, false]],
  ],
  "a parenthesized iterable with an index": [
    "const item of (items); index i",
    [["Identifier", 72, 77, 2, 22, 2, 27, false], ["Identifier", 86, 87, 2, 36, 2, 37, false], null],
    [["Identifier", 34, 39, 1, 34, 1, 39, false], ["Identifier", 48, 49, 1, 48, 1, 49, false], null],
  ],
  "a parenthesized key": [
    "const item of items; key (item)",
    [["Identifier", 71, 76, 2, 21, 2, 26, false], null, ["Identifier", 83, 87, 2, 33, 2, 37, false]],
    [["Identifier", 33, 38, 1, 33, 1, 38, false], null, ["Identifier", 45, 49, 1, 45, 1, 49, false]],
  ],
  "Ripple's parenthesized sequence": [
    "const item of (version.value, list); key item",
    [["SequenceExpression", 72, 91, 2, 22, 2, 41, false], null, ["Identifier", 98, 102, 2, 48, 2, 52, false]],
    [["SequenceExpression", 34, 53, 1, 34, 1, 53, false], null, ["Identifier", 60, 64, 1, 60, 1, 64, false]],
  ],
  "nested parentheses on every value": [
    "const item of ((items)); index (i); key ((item.id))",
    [
      ["Identifier", 73, 78, 2, 23, 2, 28, false],
      ["Identifier", 89, 90, 2, 39, 2, 40, false],
      ["MemberExpression", 99, 106, 2, 49, 2, 56, false],
    ],
    [
      ["Identifier", 35, 40, 1, 35, 1, 40, false],
      ["Identifier", 51, 52, 1, 51, 1, 52, false],
      ["MemberExpression", 61, 68, 1, 61, 1, 68, false],
    ],
  ],
  "a parenthesized sequence key": [
    "const item of items; index i; key (item.id, item)",
    [
      ["Identifier", 71, 76, 2, 21, 2, 26, false],
      ["Identifier", 84, 85, 2, 34, 2, 35, false],
      ["SequenceExpression", 92, 105, 2, 42, 2, 55, false],
    ],
    [
      ["Identifier", 33, 38, 1, 33, 1, 38, false],
      ["Identifier", 46, 47, 1, 46, 1, 47, false],
      ["SequenceExpression", 54, 67, 1, 54, 1, 67, false],
    ],
  ],
  "spaces and comments inside the parentheses": [
    "const item of ( /* a */ items ); key ( item // b\n)",
    [["Identifier", 81, 86, 2, 31, 2, 36, false], null, ["Identifier", 96, 100, 2, 46, 2, 50, false]],
    [["Identifier", 43, 48, 1, 43, 1, 48, false], null, ["Identifier", 58, 62, 1, 58, 1, 62, false]],
  ],
};

test("#151: a parenthesized iterable, index, or key in an @for header is the expression inside", () => {
  for (const [name, [header, statement, expression]] of Object.entries(parenthesizedForHeaders)) {
    assert.deepEqual(forHeader(parseModule(inForStatement(header), "App.tsrx")), statement, `${name}, statement`);
    assert.deepEqual(forHeader(parseModule(inForExpression(header), "App.tsrx")), expression, `${name}, expression`);
  }
});

test("#151: a parenthesized index must still be one name, as in core", () => {
  for (const index of ["(i, j)", "(i) + 1", "(x.value)"]) {
    assert.throws(
      () => parseModule(inForExpression(`const item of items; index ${index}`), "App.tsrx"),
      { code: "TSRX1011" },
      index,
    );
  }
});

test("#151: parentheses inside a header value, not around it, stay in the value's span", () => {
  // Bugbot on tsrx-org/oxc#163: a value that only starts or ends with a grouped operand spans
  // from that operand's `(` or to its `)`, in core as in OXC, so no stray parenthesis is left
  // outside it. `[type, start, end]` of the iterable and of the key are core's.
  const cases = [
    ["(a) + (b)", ["BinaryExpression", 33, 42], ["BinaryExpression", 44, 53]],
    ["(a)(b)", ["CallExpression", 33, 39], ["CallExpression", 44, 50]],
    ["(a, b)[0]", ["MemberExpression", 33, 42], ["MemberExpression", 44, 53]],
    ["(a) ? (b) : (c)", ["ConditionalExpression", 33, 48], ["ConditionalExpression", 44, 59]],
    ["(a).b + (c)", ["BinaryExpression", 33, 44], ["BinaryExpression", 44, 55]],
    ["((a) , (b))", ["SequenceExpression", 34, 43], ["SequenceExpression", 45, 54]],
  ];
  const loopOf = (header) =>
    findAll(parseModule(inForExpression(header), "App.tsrx"), (node) => node.type === "JSXForExpression")[0];
  const span = (node) => [node.type, node.start, node.end];
  for (const [value, right, key] of cases) {
    assert.deepEqual(span(loopOf(`const item of ${value}; key item`).right), right, `of ${value}`);
    assert.deepEqual(span(loopOf(`const item of items; key ${value}`).key), key, `key ${value}`);
  }
});

// Each opening element in source order as `[name, start, end, typeArguments]`, the type
// arguments as `[start, end, param types]`, or null for an element without them.
const openingTypeArguments = (ast) =>
  findAll(ast, (node) => node.type === "JSXOpeningElement")
    .sort((left, right) => left.start - right.start)
    .map(({ name, start, end, typeArguments }) => [
      name.name ?? `${name.object.name}.${name.property.name}`,
      start,
      end,
      typeArguments ? [typeArguments.start, typeArguments.end, typeArguments.params.map(({ type }) => type)] : null,
    ]);

test("#153: type arguments on a JSX element are its opening element's typeArguments", () => {
  const cases = {
    "in another element": [
      "const view = <main><List<string> /></main>;",
      [["main", 13, 19, null], ["List", 19, 35, [24, 32, ["TSStringKeyword"]]]],
    ],
    "with children": [
      "const view = <List<string>>a</List>;",
      [["List", 13, 27, [18, 26, ["TSStringKeyword"]]]],
    ],
    "self-closing, with an attribute": [
      "const view = <List<string> items={items} />;",
      [["List", 13, 43, [18, 26, ["TSStringKeyword"]]]],
    ],
    "on a member name": [
      "const view = <main><UI.List<string> /></main>;",
      [["main", 13, 19, null], ["UI.List", 19, 38, [27, 35, ["TSStringKeyword"]]]],
    ],
  };
  for (const [name, [source, expected]] of Object.entries(cases)) {
    for (const filename of ["App.tsrx", "App.tsx"]) {
      assert.deepEqual(openingTypeArguments(parseModule(source, filename)), expected, `${name} in ${filename}`);
    }
  }
  assert.deepEqual(
    openingTypeArguments(
      parseModule("export function App() @{\n\t<main>\n\t\t<List<string> items={items} />\n\t</main>\n}", "App.tsrx"),
    ),
    [["main", 26, 32, null], ["List", 35, 65, [40, 48, ["TSStringKeyword"]]]],
  );
});

test("#153: type arguments TypeScript accepts on an element parse, though core 0.5.2 rejects some", () => {
  // Core fails the first three with `Unexpected token`; TSX and OXC read them.
  for (const source of [
    "const v = <List<Map<string, Array<number>>>>x</List>;",
    "const v = <List<() => void> />;",
    "const v = <main><Pair<string, number> a={1} /></main>;",
    "export function App() @{\n\t<List<string>>{item}</List>\n}",
  ]) {
    assert.ok(openingTypeArguments(parseModule(source, "App.tsrx")).some(([, , , typeArguments]) => typeArguments), source);
  }
  assert.throws(() => parseModule("const v = <main><List<string /></main>;", "App.tsrx"));
});

// Each type parameter list as `[start, end, [name, start, end]...]`.
const typeParameterLists = (ast) =>
  findAll(ast, (node) => node.type === "TSTypeParameterDeclaration").map(({ start, end, params }) => [
    start,
    end,
    params.map(({ name, start, end }) => [name.name, start, end]),
  ]);

test("#152: a call signature's, construct signature's, or function type's type parameters are types", () => {
  const cases = {
    "call signature, then a defaulted type parameter": [
      "interface Trigger {\n\t<P>(props: P): void;\n}\n\ntype Props<P = unknown> = P;",
      [[21, 24, [["P", 22, 23]]], [55, 68, [["P", 56, 67]]]],
      [["TSCallSignatureDeclaration", 21, 41]],
    ],
    "function type": [
      "type Render = <P>(props: P) => void;",
      [[14, 17, [["P", 15, 16]]]],
      [["TSFunctionType", 14, 35]],
    ],
    "construct signature": [
      "interface Trigger {\n\tnew <P>(props: P): Trigger;\n}",
      [[25, 28, [["P", 26, 27]]]],
      [["TSConstructSignatureDeclaration", 21, 48]],
    ],
    "annotation with two type parameters": [
      "let render: <A, B>(a: A, b: B) => void;",
      [[12, 18, [["A", 13, 14], ["B", 16, 17]]]],
      [["TSFunctionType", 12, 38]],
    ],
  };
  for (const [name, [source, lists, signatures]] of Object.entries(cases)) {
    const ast = parseModule(source, "App.tsrx");
    assert.deepEqual(typeParameterLists(ast), lists, name);
    assert.deepEqual(
      findAll(ast, (node) => /Signature|FunctionType/.test(node.type ?? "")).map(({ type, start, end }) => [type, start, end]),
      signatures,
      name,
    );
  }
});

test("#152: markup that only looks like a signature is still markup, and an unclosed one still fails", () => {
  const ast = parseModule("export function A() @{\n\t<b>(note): y</b>\n}", "App.tsrx");
  assert.deepEqual(texts(ast).map(({ value }) => value), ["(note): y"]);
  assert.throws(() => parseModule("const x = <P>(p: P): void;", "App.tsrx"));
});

test("#153: a `>` in a template literal type argument is text, as core reads it (Bugbot on #160)", () => {
  assert.deepEqual(openingTypeArguments(parseModule("const view = <main><List<`a>b`> /></main>;", "App.tsrx")), [
    ["main", 13, 19, null],
    ["List", 19, 34, [24, 31, ["TSLiteralType"]]],
  ]);
  assert.deepEqual(openingTypeArguments(parseModule("const view = <List<`>`>>a</List>;", "App.tsrx")), [
    ["List", 13, 24, [18, 23, ["TSLiteralType"]]],
  ]);
});

test("#153: a typed element that starts a line after a statement is markup, as core reads it (Bugbot on #160)", () => {
  for (const [source, expected] of [
    ["export function App() @{\n\tconst x = 1\n\t<List<string> />\n}", [["List", 39, 55, [44, 52, ["TSStringKeyword"]]]]],
    ["export function App() @{\n\tconst x = 1\n\t<List<string>>{x}</List>\n}", [["List", 39, 53, [44, 52, ["TSStringKeyword"]]]]],
  ]) {
    assert.deepEqual(openingTypeArguments(parseModule(source, "App.tsrx")), expected, source);
  }
});

const RETURN_TYPE_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "MethodDefinition",
  "Property",
  "TSTypeAnnotation",
  "TSTypeReference",
  "TSTypeParameterInstantiation",
  "JSXCodeBlock",
  "JSXElement",
]);

const returnTypeShape = (ast) =>
  findAll(ast, (node) => RETURN_TYPE_NODES.has(node.type)).map(({ type, start, end, loc }) => [
    type,
    start,
    end,
    loc.start.line,
    loc.start.column,
    loc.end.line,
    loc.end.column,
  ]);

test("#150: a template body after a return type that ends in type arguments is the function body", () => {
  for (const [source, expected] of [
    [
      "function App(): Element<'div'> @{\n\t<div />\n}",
      [
        ["FunctionDeclaration", 0, 44, 1, 0, 3, 1],
        ["TSTypeAnnotation", 14, 30, 1, 14, 1, 30],
        ["TSTypeReference", 16, 30, 1, 16, 1, 30],
        ["TSTypeParameterInstantiation", 23, 30, 1, 23, 1, 30],
        ["JSXCodeBlock", 31, 44, 1, 31, 3, 1],
        ["JSXElement", 35, 42, 2, 1, 2, 8],
      ],
    ],
    [
      "const App = function (): Element<'div'> @{\n\t<div />\n};",
      [
        ["FunctionExpression", 12, 53, 1, 12, 3, 1],
        ["TSTypeAnnotation", 23, 39, 1, 23, 1, 39],
        ["TSTypeReference", 25, 39, 1, 25, 1, 39],
        ["TSTypeParameterInstantiation", 32, 39, 1, 32, 1, 39],
        ["JSXCodeBlock", 40, 53, 1, 40, 3, 1],
        ["JSXElement", 44, 51, 2, 1, 2, 8],
      ],
    ],
    [
      "class View {\n\trender(): Element<'div'> @{\n\t\t<div />\n\t}\n}",
      [
        ["MethodDefinition", 14, 54, 2, 1, 4, 2],
        ["FunctionExpression", 20, 54, 2, 7, 4, 2],
        ["TSTypeAnnotation", 22, 38, 2, 9, 2, 25],
        ["TSTypeReference", 24, 38, 2, 11, 2, 25],
        ["TSTypeParameterInstantiation", 31, 38, 2, 18, 2, 25],
        ["JSXCodeBlock", 39, 54, 2, 26, 4, 2],
        ["JSXElement", 44, 51, 3, 2, 3, 9],
      ],
    ],
    [
      "const view = {\n\trender(): Element<'div'> @{\n\t\t<div />\n\t},\n};",
      [
        ["Property", 16, 56, 2, 1, 4, 2],
        ["FunctionExpression", 22, 56, 2, 7, 4, 2],
        ["TSTypeAnnotation", 24, 40, 2, 9, 2, 25],
        ["TSTypeReference", 26, 40, 2, 11, 2, 25],
        ["TSTypeParameterInstantiation", 33, 40, 2, 18, 2, 25],
        ["JSXCodeBlock", 41, 56, 2, 26, 4, 2],
        ["JSXElement", 46, 53, 3, 2, 3, 9],
      ],
    ],
    [
      // The shape of Ripple's `packages/ripple/tests/server/dynamic-elements.test.tsrx`.
      "export function Dynamic({ tag }: {\n\ttag: string;\n}): TSRXElement<'div'> @{\n\t<div />\n}",
      [
        ["FunctionDeclaration", 7, 85, 1, 7, 5, 1],
        ["Property", 26, 29, 1, 26, 1, 29],
        ["TSTypeAnnotation", 31, 50, 1, 31, 3, 1],
        ["TSTypeAnnotation", 39, 47, 2, 4, 2, 12],
        ["TSTypeAnnotation", 51, 71, 3, 2, 3, 22],
        ["TSTypeReference", 53, 71, 3, 4, 3, 22],
        ["TSTypeParameterInstantiation", 64, 71, 3, 15, 3, 22],
        ["JSXCodeBlock", 72, 85, 3, 23, 5, 1],
        ["JSXElement", 76, 83, 4, 1, 4, 8],
      ],
    ],
    [
      "function App(): Promise<Map<string, () => void>> /* c */ @{\n\t<div />\n}",
      [
        ["FunctionDeclaration", 0, 70, 1, 0, 3, 1],
        ["TSTypeAnnotation", 14, 48, 1, 14, 1, 48],
        ["TSTypeReference", 16, 48, 1, 16, 1, 48],
        ["TSTypeParameterInstantiation", 23, 48, 1, 23, 1, 48],
        ["TSTypeReference", 24, 47, 1, 24, 1, 47],
        ["TSTypeParameterInstantiation", 27, 47, 1, 27, 1, 47],
        ["TSTypeAnnotation", 39, 46, 1, 39, 1, 46],
        ["JSXCodeBlock", 57, 70, 1, 57, 3, 1],
        ["JSXElement", 61, 68, 2, 1, 2, 8],
      ],
    ],
    [
      // A `>` or quote in a comment inside the list is not read (Bugbot on tsrx-org/oxc#162).
      "function App(): Foo<A /* > ' */> @{\n\t<div />\n}",
      [
        ["FunctionDeclaration", 0, 46, 1, 0, 3, 1],
        ["TSTypeAnnotation", 14, 32, 1, 14, 1, 32],
        ["TSTypeReference", 16, 32, 1, 16, 1, 32],
        ["TSTypeParameterInstantiation", 19, 32, 1, 19, 1, 32],
        ["TSTypeReference", 20, 21, 1, 20, 1, 21],
        ["JSXCodeBlock", 33, 46, 1, 33, 3, 1],
        ["JSXElement", 37, 44, 2, 1, 2, 8],
      ],
    ],
  ]) {
    assert.deepEqual(returnTypeShape(parseModule(source, "App.tsrx")), expected, source);
  }
});

test("#150: a template body after a comparison is still an expression code block", () => {
  const [declaration] = parseModule("const x = a > @{ <div /> };", "App.tsrx").body;
  const { type, operator, start, end, right } = declaration.declarations[0].init;
  assert.deepEqual(
    [type, operator, start, end, right.type, right.start, right.end, right.render.type],
    ["BinaryExpression", ">", 10, 26, "JSXCodeBlock", 14, 26, "JSXElement"],
  );
  // None of these follows a return type annotation, so each `@{` stays an expression code block
  // (Bugbot on tsrx-org/oxc#162 found each one read as a function body by an earlier approach).
  const [shift] = parseModule("const x = a < b << c > @{ <div /> };", "App.tsrx").body;
  const outer = shift.declarations[0].init;
  assert.deepEqual(
    [outer.operator, outer.start, outer.end, outer.left.operator, outer.left.start, outer.left.end],
    [">", 10, 35, "<", 10, 20],
  );
  assert.deepEqual([outer.right.type, outer.right.start, outer.right.end], ["JSXCodeBlock", 23, 35]);
  const comparisons = (source) =>
    findAll(parseModule(source, "App.tsrx"), (node) => node.operator === ">").map(({ start, end, right }) => [
      start,
      end,
      right.type,
      right.start,
      right.end,
    ]);
  assert.deepEqual(comparisons("a < b\nc > @{ <div /> };"), [[6, 22, "JSXCodeBlock", 10, 22]]);
  assert.deepEqual(comparisons("x = (a <<= b, c > @{ <div /> });"), [[14, 30, "JSXCodeBlock", 18, 30]]);
  assert.deepEqual(comparisons("x <<= y > @{ <div /> };"), [[6, 22, "JSXCodeBlock", 10, 22]]);
  assert.deepEqual(comparisons("y = c ? f(a) : b > @{ <div /> };"), [[15, 31, "JSXCodeBlock", 19, 31]]);
});

test("#200: preserveParens: true keeps each ParenthesizedExpression, as core does", () => {
  const initializers = (source, filename, options) =>
    parseModule(source, filename, options).body.map(({ declarations: [{ init }] }) => [
      init.type,
      init.start,
      init.end,
      init.loc.start.line,
      init.loc.start.column,
      init.loc.end.line,
      init.loc.end.column,
      init.expression?.type,
      init.expression?.start,
      init.expression?.end,
    ]);
  const source = "const a = (1 + 2);\nconst b = (<div />);\nconst c = ((x));\n";
  // Core reads every file with its TSRX grammar, so `.tsx` keeps the parentheses as `.tsrx` does.
  for (const filename of ["App.tsrx", "App.tsx"]) {
    assert.deepEqual(
      initializers(source, filename, { preserveParens: true }),
      [
        ["ParenthesizedExpression", 10, 17, 1, 10, 1, 17, "BinaryExpression", 11, 16],
        ["ParenthesizedExpression", 29, 38, 2, 10, 2, 19, "JSXElement", 30, 37],
        ["ParenthesizedExpression", 50, 55, 3, 10, 3, 15, "ParenthesizedExpression", 51, 54],
      ],
      filename,
    );
    const removed = [
      ["BinaryExpression", 11, 16, 1, 11, 1, 16, undefined, undefined, undefined],
      ["JSXElement", 30, 37, 2, 11, 2, 18, undefined, undefined, undefined],
      ["Identifier", 52, 53, 3, 12, 3, 13, undefined, undefined, undefined],
    ];
    assert.deepEqual(initializers(source, filename), removed, filename);
    assert.deepEqual(initializers(source, filename, { preserveParens: false }), removed, filename);
  }
  assert.deepEqual(
    initializers("const a = (1 + 2);\nconst c = ((x));\n", "App.ts", { preserveParens: true }),
    [
      ["ParenthesizedExpression", 10, 17, 1, 10, 1, 17, "BinaryExpression", 11, 16],
      ["ParenthesizedExpression", 29, 34, 2, 10, 2, 15, "ParenthesizedExpression", 30, 33],
    ],
  );
  // The option holds in the loose and comment-collecting parses too, which take the lazy lane.
  for (const options of [{ loose: true }, { comments: [] }]) {
    assert.deepEqual(
      initializers(source, "App.tsrx", { ...options, preserveParens: true }).map(([type]) => type),
      ["ParenthesizedExpression", "ParenthesizedExpression", "ParenthesizedExpression"],
    );
  }
});

test("#201: a default import named source from an inline module is a default import", () => {
  const imports = (source) =>
    parseModule(source, "App.tsrx").body.map((declaration) => ({
      type: declaration.type,
      phase: declaration.phase ?? null,
      specifiers: declaration.specifiers.map(({ type, local }) => [type, local.name, local.start, local.end]),
      source: [
        declaration.source.type,
        declaration.source.name ?? declaration.source.value,
        declaration.source.start,
        declaration.source.end,
      ],
    }));
  // `source` before `from <identifier>` is a binding, not the source phase keyword.
  assert.deepEqual(imports("import source from server;"), [
    {
      type: "ImportDeclaration",
      phase: null,
      specifiers: [["ImportDefaultSpecifier", "source", 7, 13]],
      source: ["Identifier", "server", 19, 25],
    },
  ]);
  // The same import named `defer` already parsed this way.
  assert.deepEqual(imports("import defer from server;"), [
    {
      type: "ImportDeclaration",
      phase: null,
      specifiers: [["ImportDefaultSpecifier", "defer", 7, 12]],
      source: ["Identifier", "server", 18, 24],
    },
  ]);
  // With a string source, `source` is a default import too.
  assert.deepEqual(imports("import source from './m.js';"), [
    {
      type: "ImportDeclaration",
      phase: null,
      specifiers: [["ImportDefaultSpecifier", "source", 7, 13]],
      source: ["Literal", "./m.js", 19, 27],
    },
  ]);
  // A second `from` still makes `source` the phase and `from` the binding.
  assert.deepEqual(imports("import source from from './m.wasm';"), [
    {
      type: "ImportDeclaration",
      phase: "source",
      specifiers: [["ImportDefaultSpecifier", "from", 14, 18]],
      source: ["Literal", "./m.wasm", 24, 34],
    },
  ]);
  // Next to an inline module declaration, the import keeps its identifier source.
  const [, declaration] = parseModule(
    "module server { export const value = 1; }\nimport source from server;",
    "App.tsrx",
  ).body;
  assert.deepEqual(
    [declaration.type, declaration.phase ?? null, declaration.specifiers[0].local.name, declaration.source.type],
    ["ImportDeclaration", null, "source", "Identifier"],
  );

  // A binding named `from` elsewhere in the file is never read as an inline module name, so a
  // source phase import next to the inline module import keeps its phase (Bugbot on #207).
  const shapes = (source) =>
    parseModule(source, "App.tsrx").body.map((node) => [
      node.type,
      node.phase ?? null,
      node.specifiers?.map(({ local, exported }) => (exported ?? local).name) ?? null,
      node.source ? [node.source.type, node.source.name ?? node.source.value, node.source.start, node.source.end] : null,
    ]);
  assert.deepEqual(shapes("import source from server;\nimport source from from './m.wasm';"), [
    ["ImportDeclaration", null, ["source"], ["Identifier", "server", 19, 25]],
    ["ImportDeclaration", "source", ["from"], ["Literal", "./m.wasm", 51, 61]],
  ]);
  assert.deepEqual(shapes("import source from from './m.wasm';\nimport source from server;"), [
    ["ImportDeclaration", "source", ["from"], ["Literal", "./m.wasm", 24, 34]],
    ["ImportDeclaration", null, ["source"], ["Identifier", "server", 55, 61]],
  ]);
  assert.deepEqual(shapes("export { from } from server;\nimport source from from './m.wasm';"), [
    ["ExportNamedDeclaration", null, ["from"], ["Identifier", "server", 21, 27]],
    ["ImportDeclaration", "source", ["from"], ["Literal", "./m.wasm", 53, 63]],
  ]);
  // A source phase import of `from` from an inline module.
  assert.deepEqual(shapes("import source from from server;"), [
    ["ImportDeclaration", "source", ["from"], ["Identifier", "server", 24, 30]],
  ]);
  // `from as`, and a `from` that is a value, are not module sources.
  assert.deepEqual(
    shapes(
      "import source from server;\nexport { from as alias } from './m.js';\nimport { from as x } from server;",
    ),
    [
      ["ImportDeclaration", null, ["source"], ["Identifier", "server", 19, 25]],
      ["ExportNamedDeclaration", null, ["alias"], ["Literal", "./m.js", 57, 65]],
      ["ImportDeclaration", null, ["x"], ["Identifier", "server", 93, 99]],
    ],
  );
  assert.deepEqual(shapes("const from = 1;\nconst found = from in {};\nimport source from server;"), [
    ["VariableDeclaration", null, null, null],
    ["VariableDeclaration", null, null, null],
    ["ImportDeclaration", null, ["source"], ["Identifier", "server", 61, 67]],
  ]);
  // Comments after the name, and a last statement without a `;`, still end the specifier.
  assert.deepEqual(
    shapes("import source from server /* c */;\nimport defer from server // c\nexport * from server"),
    [
      ["ImportDeclaration", null, ["source"], ["Identifier", "server", 19, 25]],
      ["ImportDeclaration", null, ["defer"], ["Identifier", "server", 53, 59]],
      ["ExportAllDeclaration", null, null, ["Identifier", "server", 79, 85]],
    ],
  );
});
