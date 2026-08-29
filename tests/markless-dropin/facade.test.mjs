import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createTsrxCoreCompat } from "../../packages/tsrx-core-compat/dist/facade.js";

function makeProgram() {
  return {
    type: "Program",
    start: 0,
    end: 21,
    sourceType: "module",
    hashbang: null,
    body: [],
  };
}

function makeNativeError(message = "Unexpected token") {
  return {
    severity: "Error",
    message,
    labels: [{ start: 13, end: 14, message: "expected an expression" }],
    helpMessage: null,
    codeframe: null,
  };
}

test("parseModule delegates to the TSRX parser with the exact OXC options", () => {
  const calls = [];
  const program = makeProgram();
  const api = createTsrxCoreCompat({
    parseSync(...args) {
      calls.push(args);
      return { program, comments: [], errors: [] };
    },
  });

  assert.equal(api.parseModule("export const answer = 42"), program);
  assert.deepEqual(calls, [
    [
      "module.tsrx",
      "export const answer = 42",
      { lang: "tsrx", sourceType: "module", astType: "ts", preserveParens: true },
    ],
  ]);
  const marker = Object.getOwnPropertyDescriptor(
    calls[0][2],
    Symbol.for("@oxc-tsrx/parser/tsrx-core-compat-eager"),
  );
  assert.deepEqual(marker, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
});

test("parseModule preserves ordinary JSX lanes and enables JSX for object TypeScript", () => {
  const calls = [];
  const api = createTsrxCoreCompat({
    parseSync(...args) {
      calls.push(args);
      return { program: makeProgram(), comments: [], errors: [] };
    },
  });

  api.parseModule("function App() { return <main/>; }", "src/App.tsx");
  api.parseModule("export const view = <main/>;", "src/App.jsx");
  api.parseModule("export const view = <view/>;", "src/App.object.ts");
  api.parseModule(
    '// `@{}` is documentation\nconst example = "@{"; function App() { return <main/>; }',
    "src/Documented.tsx",
  );
  api.parseModule(
    "const marker = /@{/; function App() { return <main>{marker.source}</main>; }",
    "src/Regex.tsx",
  );

  for (const [filename, _source, options] of calls) {
    assert.match(filename, /(?:\.[jt]sx|\.object\.ts)$/u);
    assert.deepEqual(options, {
      lang: "tsx",
      sourceType: "module",
      astType: "ts",
      preserveParens: false,
      showSemanticErrors: true,
    });
  }
});

test("parseModule retries authored TSX template bodies without misreading JSX apostrophes", () => {
  const calls = [];
  const api = createTsrxCoreCompat({
    parseSync(...args) {
      calls.push(args);
      if (args[2].lang === "tsx") {
        return { program: null, comments: [], errors: [makeNativeError()] };
      }
      return { program: makeProgram(), comments: [], errors: [] };
    },
  });

  api.parseModule(
    "function Label() { return <p>don't</p>; } export function App() @{ <main/> }",
    "src/App.tsx",
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0][2].lang, "tsx");
  assert.equal(calls[1][2].lang, "tsrx");
  assert.equal(calls[1][2].preserveParens, true);
  assert.equal(
    calls[1][2][Symbol.for("@oxc-tsrx/parser/tsrx-core-compat-eager")],
    true,
  );
});

test("comment and loose paths retain the complete lazy parser result", () => {
  const seen = [];
  const api = createTsrxCoreCompat({
    parseSync(_filename, _source, options) {
      seen.push(options);
      return { program: makeProgram(), comments: [], errors: [] };
    },
  });
  api.parseModule("export {}", "Comments.tsrx", { comments: [] });
  api.parseModule("export {}", "Loose.tsrx", { loose: true, errors: [] });

  const marker = Symbol.for("@oxc-tsrx/parser/tsrx-core-compat-eager");
  assert.equal(seen.length, 2);
  assert.equal(seen[0][marker], undefined);
  assert.equal(seen[1][marker], undefined);
});

test("the private scalar success path is accepted as the concrete Program", () => {
  const program = makeProgram();
  const api = createTsrxCoreCompat({
    parseSync() {
      return program;
    },
  });
  assert.equal(api.parseModule("export const answer = 42"), program);
});

test("parseModule sends generated JavaScript through OXC's TypeScript-compatible semantic-error lane", () => {
  const calls = [];
  const program = makeProgram();
  const api = createTsrxCoreCompat({
    parseSync(...args) {
      calls.push(args);
      return { program, comments: [], errors: [] };
    },
  });

  assert.equal(api.parseModule("export { missing };", "generated.js"), program);
  assert.deepEqual(calls, [
    [
      "generated.js",
      "export { missing };",
      {
        lang: "ts",
        sourceType: "module",
        astType: "js",
        preserveParens: false,
        showSemanticErrors: true,
      },
    ],
  ]);
});

test("the successful no-comment path adds source locations without materializing comments", () => {
  const program = makeProgram();
  let commentsGetterReads = 0;
  const source = "export const answer = 42";
  const api = createTsrxCoreCompat({
    parseSync(_filename, observedSource) {
      assert.equal(observedSource, source);
      return {
        program,
        errors: [],
        get comments() {
          commentsGetterReads += 1;
          throw new Error("the compatibility layer materialized comments");
        },
      };
    },
  });

  assert.equal(api.parseModule(source), program);
  assert.equal(commentsGetterReads, 0);
  assert.deepEqual(program.loc, {
    start: { line: 1, column: 0 },
    end: { line: 1, column: source.length },
  });
});

test("TSRX compatibility restores element metadata and significant JSX whitespace", () => {
  const source = "<main>\n  <span></span>\n  hello<br/>\n  world\n</main>";
  const mainClose = source.indexOf("</main>");
  const spanStart = source.indexOf("<span>");
  const spanClose = source.indexOf("</span>");
  const spanEnd = spanClose + "</span>".length;
  const brStart = source.indexOf("<br/>");
  const brEnd = brStart + "<br/>".length;
  const program = {
    type: "Program",
    start: 0,
    end: source.length,
    sourceType: "module",
    body: [
      {
        type: "JSXElement",
        start: 0,
        end: source.length,
        openingElement: {
          type: "JSXOpeningElement",
          start: 0,
          end: "<main>".length,
          name: { type: "JSXIdentifier", name: "main", start: 1, end: 5 },
          attributes: [],
          selfClosing: false,
        },
        closingElement: {
          type: "JSXClosingElement",
          start: mainClose,
          end: source.length,
          name: {
            type: "JSXIdentifier",
            name: "main",
            start: mainClose + 2,
            end: mainClose + 6,
          },
        },
        children: [
          {
            type: "JSXText",
            value: source.slice("<main>".length, spanStart),
            raw: source.slice("<main>".length, spanStart),
            start: "<main>".length,
            end: spanStart,
          },
          {
            type: "JSXElement",
            start: spanStart,
            end: spanEnd,
            openingElement: {
              type: "JSXOpeningElement",
              start: spanStart,
              end: spanClose,
              name: {
                type: "JSXIdentifier",
                name: "span",
                start: spanStart + 1,
                end: spanStart + 5,
              },
              attributes: [],
              selfClosing: false,
            },
            closingElement: {
              type: "JSXClosingElement",
              start: spanClose,
              end: spanEnd,
              name: {
                type: "JSXIdentifier",
                name: "span",
                start: spanClose + 2,
                end: spanClose + 6,
              },
            },
            children: [],
          },
          {
            type: "JSXText",
            value: source.slice(spanEnd, brStart),
            raw: source.slice(spanEnd, brStart),
            start: spanEnd,
            end: brStart,
          },
          {
            type: "JSXElement",
            start: brStart,
            end: brEnd,
            openingElement: {
              type: "JSXOpeningElement",
              start: brStart,
              end: brEnd,
              name: {
                type: "JSXIdentifier",
                name: "br",
                start: brStart + 1,
                end: brStart + 3,
              },
              attributes: [],
              selfClosing: true,
            },
            closingElement: null,
            children: [],
          },
          {
            type: "JSXText",
            value: source.slice(brEnd, mainClose),
            raw: source.slice(brEnd, mainClose),
            start: brEnd,
            end: mainClose,
          },
        ],
      },
    ],
  };
  const api = createTsrxCoreCompat({
    parseSync() {
      return { program, comments: [], errors: [] };
    },
  });

  api.parseModule(source, "src/View.tsrx");

  const main = program.body[0];
  const [span, afterSpan, br, afterBr] = main.children;
  assert.equal(main.children.length, 4);
  assert.deepEqual(main.metadata, {
    path: [],
    native_tsrx: true,
    templateMode: "template",
    commentContainerId: 1,
  });
  assert.deepEqual(span.metadata, {
    path: [],
    native_tsrx: true,
    templateMode: "template",
    commentContainerId: 2,
  });
  assert.deepEqual(br.metadata, {
    path: [],
    native_tsrx: true,
    templateMode: "script",
    commentContainerId: 3,
  });
  assert.deepEqual(
    { value: afterSpan.value, raw: afterSpan.raw, start: afterSpan.start },
    { value: "hello", raw: "hello", start: spanEnd + 3 },
  );
  assert.equal(afterBr.value, "\n  world\n");
});

test("TSRX compatibility restores parser metadata and unwraps parenthesized expressions", () => {
  const source = "namespace Example {}\n(value)";
  const moduleEnd = source.indexOf("\n");
  const valueStart = source.indexOf("value");
  const program = {
    type: "Program",
    start: 0,
    end: source.length,
    sourceType: "module",
    body: [
      {
        type: "TSModuleDeclaration",
        kind: "namespace",
        start: 0,
        end: moduleEnd,
        id: { type: "Identifier", name: "Example", start: 10, end: 17 },
        body: { type: "TSModuleBlock", body: [], start: 18, end: moduleEnd },
      },
      {
        type: "ParenthesizedExpression",
        start: moduleEnd + 1,
        end: source.length,
        expression: {
          type: "Identifier",
          decorators: [],
          name: "value",
          optional: false,
          typeAnnotation: null,
          start: valueStart,
          end: valueStart + "value".length,
        },
      },
      {
        type: "JSXIfExpression",
        start: 0,
        end: 0,
        consequent: { type: "BlockStatement", start: 0, end: 0, body: [] },
        alternate: { type: "BlockStatement", start: 0, end: 0, body: [] },
      },
      {
        type: "JSXSwitchExpression",
        start: 0,
        end: 0,
        cases: [
          {
            type: "SwitchCase",
            start: 0,
            end: 0,
            test: null,
            consequent: [
              {
                type: "BlockStatement",
                start: 0,
                end: 0,
                body: [
                  {
                    type: "ExpressionStatement",
                    start: 0,
                    end: 0,
                    expression: { type: "Identifier", name: "view", start: 0, end: 0 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const api = createTsrxCoreCompat({
    parseSync() {
      return { program, comments: [], errors: [] };
    },
  });

  api.parseModule(source, "src/Metadata.tsrx");

  assert.deepEqual(program.body[0].metadata, {
    path: [],
    module_keyword: "namespace",
  });
  assert.equal(program.body[1].type, "Identifier");
  assert.deepEqual(program.body[1].metadata, { path: [], parenthesized: true });
  assert.equal("decorators" in program.body[1], false);
  assert.equal("optional" in program.body[1], false);
  assert.equal("typeAnnotation" in program.body[1], false);
  assert.deepEqual(program.body[2].consequent.metadata, {
    path: [],
    native_tsrx_template_block: true,
    templateMode: "script",
    allows_native_return: false,
  });
  assert.deepEqual(program.body[2].alternate.metadata, program.body[2].consequent.metadata);
  assert.deepEqual(program.body[3].cases[0].consequent[0], {
    type: "JSXExpressionContainer",
    start: 0,
    end: 0,
    expression: {
      type: "Identifier",
      name: "view",
      start: 0,
      end: 0,
      loc: {
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 },
      },
    },
    loc: {
      start: { line: 1, column: 0 },
      end: { line: 1, column: 0 },
    },
  });
});

test("an Unexpected-token rejection retries unquoted TSRX submodule sources exactly once", () => {
  const source =
    "module server { export const value = 1; }; import { value } from server; export { value } from server;";
  const firstIdentifierStart = source.indexOf("server;", source.indexOf("import"));
  const secondIdentifierStart = source.indexOf("server;", firstIdentifierStart + 1);
  const calls = [];
  const api = createTsrxCoreCompat({
    parseSync(filename, observedSource, options) {
      calls.push({ filename, source: observedSource, options });
      if (calls.length === 1) {
        return {
          program: null,
          comments: [],
          errors: [
            {
              severity: "Error",
              message: "Unexpected token",
              labels: [
                { start: firstIdentifierStart, end: firstIdentifierStart + "server".length },
              ],
            },
          ],
        };
      }

      assert.equal(observedSource.length, source.length);
      assert.doesNotMatch(observedSource, /from\s+server/u);
      const placeholderSpans = [...observedSource.matchAll(/from(?<literal>"[^"]*")/gu)].map(
        (match) => ({
          start: match.index + "from".length,
          end: match.index + "from".length + match.groups.literal.length,
          raw: match.groups.literal,
        }),
      );
      assert.equal(placeholderSpans.length, 2);
      return {
        errors: [],
        comments: [],
        program: {
          type: "Program",
          start: 0,
          end: source.length,
          sourceType: "module",
          hashbang: null,
          body: [
            { type: "TSModuleDeclaration", start: 0, end: 43 },
            {
              type: "ImportDeclaration",
              start: 45,
              end: 73,
              source: {
                type: "Literal",
                value: "placeholder",
                raw: placeholderSpans[0].raw,
                start: placeholderSpans[0].start,
                end: placeholderSpans[0].end,
              },
            },
            {
              type: "ExportNamedDeclaration",
              start: 74,
              end: source.length,
              source: {
                type: "Literal",
                value: "placeholder",
                raw: placeholderSpans[1].raw,
                start: placeholderSpans[1].start,
                end: placeholderSpans[1].end,
              },
            },
          ],
        },
      };
    },
  });

  const program = api.parseModule(source, "src/submodule.tsrx");

  assert.equal(calls.length, 2);
  assert.equal(program.body[0].type, "TSModuleDeclaration");
  assert.deepEqual(program.body[1].source, {
    type: "Identifier",
    name: "server",
    start: firstIdentifierStart,
    end: firstIdentifierStart + "server".length,
    loc: {
      start: { line: 1, column: firstIdentifierStart },
      end: { line: 1, column: firstIdentifierStart + "server".length },
    },
  });
  assert.deepEqual(program.body[2].source, {
    type: "Identifier",
    name: "server",
    start: secondIdentifierStart,
    end: secondIdentifierStart + "server".length,
    loc: {
      start: { line: 1, column: secondIdentifierStart },
      end: { line: 1, column: secondIdentifierStart + "server".length },
    },
  });
});

test("TSRX compatibility materializes directive origins and the full scoped CSS tree", () => {
  const source = [
    "@if(a){x}@else{y}",
    "@for(const x of xs){x}@empty{y}",
    "@switch(x){@case 1:{x}@default:{y}}",
    "@try{x}@pending{y}@catch(error){z}",
    "<style scoped>.a,.b { color: red; }</style>",
  ].join("\n");
  const span = (text, from = 0) => {
    const start = source.indexOf(text, from);
    return { start, end: start + text.length };
  };
  const elseSpan = span("@else");
  const emptySpan = span("@empty");
  const caseSpan = span("@case");
  const defaultSpan = span("@default");
  const pendingSpan = span("@pending");
  const catchSpan = span("@catch");
  const styleSpan = span("<style scoped>.a,.b { color: red; }</style>");
  const css = ".a,.b { color: red; }";
  const program = {
    type: "Program",
    start: 0,
    end: source.length,
    sourceType: "module",
    hashbang: null,
    body: [
      {
        type: "JSXIfExpression",
        start: 0,
        end: source.indexOf("\n"),
        consequent: { type: "BlockStatement", start: 6, end: elseSpan.start, body: [] },
        alternate: {
          type: "BlockStatement",
          start: elseSpan.end,
          end: source.indexOf("\n"),
          body: [],
        },
      },
      {
        type: "JSXForExpression",
        start: source.indexOf("@for"),
        end: source.indexOf("\n", source.indexOf("@for")),
        body: { type: "BlockStatement", start: source.indexOf("{x}"), end: emptySpan.start, body: [] },
        empty: { type: "BlockStatement", start: emptySpan.end, end: emptySpan.end + 3, body: [] },
      },
      {
        type: "JSXSwitchExpression",
        start: source.indexOf("@switch"),
        end: source.indexOf("\n", source.indexOf("@switch")),
        cases: [
          { type: "SwitchCase", ...caseSpan, test: { type: "Literal", ...span("1", caseSpan.end), value: 1 }, consequent: [] },
          { type: "SwitchCase", ...defaultSpan, test: null, consequent: [] },
        ],
      },
      {
        type: "JSXTryExpression",
        start: source.indexOf("@try"),
        end: source.indexOf("\n", source.indexOf("@try")),
        block: { type: "BlockStatement", start: source.indexOf("{x}", source.indexOf("@try")), end: pendingSpan.start, body: [] },
        pending: { type: "BlockStatement", start: pendingSpan.end, end: catchSpan.start, body: [] },
        handler: { type: "CatchClause", start: catchSpan.start, end: source.indexOf("\n", source.indexOf("@try")), body: { type: "BlockStatement", start: catchSpan.end, end: source.indexOf("\n", source.indexOf("@try")), body: [] } },
      },
      {
        type: "JSXStyleElement",
        ...styleSpan,
        css,
        metadata: { path: [] },
        openingElement: { type: "JSXOpeningElement", start: styleSpan.start, end: styleSpan.start + "<style scoped>".length },
        children: [{ type: "StyleSheet", source: css, start: 0, end: css.length, children: [] }],
      },
    ],
  };
  const api = createTsrxCoreCompat({
    parseSync() {
      return program;
    },
  });

  api.parseModule(source, "src/Origins.tsrx");

  assert.deepEqual(program.body[0].alternateKeyword, {
    ...elseSpan,
    loc: { start: { line: 1, column: elseSpan.start }, end: { line: 1, column: elseSpan.end } },
  });
  assert.deepEqual([program.body[1].emptyKeyword.start, program.body[1].emptyKeyword.end], [emptySpan.start, emptySpan.end]);
  assert.deepEqual(program.body[2].cases.map((node) => [node.keyword.start, node.keyword.end]), [
    [caseSpan.start, caseSpan.end],
    [defaultSpan.start, defaultSpan.end],
  ]);
  assert.deepEqual([program.body[3].pendingKeyword.start, program.body[3].pendingKeyword.end], [pendingSpan.start, pendingSpan.end]);
  assert.deepEqual([program.body[3].handlerKeyword.start, program.body[3].handlerKeyword.end], [catchSpan.start, catchSpan.end]);

  const style = program.body[4];
  const sheet = style.children[0];
  assert.match(sheet.hash, /^tsrx-[0-9a-f]{8}$/u);
  assert.equal(style.metadata.styleScopeHash, sheet.hash);
  assert.deepEqual(sheet.children[0].prelude.children.map((selector) => selector.children[0].selectors[0].name), ["a", "b"]);
  assert.deepEqual(sheet.children[0].block.children[0], {
    type: "Declaration",
    start: 8,
    end: 18,
    property: "color",
    value: "red",
  });
  assert.deepEqual(program.loc.end, { line: 5, column: styleSpan.end - styleSpan.start });
});

test("parseModule preserves an explicit filename and appends compatible comments", () => {
  const program = makeProgram();
  const comments = [];
  const api = createTsrxCoreCompat({
    parseSync(filename) {
      assert.equal(filename, "src/View.tsrx");
      return {
        program,
        errors: [],
        comments: [{ type: "Line", value: " hello", start: 0, end: 8 }],
      };
    },
  });

  assert.equal(
    api.parseModule("// hello\nconst x = 1", "src/View.tsrx", { comments }),
    program,
  );
  assert.deepEqual(comments, [
    {
      type: "Line",
      value: " hello",
      start: 0,
      end: 8,
      loc: {
        start: { line: 1, column: 0 },
        end: { line: 1, column: 8 },
      },
      context: null,
    },
  ]);
});

test("strict parsing throws the first returned diagnostic as a SyntaxError-like CompileError", () => {
  const api = createTsrxCoreCompat({
    parseSync() {
      return { program: makeProgram(), comments: [], errors: [makeNativeError()] };
    },
  });

  assert.throws(
    () => api.parseModule("const value = ;", "src/Broken.tsrx"),
    (error) => {
      assert.equal(error.name, "SyntaxError");
      assert.equal(error.message, "Unexpected token");
      assert.equal(error.code, undefined);
      assert.equal(error.pos, 13);
      assert.equal(error.raisedAt, 14);
      assert.equal(error.end, 14);
      assert.equal(error.fileName, "src/Broken.tsrx");
      assert.equal(error.type, "fatal");
      assert.deepEqual(error.loc, {
        start: { line: 1, column: 13 },
        end: { line: 1, column: 14 },
      });
      return true;
    },
  );
});

test("a stray greater-than diagnostic anchors on the extra token like @tsrx/core", () => {
  const source = "export function Controls() @{ <button>Save</button>> }";
  const closingBrace = source.lastIndexOf("}");
  const extraGreaterThan = source.indexOf("</button>>") + "</button>".length;
  const api = createTsrxCoreCompat({
    parseSync() {
      return {
        program: null,
        comments: [],
        errors: [
          {
            severity: "Error",
            message: "Unexpected token",
            labels: [{ start: closingBrace, end: closingBrace + 1 }],
          },
        ],
      };
    },
  });

  assert.throws(
    () => api.parseModule(source, "src/Controls.tsrx"),
    (error) => {
      assert.equal(error.pos, extraGreaterThan);
      assert.equal(error.raisedAt, extraGreaterThan + 1);
      assert.deepEqual(error.loc, {
        start: { line: 1, column: extraGreaterThan },
        end: { line: 1, column: extraGreaterThan + 1 },
      });
      return true;
    },
  );
});

test("dynamic-tag call diagnostics use @tsrx/core 0.1.32's user-facing message", () => {
  const candidateMessage =
    "TSRX dynamic tag 0 at source byte 56 must be an identifier, member, static string, or runtime expression without calls, construction, spreads, concatenation, interpolation, objects, or arrays";
  const referenceMessage =
    "Dynamic element names must be an identifier, member expression, static string, or runtime expression; calls, spreads, string concatenation, string interpolation, and static null, undefined, boolean, number, object, and array literals are not valid tag names.";
  const api = createTsrxCoreCompat({
    parseSync() {
      return {
        program: null,
        comments: [],
        errors: [makeNativeError(candidateMessage)],
      };
    },
  });

  assert.throws(
    () => api.parseModule("export function App() @{ <{tag()}/> }", "DynamicTagCall.tsrx"),
    (error) => error instanceof SyntaxError && error.message === referenceMessage,
  );
});

for (const mode of ["collect", "loose"]) {
  test(`${mode} mode appends returned diagnostics and returns an available program`, () => {
    const program = makeProgram();
    const errors = [];
    const api = createTsrxCoreCompat({
      parseSync() {
        return { program, comments: [], errors: [makeNativeError("Recoverable syntax error")] };
      },
    });

    const result = api.parseModule("const value = ;", "src/Broken.tsrx", {
      [mode]: true,
      errors,
    });

    assert.equal(result, program);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "SyntaxError");
    assert.equal(errors[0].message, "Recoverable syntax error");
    assert.equal(errors[0].type, "usage");
    assert.equal(errors[0].fileName, "src/Broken.tsrx");
  });
}

test("a missing native program is never exposed as a successful parse", () => {
  const errors = [];
  const api = createTsrxCoreCompat({
    parseSync() {
      return { program: null, comments: [], errors: [makeNativeError()] };
    },
  });

  assert.throws(
    () => api.parseModule("const value = ;", "src/Broken.tsrx", { collect: true, errors }),
    (error) => error instanceof SyntaxError && error.type === "fatal",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, "usage");
});

test("operational parser failures retain their identity", () => {
  const operational = Object.assign(new Error("native package is not installed"), {
    name: "ParserOperationalError",
    code: "ERR_TSRX_NATIVE_NOT_INSTALLED",
  });
  const api = createTsrxCoreCompat({
    parseSync() {
      throw operational;
    },
  });

  assert.throws(() => api.parseModule("export {}"), (error) => error === operational);
});

test("event helpers match @tsrx/core 0.1.32 edge behavior", () => {
  const api = createTsrxCoreCompat({ parseSync() {} });

  for (const name of ["onClick", "onA", "on-click", "on_click", "on$", "on1click"]) {
    assert.equal(api.isEventAttribute(name), true, name);
  }
  for (const name of ["", "on", "onclick", "class", "ONClick"]) {
    assert.equal(api.isEventAttribute(name), false, name);
  }

  assert.deepEqual(
    Object.fromEntries(
      [
        "onClick",
        "onClickCapture",
        "onCapture",
        "onClickcapture",
        "onGotPointerCapture",
        "onLostPointerCapture",
        "onGOTPOINTERCAPTURE",
        "onLOSTPOINTERCAPTURE",
        "onFooCaptureCapture",
      ].map((name) => [name, api.normalizeEventName(name)]),
    ),
    {
      onClick: "click",
      onClickCapture: "click",
      onCapture: "",
      onClickcapture: "clickcapture",
      onGotPointerCapture: "gotpointercapture",
      onLostPointerCapture: "lostpointercapture",
      onGOTPOINTERCAPTURE: "gotpointercapture",
      onLOSTPOINTERCAPTURE: "lostpointercapture",
      onFooCaptureCapture: "foocapture",
    },
  );
});

test("the package is a publishable, dependency-light compatibility facade", async () => {
  const manifestUrl = new URL("../../packages/tsrx-core-compat/package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.equal(manifest.name, "@tsrx/oxc-core-compat");
  assert.equal(manifest.version, "0.8.0");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.sideEffects, false);
  assert.equal(manifest.dependencies["@tsrx/oxc"], "0.8.0");
  assert.equal(manifest.dependencies["@tsrx/core"], undefined);
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    ".",
    "./package.json",
    "./types",
    "./types/estree",
  ]);
});
