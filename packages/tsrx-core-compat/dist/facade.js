import { parse_style } from "./style.js";
//#region src/facade.ts
const PARSER_OPTIONS = Object.freeze({
	lang: "tsrx",
	sourceType: "module",
	astType: "ts",
	preserveParens: true
});
const TSRX_CORE_COMPAT_EAGER = Symbol.for("@oxc-tsrx/parser/tsrx-core-compat-eager");
const TSRX_CORE_COMPAT_DEFAULTS_STRIPPED = Symbol.for("@oxc-tsrx/parser/tsrx-core-compat-defaults-stripped");
const EAGER_PARSER_OPTIONS = Object.freeze(Object.defineProperty({ ...PARSER_OPTIONS }, TSRX_CORE_COMPAT_EAGER, { value: true }));
const EMPTY_ERRORS = Object.freeze([]);
function parserResultProgram(result) {
	return result?.type === "Program" ? result : result?.program ?? null;
}
function parserResultErrors(result) {
	return result?.type === "Program" ? EMPTY_ERRORS : result?.errors ?? EMPTY_ERRORS;
}
function tsrxFailure(parser, filename, source, eagerTsrx) {
	const options = eagerTsrx ? EAGER_PARSER_OPTIONS : PARSER_OPTIONS;
	let result;
	try {
		result = parser.parseSync(filename, source, options);
	} catch (error) {
		return isSyntaxErrorLike(error) && !isOperationalError(error) ? { error } : null;
	}
	return parserResultProgram(result) === null ? {
		result,
		options
	} : null;
}
function tsrxRetry(parser, filename, source, eagerTsrx) {
	const options = eagerTsrx ? EAGER_PARSER_OPTIONS : PARSER_OPTIONS;
	const result = parser.parseSync(filename, source, options);
	if (parserResultProgram(result) === null || parserResultErrors(result).length > 0) return null;
	if (!source.includes("@{") && !acceptsWithoutTsrxText(parser, filename, source, result)) return null;
	return {
		result,
		options
	};
}
function acceptsWithoutTsrxText(parser, filename, source, result) {
	const masked = source.split("");
	const stack = [parserResultProgram(result)];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node?.type === "JSXEmptyExpression" && /^\/[/*]/u.test(source.slice(node.start, node.end))) {
			for (let index = node.start; index < node.end; index += 1) if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
		}
		const script = node?.type === "JSXElement" && node.openingElement?.name?.name === "script" && node.closingElement != null && node.children?.length === 0;
		const text = node?.type === "JSXText" && typeof node.raw === "string" && node.raw.includes(">") ? [node.start, node.end] : script ? [node.openingElement.end, node.closingElement.start] : null;
		if (text !== null) {
			for (let index = text[0]; index < text[1]; index += 1) if (masked[index] === ">") masked[index] = " ";
		}
		if (node?.type === "JSXAttribute" && node.shorthand === true) {
			for (let index = node.start; index < node.end; index += 1) if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
		}
		for (const key in node) if (key !== "parent" && node[key] !== null && typeof node[key] === "object") stack.push(node[key]);
	}
	try {
		const check = parser.parseSync(filename, masked.join(""), TYPESCRIPT_REACT_PARSER_OPTIONS);
		return parserResultProgram(check) !== null && parserResultErrors(check).length === 0;
	} catch {
		return false;
	}
}
function ordinaryParserOptions(lang) {
	return Object.freeze({
		lang,
		sourceType: "module",
		astType: "js",
		preserveParens: false,
		showSemanticErrors: true
	});
}
const TYPESCRIPT_PARSER_OPTIONS = ordinaryParserOptions("ts");
const TYPESCRIPT_REACT_PARSER_OPTIONS = Object.freeze({
	...ordinaryParserOptions("tsx"),
	astType: "ts"
});
const TYPESCRIPT_DEFINITION_PARSER_OPTIONS = ordinaryParserOptions("dts");
const PRESERVED_PARENS_PARSER_OPTIONS = new Map([
	TYPESCRIPT_PARSER_OPTIONS,
	TYPESCRIPT_REACT_PARSER_OPTIONS,
	TYPESCRIPT_DEFINITION_PARSER_OPTIONS
].map((options) => [options, Object.freeze({
	...options,
	preserveParens: true
})]));
function nativeParserOptions(options, preserveParens) {
	return preserveParens ? PRESERVED_PARENS_PARSER_OPTIONS.get(options) ?? options : options;
}
function parserOptions(filename, eagerTsrx = false) {
	let pathname = filename;
	const query = pathname.indexOf("?");
	const hash = pathname.indexOf("#");
	const suffix = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash);
	if (suffix !== -1) pathname = pathname.slice(0, suffix);
	if (pathname.endsWith(".tsrx")) return eagerTsrx ? EAGER_PARSER_OPTIONS : PARSER_OPTIONS;
	if (pathname.endsWith(".d.ts") || pathname.endsWith(".d.mts") || pathname.endsWith(".d.cts")) return TYPESCRIPT_DEFINITION_PARSER_OPTIONS;
	if (pathname.endsWith(".tsx")) return TYPESCRIPT_REACT_PARSER_OPTIONS;
	if (pathname.endsWith(".object.ts")) return TYPESCRIPT_REACT_PARSER_OPTIONS;
	if (pathname.endsWith(".ts") || pathname.endsWith(".mts") || pathname.endsWith(".cts")) return TYPESCRIPT_PARSER_OPTIONS;
	if (pathname.endsWith(".jsx")) return TYPESCRIPT_REACT_PARSER_OPTIONS;
	if (pathname.endsWith(".js") || pathname.endsWith(".mjs") || pathname.endsWith(".cjs")) return TYPESCRIPT_PARSER_OPTIONS;
	return eagerTsrx ? EAGER_PARSER_OPTIONS : PARSER_OPTIONS;
}
const DYNAMIC_TAG_REFERENCE_MESSAGE = "A dynamic tag expression must be an identifier, a member access such as `props.as` or `registry[name]`, or a string literal. Compute anything else before the element: `const Tag = c ? Child : Fallback;`, then `<{Tag} />`.";
const DYNAMIC_TAG_NOT_EXPRESSION_MESSAGE = /^malformed TSRX at byte \d+: expected a valid dynamic JSX tag expression$/u;
const UNCLOSED_TAG_MESSAGE = /^Unclosed tag '<[^'\r\n]*>'\. Expected '<\/[^'\r\n]*>' before end of template\.$/u;
const OXC_CODE = /^\s*\S+ TS\((\d+)\): /u;
const MESSAGE_CODES = [
	[/^Unclosed tag |^unterminated JSX element /u, "TSRX1001"],
	[/: expected a (?:matching (?:dynamic )?JSX closing tag|fragment closing tag `<\/>`)$/u, "TSRX1002"],
	[/: expected a braced control-flow body$/u, "TSRX1008"],
	[/: expected `@(?:else|empty|pending|catch)`$/u, "TSRX1009"],
	[/: expected an `@pending` or `@catch` clause$/u, "TSRX1010"],
	[/: expected (?:an identifier after `index`|one `index` annotation before `key`)$/u, "TSRX1011"],
	[/^A code block renders a single node; /u, "TSRX2011"],
	[/^render expression precedes another statement$/u, "TSRX2012"],
	[/^A dynamic tag expression must be /u, "TSRX2014"],
	[/^(?:Identifier|type) '[^']+' has already been declared|^Argument name clash$/u, "TS2300"],
	[/^Export '[^']+' is not defined$/u, "TS2304"],
	[/^'(?:public|private|protected|readonly|override)' modifier cannot appear on a parameter\.$/u, "TS2369"],
	[/^'[^']+' expected\.$|^Expected `[^`]*` but found |^Expected a semicolon /u, "TS1005"],
	[/: expected `\}` after a shorthand attribute's name$/u, "TS1005"],
	[/: expected a shorthand attribute's name or a spread `\.\.\.`$/u, "TS1012"],
	[/: expected a JSX attribute, `>`, or `\/>`$/u, "TS1012"],
	[/: expected (?:a Unicode escape that spells an identifier character|`u` after `\\` in an identifier name)$/u, "TS1127"],
	[/: expected hexadecimal digits in a Unicode escape$/u, "TS1125"],
	[/: expected a Unicode escape no greater than 0x10FFFF$/u, "TS1198"],
	[/^Keywords cannot contain escape characters$/u, "TS1260"],
	[/: expected an operator or the end of the expression after a control-flow expression$/u, "TS1012"],
	[/^Unexpected token$/u, "TS1012"],
	[/^Unexpected token\. Did you mean `\{'\}'\}`/u, "TS1381"],
	[/^Unexpected token\. Did you mean `\{'>'\}`/u, "TS1382"],
	[/^Unterminated string$|^unterminated quoted string /u, "TS1002"],
	[/^Unterminated multiline comment$|^unterminated block comment /u, "TS1010"],
	[/^Unterminated regular expression$|^unterminated regular expression literal /u, "TS1161"],
	[/^unterminated template literal /u, "TS1160"],
	[/^Missing initializer in const declaration$|^Using declarations must have an initializer\.$/u, "TS1155"],
	[/^Missing initializer in destructuring declaration$/u, "TS1182"],
	[/^A rest parameter or binding pattern may not have a trailing comma\.$/u, "TS1013"],
	[/^A 'get' accessor must not have any formal parameters\.$/u, "TS1054"],
	[/^Invalid optional chain from new expression\.$/u, "TS1209"],
	[/^Logical expressions and coalesce expressions cannot be mixed$/u, "TS5076"],
	[/^Missing catch or finally clause$/u, "TS1472"],
	[/^Illegal newline after /u, "TS1142"],
	[/^Unexpected flag .+ in regular expression literal$/u, "TS1499"],
	[/^Flag .+ is mentioned twice in regular expression literal$/u, "TS1500"],
	[/^Invalid characters after number$/u, "TS1351"],
	[/^Only string literals are allowed as module attribute values\.$/u, "TS2858"],
	[/^`await` is only allowed within async functions and at the top levels of modules/u, "TS1308"],
	[/^'with' statements are not allowed$/u, "TS1101"],
	[/^Illegal break statement$/u, "TS1105"],
	[/^Illegal continue statement/u, "TS1104"],
	[/^'0'-prefixed octal literals /u, "TS1124"]
];
const IDENTIFIER_START = /[$_\p{ID_Start}]/u;
const IDENTIFIER_CONTINUE = /[$_\u200c\u200d\p{ID_Continue}]/u;
const WHITESPACE = /\s/u;
const SOURCE_DECLARATION_TYPES = /* @__PURE__ */ new Set([
	"ImportDeclaration",
	"ExportNamedDeclaration",
	"ExportAllDeclaration"
]);
const COMPLETION_PLACEHOLDER = "__markless_at__";
const RECOVERABLE_LOOSE_SHAPE_MESSAGE = "unsupported TSRX parser shape: failed TSRX result has no authored diagnostic";
const LOOSE_RENDER_ERRORS = /* @__PURE__ */ new Set([
	"Adjacent JSX elements must be wrapped in an enclosing tag.",
	"render expression precedes another statement",
	RECOVERABLE_LOOSE_SHAPE_MESSAGE
]);
function createRecoverySource(source) {
	return {
		text: source,
		boundaries: Array.from({ length: source.length + 1 }, (_value, index) => index)
	};
}
function replaceRecoveryRange(recovery, start, end, replacement) {
	const oldLength = end - start;
	const replacementBoundaries = [];
	if (replacement.length === oldLength) replacementBoundaries.push(...recovery.boundaries.slice(start, end + 1));
	else {
		const originalStart = recovery.boundaries[start];
		const originalEnd = recovery.boundaries[end];
		replacementBoundaries.push(originalStart);
		for (let index = 1; index < replacement.length; index += 1) replacementBoundaries.push(originalStart);
		replacementBoundaries.push(originalEnd);
	}
	recovery.text = recovery.text.slice(0, start) + replacement + recovery.text.slice(end);
	recovery.boundaries.splice(start, oldLength + 1, ...replacementBoundaries);
}
function applyRecoveryEdits(recovery, edits) {
	const ordered = [...edits].sort((left, right) => right.start - left.start);
	for (const edit of ordered) replaceRecoveryRange(recovery, edit.start, edit.end, edit.replacement);
}
function remapRecoveredTree(root, boundaries) {
	const seen = /* @__PURE__ */ new WeakSet();
	const stack = [root];
	while (stack.length > 0) {
		const value = stack.pop();
		if (value === null || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		if (value.type === "StyleSheet") continue;
		if (Number.isInteger(value.start)) value.start = boundaries[Math.max(0, Math.min(boundaries.length - 1, value.start))];
		if (Number.isInteger(value.end)) value.end = boundaries[Math.max(0, Math.min(boundaries.length - 1, value.end))];
		if (Array.isArray(value.range) && value.range.length === 2) {
			value.range[0] = boundaries[Math.max(0, Math.min(boundaries.length - 1, value.range[0]))];
			value.range[1] = boundaries[Math.max(0, Math.min(boundaries.length - 1, value.range[1]))];
		}
		for (const [key, child] of Object.entries(value)) {
			if (key === "parent" || key === "loc" || child === null || typeof child !== "object") continue;
			if (Array.isArray(child)) for (let index = child.length - 1; index >= 0; index -= 1) stack.push(child[index]);
			else stack.push(child);
		}
	}
}
function isOperationalError(error) {
	return error?.name === "ParserOperationalError" || typeof error?.code === "string" && error.code.startsWith("ERR_TSRX_");
}
function isRecoverableLooseShapeFailure(error) {
	return isOperationalError(error) && error?.code === "ERR_TSRX_INVALID_ARGUMENT" && error?.message === RECOVERABLE_LOOSE_SHAPE_MESSAGE;
}
function isSyntaxErrorLike(error) {
	return error instanceof SyntaxError || error?.name === "SyntaxError" || typeof error?.message === "string" && Array.isArray(error?.labels);
}
function positionLookup(source) {
	const lineStarts = [0];
	for (let index = 0; index < source.length; index += 1) {
		const code = source.charCodeAt(index);
		if (code === 13) {
			if (source.charCodeAt(index + 1) === 10) index += 1;
			lineStarts.push(index + 1);
		} else if (code === 10 || code === 8232 || code === 8233) lineStarts.push(index + 1);
	}
	return (rawOffset) => {
		const offset = Math.max(0, Math.min(source.length, Number.isInteger(rawOffset) ? rawOffset : 0));
		let low = 0;
		let high = lineStarts.length;
		while (low + 1 < high) {
			const middle = low + high >>> 1;
			if (lineStarts[middle] <= offset) low = middle;
			else high = middle;
		}
		return {
			line: low + 1,
			column: offset - lineStarts[low]
		};
	};
}
function primarySpan(error) {
	const label = Array.isArray(error?.labels) ? error.labels.find((candidate) => Number.isInteger(candidate?.start) && Number.isInteger(candidate?.end)) : void 0;
	const start = label?.start ?? (Number.isInteger(error?.pos) ? error.pos : void 0);
	return {
		start,
		end: label?.end ?? (Number.isInteger(error?.end) ? error.end : Number.isInteger(error?.raisedAt) ? error.raisedAt : start)
	};
}
function compatibleDiagnosticSpan(error, source) {
	const span = primarySpan(error);
	if (error?.message !== "Unexpected token" || typeof source !== "string" || !Number.isInteger(span.start)) return span;
	let extra = Math.min(span.start - 1, source.length - 1);
	while (extra >= 0 && WHITESPACE.test(source[extra])) extra -= 1;
	if (source[extra] !== ">" || source[extra - 1] !== ">") return span;
	const closingStart = source.lastIndexOf("</", extra - 1);
	if (closingStart === -1 || source.lastIndexOf("<", extra - 1) !== closingStart) return span;
	const closingName = source.slice(closingStart + 2, extra - 1);
	if (!/^(?:[A-Za-z_$][\w.$:-]*|\{[^{}\r\n]*\})?$/u.test(closingName)) return span;
	return {
		start: extra,
		end: extra + 1
	};
}
function compatibleDiagnosticMessage(error) {
	return typeof error?.message === "string" ? error.message : String(error);
}
function isDynamicTagNotExpression(error) {
	return typeof error?.message === "string" && DYNAMIC_TAG_NOT_EXPRESSION_MESSAGE.test(error.message);
}
function dynamicTagNotExpressionError(error, positionAt) {
	const { start, end } = primarySpan(error);
	return acornRaise(DYNAMIC_TAG_REFERENCE_MESSAGE, start, positionAt, end);
}
function isUnclosedTag(error) {
	return typeof error?.message === "string" && UNCLOSED_TAG_MESSAGE.test(error.message);
}
function acornRaise(message, start, positionAt, raisedAt = start, code = compatibleDiagnosticCode(null, message)) {
	const loc = positionAt(start);
	const raised = /* @__PURE__ */ new SyntaxError(`${message} (${loc.line}:${loc.column})`);
	raised.code = code;
	raised.pos = start;
	raised.loc = loc;
	raised.raisedAt = raisedAt;
	return raised;
}
function unclosedTagFailure(error, collecting, positionAt, source) {
	if (collecting && typeof source === "string") return acornRaise("'}' expected.", source.length, positionAt);
	return unclosedTagRaise(error, positionAt);
}
function unclosedTagRaise(error, positionAt) {
	const { start = 0, end } = primarySpan(error);
	return acornRaise(error.message, start, positionAt, Math.max(end ?? start, start + 1));
}
function compatibleDiagnosticCode(error, message) {
	if (typeof error?.code === "string") return error.code;
	const code = MESSAGE_CODES.find(([pattern]) => pattern.test(message))?.[1];
	const oxc = OXC_CODE.exec(error?.codeframe ?? "");
	return code ?? (oxc === null ? void 0 : `TS${oxc[1]}`);
}
const CORE_ERROR_CODES = /* @__PURE__ */ new Set([
	"TSRX1004",
	"TSRX1007",
	"TSRX2001",
	"TSRX2011",
	"TSRX2012",
	"TSRX2014"
]);
const CORE_ERROR_MESSAGE = /^(?:Identifier|type) '[^']+' has already been declared|^Argument name clash$|^Cannot redeclare /u;
function isCoreReportedError(diagnostic) {
	return CORE_ERROR_CODES.has(diagnostic.code) || CORE_ERROR_MESSAGE.test(diagnostic.message);
}
const UNEXPECTED_TOKEN = "Unexpected token";
const DIRECTIVE_BODY_EXPECTED = "Expected `{` after JSX control-flow directive.";
const TRY_HANDLER_MISSING = "Missing `@catch` or `@pending` after `@try` block.";
const LEADING_DECORATORS = "Leading decorators must be attached to a class declaration.";
const BRANCH_DIRECTIVES = {
	else: "if",
	empty: "for",
	catch: "try",
	pending: "try"
};
const ACORN_KEYWORDS = new Set("break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this const class extends export import super".split(" "));
const EXPECTED_PAREN = /^malformed TSRX at byte \d+: expected `\(`$/u;
const EXPECTED_BRACED_BODY = /^malformed TSRX at byte \d+: expected a braced control-flow body$/u;
const EXPECTED_BRANCH = /^malformed TSRX at byte \d+: expected `@(else|empty|pending|catch)`$/u;
const EXPECTED_TRY_HANDLER = /^malformed TSRX at byte \d+: expected an `@pending` or `@catch` clause$/u;
const EXPECTED_OWNING_CONTROL = /^malformed TSRX at byte \d+: expected an owning TSRX control$/u;
const RESERVED_WORD = /^Identifier expected\. '([^']+)' is a reserved word that cannot be used here\.$/u;
const STRICT_RESERVED_WORDS = new Set("implements interface let package private protected public static yield".split(" "));
const RENDER_BEFORE_STATEMENT = "render expression precedes another statement";
const STATEMENT_AFTER_OUTPUT = "Code must be at the top of '@{ }'; statements cannot follow the rendered output.";
const CLASS_HEAD = /^\s*(?:[A-Za-z_$][\w$]*)?\s*(?:<[\s\S]*>)?\s*(?:(?:extends|implements)\b[\s\S]*)?$/u;
const SHORTHAND_BRACE_EXPECTED = /^malformed TSRX at byte \d+: expected `\}` after a shorthand attribute's name$/u;
const UNTERMINATED_ELEMENT = /^unterminated JSX element starting at byte \d+$/u;
const MALFORMED_UNEXPECTED_TOKEN = /^malformed TSRX at byte \d+: expected (?:an `@case`, `@default`, or closing `\}`|`:` after an `@case` expression|an annotation value|a shorthand attribute's name or a spread `\.\.\.`|a JSX attribute, `>`, or `\/>`|an operator or the end of the expression after a control-flow expression)$/u;
function skipTriviaBefore(source, offset) {
	let index = offset;
	for (;;) {
		const before = index;
		let lineStart = index;
		while (lineStart > 0 && !/[\n\r\u2028\u2029]/u.test(source[lineStart - 1])) lineStart -= 1;
		const lineComment = source.indexOf("//", lineStart);
		if (lineComment !== -1 && lineComment < index) index = lineComment;
		while (index > 0 && WHITESPACE.test(source[index - 1])) index -= 1;
		if (source[index - 1] === "/" && source[index - 2] === "*") {
			const open = source.lastIndexOf("/*", index - 3);
			if (open !== -1) index = open;
		}
		if (index === before) return index;
	}
}
function directiveBefore(source, offset) {
	let index = offset;
	const skipSpace = () => {
		index = skipTriviaBefore(source, index);
	};
	skipSpace();
	if (source[index - 1] === ")") {
		let depth = 0;
		let open = -1;
		for (let cursor = index - 1; cursor >= 0; cursor -= 1) if (source[cursor] === ")") depth += 1;
		else if (source[cursor] === "(" && --depth === 0) {
			open = cursor;
			break;
		}
		if (open === -1) return void 0;
		index = open;
		skipSpace();
	}
	const end = index;
	while (index > 0 && /[a-z]/u.test(source[index - 1])) index -= 1;
	if (index === end) return void 0;
	return {
		keyword: source.slice(index, end),
		start: index,
		at: source[index - 1] === "@"
	};
}
function decoratorBefore(source, offset) {
	let index = skipTriviaBefore(source, offset);
	if (source[index - 1] === ")") {
		let depth = 0;
		let cursor = index - 1;
		for (; cursor >= 0; cursor -= 1) if (source[cursor] === ")") depth += 1;
		else if (source[cursor] === "(" && --depth === 0) break;
		if (cursor < 0) return false;
		index = cursor;
	}
	const end = index;
	while (index > 0 && /[\w$.]/u.test(source[index - 1])) index -= 1;
	if (index === end) return false;
	const name = /^[A-Za-z_$][\w$]*/u.exec(source.slice(index, end))?.[0];
	while (index > 0 && WHITESPACE.test(source[index - 1])) index -= 1;
	if (source[index - 1] !== "@") return false;
	if (name === void 0 || ACORN_KEYWORDS.has(name) || Object.hasOwn(BRANCH_DIRECTIVES, name)) return false;
	const before = index - 2;
	if (before >= 0 && !/[\s{};]/u.test(source[before])) return false;
	let depth = 0;
	for (let cursor = before; cursor >= 0; cursor -= 1) if (source[cursor] === "}") depth += 1;
	else if (source[cursor] === "{" && depth-- === 0) return !isClassBody(source, cursor);
	return true;
}
function blankCommentsAndStrings(text) {
	let blanked = "";
	let from = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		let end = -1;
		if (character === "\"" || character === "'") end = skipQuoted(text, index, character);
		else if (character === "`") end = skipTemplateLiteral(text, index);
		else if (character === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) end = skipComment(text, index);
		if (end === -1) continue;
		blanked += text.slice(from, index) + " ".repeat(end - index);
		from = end;
		index = end - 1;
	}
	return blanked + text.slice(from);
}
function isClassBody(source, open) {
	const head = blankCommentsAndStrings(source.slice(0, open));
	const keyword = [...head.matchAll(/(?<![\w$.\-=])class(?=[\s{])/gu)].at(-1);
	if (keyword === void 0) return false;
	const start = keyword.index + 5;
	if (!CLASS_HEAD.test(head.slice(start))) return false;
	let parens = 0;
	let angles = 0;
	for (let index = start; index < open; index += 1) {
		const character = head[index];
		if (character === "(" || character === "[") parens += 1;
		else if (character === ")" || character === "]") parens -= 1;
		else if (parens === 0 && character === "<") angles += 1;
		else if (parens === 0 && character === ">" && source[index - 1] !== "=") angles -= 1;
		else if (parens === 0 && angles === 0 && "{};".includes(character)) return false;
		if (parens < 0 || angles < 0) return false;
	}
	return parens === 0 && angles === 0;
}
function bareAtBefore(source, limit) {
	for (const at of bareAtOffsets(source)) {
		if (at >= limit) return void 0;
		const open = skipTriviaBefore(source, at) - 1;
		if (source[open] !== "{") continue;
		if (source[open - 1] !== "@" && !directiveBefore(source, open)?.at) continue;
		let next = at + 1;
		while (next < source.length) if (WHITESPACE.test(source[next])) next += 1;
		else if (source[next] === "/" && (source[next + 1] === "/" || source[next + 1] === "*")) next = skipComment(source, next);
		else break;
		if (next > limit) return void 0;
		const word = readIdentifier(source, next);
		if (word !== null && !ACORN_KEYWORDS.has(word.name)) return void 0;
		return next;
	}
}
function tokenEndAfter(source, offset) {
	let index = offset;
	while (index < source.length) if (WHITESPACE.test(source[index])) index += 1;
	else if (source[index] === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) index = skipComment(source, index);
	else break;
	return readIdentifier(source, index)?.end ?? Math.min(index + 1, source.length);
}
function skipTemplateLiteral(source, start) {
	let index = start + 1;
	while (index < source.length) {
		const character = source[index];
		if (character === "\\") index += 2;
		else if (character === "`") return index + 1;
		else if (character === "$" && source[index + 1] === "{") index = skipSubstitution(source, index + 2);
		else index += 1;
	}
	return source.length;
}
function skipSubstitution(source, start) {
	let depth = 0;
	let index = start;
	while (index < source.length) {
		const character = source[index];
		if (character === "\"" || character === "'") index = skipQuoted(source, index, character);
		else if (character === "`") index = skipTemplateLiteral(source, index);
		else if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) index = skipComment(source, index);
		else {
			if (character === "{") depth += 1;
			else if (character === "}" && depth-- === 0) return index + 1;
			index += 1;
		}
	}
	return source.length;
}
function templateEnd(source, start) {
	let depth = 0;
	let inTag = false;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
			index = skipComment(source, index) - 1;
			continue;
		}
		if ((depth > 0 || inTag) && (character === "\"" || character === "'")) {
			index = skipQuoted(source, index, character) - 1;
			continue;
		}
		if ((depth > 0 || inTag) && character === "`") {
			index = skipTemplateLiteral(source, index) - 1;
			continue;
		}
		if (character === "{") depth += 1;
		else if (character === "}") {
			if (depth === 0) return index;
			depth -= 1;
		} else if (depth === 0 && character === "<") inTag = true;
		else if (depth === 0 && character === ">") inTag = false;
	}
	return -1;
}
function coreDiagnostic(error, source) {
	const message = compatibleDiagnosticMessage(error);
	const { start, end } = compatibleDiagnosticSpan(error, source);
	const reported = {
		message,
		code: compatibleDiagnosticCode(error, message),
		start,
		end,
		raisedAt: void 0
	};
	if (message === RENDER_BEFORE_STATEMENT) return {
		...reported,
		message: STATEMENT_AFTER_OUTPUT
	};
	if (typeof source !== "string" || !Number.isInteger(start)) return reported;
	const unexpected = (code = "TS1012", message = UNEXPECTED_TOKEN) => ({
		...reported,
		code,
		message
	});
	const keyword = (directive) => ({
		...reported,
		code: "TS1359",
		message: `Unexpected keyword '${directive.keyword}'`,
		start: directive.start,
		raisedAt: tokenEndAfter(source, directive.start + directive.keyword.length)
	});
	const bare = bareAtBefore(source, start);
	if (bare !== void 0) {
		const word = readIdentifier(source, bare);
		if (word !== null) return {
			...keyword({
				keyword: word.name,
				start: bare
			}),
			end: word.end
		};
		return {
			...unexpected(),
			start: bare,
			end: bare + 1
		};
	}
	if (EXPECTED_PAREN.test(message)) {
		const directive = directiveBefore(source, start);
		if (directive?.at && [
			"if",
			"for",
			"switch",
			"while"
		].includes(directive.keyword)) return keyword(directive);
		return unexpected();
	}
	if (EXPECTED_BRACED_BODY.test(message)) {
		const directive = directiveBefore(source, start);
		if (directive?.at && directive.keyword === "try") return keyword(directive);
		if (directive?.at && (directive.keyword === "catch" || directive.keyword === "pending")) return unexpected();
		return unexpected("TSRX1008", DIRECTIVE_BODY_EXPECTED);
	}
	const branch = EXPECTED_BRANCH.exec(message)?.[1];
	if (branch !== void 0) return {
		...unexpected("TSRX1009", `Expected \`@${branch}\` after \`@${BRANCH_DIRECTIVES[branch]}\` block.`),
		raisedAt: start + branch.length
	};
	if (EXPECTED_TRY_HANDLER.test(message)) {
		const handler = unexpected("TSRX1010", TRY_HANDLER_MISSING);
		if (source[start] !== "@") return handler;
		return {
			...handler,
			start: start + 1,
			end: Math.max(end ?? start, start + 2)
		};
	}
	if (EXPECTED_OWNING_CONTROL.test(message) && source[start] === "@") {
		const word = readIdentifier(source, start + 1);
		if (word !== null && ACORN_KEYWORDS.has(word.name)) return keyword({
			keyword: word.name,
			start: word.start
		});
	}
	if (MALFORMED_UNEXPECTED_TOKEN.test(message)) return unexpected();
	if (SHORTHAND_BRACE_EXPECTED.test(message)) return unexpected("TS1005", "'}' expected.");
	const reserved = RESERVED_WORD.exec(message)?.[1];
	if (reserved !== void 0) {
		if (!STRICT_RESERVED_WORDS.has(reserved)) return keyword({
			keyword: reserved,
			start
		});
		return unexpected("TS1212", `The keyword '${reserved}' is reserved`);
	}
	if (message === UNEXPECTED_TOKEN) {
		const word = readIdentifier(source, start);
		if (word !== null && source[start - 1] === "@" && ACORN_KEYWORDS.has(word.name)) return keyword({
			keyword: word.name,
			start
		});
		if (decoratorBefore(source, start)) return unexpected("TS1206", LEADING_DECORATORS);
	}
	if (UNTERMINATED_ELEMENT.test(message) && source[start] === "<") {
		const close = templateEnd(source, start);
		const name = /^[^\s/>{]*(?:\{[^{}]*\})?[^\s/>]*/u.exec(source.slice(start + 1))?.[0] ?? "";
		if (close !== -1) return {
			...reported,
			message: `Unclosed tag '<${name}>'. Expected '</${name}>' before end of template.`,
			start: close,
			end: close + 1
		};
	}
	return reported;
}
function coreThrownError(error, filename, positionAt, source) {
	const diagnostic = coreDiagnostic(error, source);
	if (isCoreReportedError(diagnostic)) return compileError(diagnostic, filename, positionAt, "fatal", Error);
	if (diagnostic.start === void 0) return compileError(diagnostic, filename, positionAt, "fatal", SyntaxError);
	return acornRaise(diagnostic.message, diagnostic.start, positionAt, diagnostic.raisedAt ?? Math.max(diagnostic.end ?? diagnostic.start, diagnostic.start), diagnostic.code);
}
function toCompileError(error, filename, positionAt, type, source) {
	return compileError(coreDiagnostic(error, source), filename, positionAt, type, SyntaxError);
}
function compileError({ message, code, start, end }, filename, positionAt, type, ErrorType) {
	const translated = new ErrorType(message);
	translated.code = code;
	translated.pos = start;
	translated.raisedAt = end;
	translated.end = end;
	translated.fileName = filename;
	translated.type = type;
	translated.loc = start === void 0 ? void 0 : {
		start: positionAt(start),
		end: positionAt(end ?? start)
	};
	return translated;
}
function codePointAt(source, index) {
	const value = source.codePointAt(index);
	return value === void 0 ? {
		character: "",
		width: 0
	} : {
		character: String.fromCodePoint(value),
		width: value > 65535 ? 2 : 1
	};
}
function readIdentifier(source, start) {
	let point = codePointAt(source, start);
	if (!IDENTIFIER_START.test(point.character)) return null;
	let end = start + point.width;
	while (end < source.length) {
		point = codePointAt(source, end);
		if (!IDENTIFIER_CONTINUE.test(point.character)) break;
		end += point.width;
	}
	return {
		start,
		end,
		name: source.slice(start, end)
	};
}
function skipQuoted(source, start, quote) {
	let index = start + 1;
	while (index < source.length) {
		const character = source[index];
		if (character === "\\") index += 2;
		else if (character === quote) return index + 1;
		else index += codePointAt(source, index).width || 1;
	}
	return source.length;
}
function skipComment(source, start) {
	if (source[start + 1] === "/") {
		const newline = source.indexOf("\n", start + 2);
		return newline === -1 ? source.length : newline + 1;
	}
	if (source[start + 1] === "*") {
		const close = source.indexOf("*/", start + 2);
		return close === -1 ? source.length : close + 2;
	}
	return start + 1;
}
function matchingBrace(source, open) {
	let depth = 1;
	for (let index = open + 1; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\"" || character === "'" || character === "`") {
			index = skipQuoted(source, index, character) - 1;
			continue;
		}
		if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
			index = skipComment(source, index) - 1;
			continue;
		}
		if (character === "{") depth += 1;
		else if (character === "}" && --depth === 0) return index;
	}
	return -1;
}
function codeBlockRanges(source) {
	const ranges = [];
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\"" || character === "'" || character === "`") {
			index = skipQuoted(source, index, character) - 1;
			continue;
		}
		if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
			index = skipComment(source, index) - 1;
			continue;
		}
		if (character !== "@" || source[index + 1] !== "{") continue;
		const close = matchingBrace(source, index + 1);
		if (close !== -1) ranges.push({
			start: index,
			open: index + 1,
			close,
			end: close + 1
		});
	}
	return ranges;
}
function bareAtOffsets(source) {
	const offsets = [];
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\"" || character === "'" || character === "`") {
			index = skipQuoted(source, index, character) - 1;
			continue;
		}
		if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
			index = skipComment(source, index) - 1;
			continue;
		}
		if (character !== "@") continue;
		const next = source[index + 1] ?? "";
		if (next !== "{" && !/[A-Za-z0-9_]/u.test(next)) offsets.push(index);
	}
	return offsets;
}
function incompleteConstructRecovery(source, blankExpressionLines = false) {
	const edits = [];
	const expressionLines = [];
	for (const offset of bareAtOffsets(source)) {
		const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
		const newline = source.indexOf("\n", offset);
		const lineEnd = newline === -1 ? source.length : newline;
		const lineBefore = source.slice(lineStart, offset);
		const trimmedBefore = source.slice(Math.max(0, offset - 96), offset).trimEnd();
		let replacement = " ";
		if (/@try\b/u.test(lineBefore)) replacement = "@pending {}";
		else if (/@switch\b/u.test(lineBefore)) replacement = "@default: {}";
		else if ("=+-*/%?:,(".includes(trimmedBefore.at(-1) ?? "")) {
			replacement = "0";
			expressionLines.push({
				start: lineStart,
				end: lineEnd
			});
		}
		edits.push({
			start: offset,
			end: offset + 1,
			replacement
		});
	}
	const recovery = createRecoverySource(source);
	if (blankExpressionLines && expressionLines.length > 0) {
		const merged = [];
		for (const line of expressionLines) if (!merged.some((candidate) => candidate.start === line.start && candidate.end === line.end)) merged.push(line);
		const retained = edits.filter((edit) => !merged.some((line) => line.start <= edit.start && edit.end <= line.end));
		retained.push(...merged.map((line) => ({
			...line,
			replacement: " ".repeat(line.end - line.start)
		})));
		applyRecoveryEdits(recovery, retained);
	} else applyRecoveryEdits(recovery, edits);
	blankStandaloneEmptyCodeBlocks(recovery);
	return {
		recovery,
		expressionLines
	};
}
function blankStandaloneEmptyCodeBlocks(recovery) {
	const ranges = codeBlockRanges(recovery.text);
	const edits = [];
	for (const range of ranges) {
		if (recovery.text.slice(range.open + 1, range.close).trim() !== "") continue;
		const nested = ranges.some((candidate) => candidate.start < range.start && range.end < candidate.end);
		const lineStart = recovery.text.lastIndexOf("\n", range.start - 1) + 1;
		const linePrefix = recovery.text.slice(lineStart, range.start).trim();
		if (!nested && linePrefix !== "") continue;
		edits.push({
			start: range.start,
			end: range.end,
			replacement: " ".repeat(range.end - range.start)
		});
	}
	applyRecoveryEdits(recovery, edits);
}
function outerCodeBlocks(ranges) {
	return ranges.filter((range) => !ranges.some((candidate) => candidate.start < range.start && range.end < candidate.end));
}
function nestingAt(source, start, end) {
	let braces = 0;
	let parentheses = 0;
	let brackets = 0;
	for (let index = start; index < end; index += 1) {
		const character = source[index];
		if (character === "\"" || character === "'" || character === "`") {
			index = skipQuoted(source, index, character) - 1;
			continue;
		}
		if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
			index = skipComment(source, index) - 1;
			continue;
		}
		if (character === "{") braces += 1;
		else if (character === "}") braces = Math.max(0, braces - 1);
		else if (character === "(") parentheses += 1;
		else if (character === ")") parentheses = Math.max(0, parentheses - 1);
		else if (character === "[") brackets += 1;
		else if (character === "]") brackets = Math.max(0, brackets - 1);
	}
	return {
		braces,
		parentheses,
		brackets
	};
}
function firstRenderStart(source, block, limit = block.close) {
	let braces = 0;
	let parentheses = 0;
	let brackets = 0;
	for (let index = block.open + 1; index < limit; index += 1) {
		const character = source[index];
		if (character === "\"" || character === "'" || character === "`") {
			index = skipQuoted(source, index, character) - 1;
			continue;
		}
		if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
			index = skipComment(source, index) - 1;
			continue;
		}
		if (character === "{") {
			braces += 1;
			continue;
		}
		if (character === "}") {
			braces = Math.max(0, braces - 1);
			continue;
		}
		if (character === "(") {
			parentheses += 1;
			continue;
		}
		if (character === ")") {
			parentheses = Math.max(0, parentheses - 1);
			continue;
		}
		if (character === "[") {
			brackets += 1;
			continue;
		}
		if (character === "]") {
			brackets = Math.max(0, brackets - 1);
			continue;
		}
		if (braces !== 0 || parentheses !== 0 || brackets !== 0) continue;
		if ([
			"@if",
			"@for",
			"@switch",
			"@try"
		].some((token) => source.startsWith(token, index))) return index;
		if (character !== "<" || !/[A-Za-z>{/]/u.test(source[index + 1] ?? "")) continue;
		let previous = index - 1;
		while (previous > block.open && /\s/u.test(source[previous])) previous -= 1;
		if (previous === block.open || ";{}".includes(source[previous])) return index;
	}
	return -1;
}
function isolateCompletionCandidate(recovery) {
	const placeholder = recovery.text.indexOf(COMPLETION_PLACEHOLDER);
	if (placeholder === -1) return;
	const ranges = outerCodeBlocks(codeBlockRanges(recovery.text));
	const target = ranges.find((range) => range.start < placeholder && placeholder < range.end);
	const edits = [];
	for (const range of ranges) {
		if (range === target) continue;
		edits.push({
			start: range.open + 1,
			end: range.close,
			replacement: " ".repeat(range.close - range.open - 1)
		});
	}
	if (target !== void 0) {
		const placeholderEnd = placeholder + 15;
		const lineStart = recovery.text.lastIndexOf("\n", placeholder - 1) + 1;
		const newline = recovery.text.indexOf("\n", placeholderEnd);
		const lineEnd = newline === -1 ? recovery.text.length : newline;
		const linePrefix = recovery.text.slice(lineStart, placeholder);
		if (/\b(?:const|let|var|return)\b/u.test(linePrefix) || "=+-*/%?:,(".includes(linePrefix.trimEnd().at(-1) ?? "")) {
			edits.push({
				start: target.open + 1,
				end: lineStart,
				replacement: " ".repeat(Math.max(0, lineStart - target.open - 1))
			});
			edits.push({
				start: lineEnd,
				end: target.close,
				replacement: " ".repeat(Math.max(0, target.close - lineEnd))
			});
		} else {
			const nesting = nestingAt(recovery.text, target.open + 1, placeholder);
			if (nesting.braces === 0 && nesting.parentheses === 0 && nesting.brackets === 0) edits.push({
				start: placeholderEnd,
				end: target.close,
				replacement: " ".repeat(target.close - placeholderEnd)
			});
			else {
				const switchStart = recovery.text.lastIndexOf("@switch", placeholder);
				if (switchStart > target.open) {
					const switchOpen = recovery.text.indexOf("{", switchStart + 7);
					const switchClose = switchOpen === -1 ? -1 : matchingBrace(recovery.text, switchOpen);
					if (switchOpen < placeholder && placeholder < switchClose) edits.push({
						start: switchClose + 1,
						end: target.close,
						replacement: " ".repeat(target.close - switchClose - 1)
					});
				}
			}
		}
	}
	applyRecoveryEdits(recovery, edits);
	blankStandaloneEmptyCodeBlocks(recovery);
}
function forwardOffset(offset, edits) {
	let delta = 0;
	for (const edit of edits) if (edit.start < offset) delta += edit.replacement.length - (edit.end - edit.start);
	return offset + delta;
}
function wrapRenderBlocks(recovery) {
	const ranges = outerCodeBlocks(codeBlockRanges(recovery.text));
	const wrappers = [];
	const edits = [];
	for (const block of ranges) {
		const first = firstRenderStart(recovery.text, block);
		if (first === -1) continue;
		const placeholder = recovery.text.indexOf(COMPLETION_PLACEHOLDER, first);
		if (placeholder !== -1 && placeholder < block.close) {
			const nesting = nestingAt(recovery.text, block.open + 1, placeholder);
			let previous = placeholder - 1;
			while (previous > block.open && /\s/u.test(recovery.text[previous])) previous -= 1;
			if (nesting.braces === 0 && nesting.parentheses === 0 && nesting.brackets === 0 && recovery.text[previous] !== "{") {
				edits.push({
					start: placeholder,
					end: placeholder,
					replacement: "{"
				});
				edits.push({
					start: placeholder + 15,
					end: placeholder + 15,
					replacement: "}"
				});
			}
		}
		edits.push({
			start: first,
			end: first,
			replacement: "<>"
		});
		edits.push({
			start: block.close,
			end: block.close,
			replacement: "</>"
		});
		wrappers.push({
			first,
			close: block.close
		});
	}
	if (wrappers.length === 0) return [];
	const fragments = wrappers.map((wrapper) => ({
		start: forwardOffset(wrapper.first, edits),
		end: forwardOffset(wrapper.close, edits) + 3
	}));
	applyRecoveryEdits(recovery, edits);
	return fragments;
}
function isRecoveryLayoutText(node) {
	if (node?.type !== "JSXText" || typeof node.value !== "string") return false;
	return node.value.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu, "").trim() === "";
}
function placeholderStatement(node) {
	if (node?.type !== "JSXExpressionContainer" || node.expression?.type !== "Identifier" || node.expression.name !== COMPLETION_PLACEHOLDER) return null;
	return {
		type: "ExpressionStatement",
		start: node.start,
		end: node.end,
		expression: node.expression
	};
}
function flattenSyntheticFragments(program, fragments) {
	const expected = new Set(fragments.map((fragment) => `${fragment.start}:${fragment.end}`));
	const seen = /* @__PURE__ */ new WeakSet();
	const stack = [program];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (node.type === "JSXCodeBlock" && node.render?.type === "JSXFragment" && expected.has(`${node.render.start}:${node.render.end}`)) {
			const converted = (node.render.children ?? []).filter((child) => !isRecoveryLayoutText(child)).map((child) => placeholderStatement(child) ?? child);
			const last = converted.at(-1);
			if (last?.type === "ExpressionStatement" && last.expression?.name === COMPLETION_PLACEHOLDER) {
				node.body.push(...converted);
				node.render = null;
			} else {
				node.body.push(...converted.slice(0, -1));
				node.render = last ?? null;
			}
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === "parent" || value === null || typeof value !== "object") continue;
			if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
			else stack.push(value);
		}
	}
}
function repairIncompleteElement(program, openingStart) {
	const seen = /* @__PURE__ */ new WeakSet();
	const stack = [program];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (node.type === "JSXElement" && node.openingElement?.start === openingStart) {
			node.closingElement = null;
			node.unclosed = true;
			node.end = node.openingElement.end;
			return true;
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === "parent" || value === null || typeof value !== "object") continue;
			if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
			else stack.push(value);
		}
	}
	return false;
}
function tryIncompleteClosingRecovery(parser, filename, recovery, errors) {
	const diagnostic = errors.find((error) => /^unterminated JSX element starting at byte \d+$/u.test(error?.message));
	if (diagnostic === void 0) return null;
	const match = /byte (?<start>\d+)$/u.exec(diagnostic.message);
	const openingStart = Number(match?.groups?.start);
	if (!Number.isInteger(openingStart)) return null;
	const opening = /^<(?<name>[A-Za-z][\w.:-]*)\b[^>]*>/u.exec(recovery.text.slice(openingStart));
	if (opening?.groups?.name === void 0 || opening[0].endsWith("/>")) return null;
	const block = codeBlockRanges(recovery.text).filter((candidate) => candidate.start < openingStart && openingStart < candidate.close).sort((left, right) => left.end - left.start - (right.end - right.start))[0];
	if (block === void 0) return null;
	replaceRecoveryRange(recovery, block.close, block.close, `</${opening.groups.name}>`);
	const result = parser.parseSync(filename, recovery.text, PARSER_OPTIONS);
	if (result?.program === null || (result?.errors?.length ?? 0) > 0) return null;
	if (!repairIncompleteElement(result.program, openingStart)) return null;
	remapRecoveredTree(result.program, recovery.boundaries);
	if (Array.isArray(result.comments)) remapRecoveredTree(result.comments, recovery.boundaries);
	return result;
}
function normalizeCompletionPlaceholderSiblings(program) {
	const seen = /* @__PURE__ */ new WeakSet();
	const stack = [program];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (Array.isArray(node.children)) for (let index = 0; index < node.children.length; index += 1) {
			if (node.children[index]?.expression?.name !== COMPLETION_PLACEHOLDER) continue;
			while (index > 0 && node.children[index - 1]?.type === "JSXText") {
				const previous = node.children[index - 1];
				if (typeof previous.value !== "string" || previous.value.trim() !== "") break;
				node.children.splice(index - 1, 1);
				index -= 1;
			}
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === "parent" || value === null || typeof value !== "object") continue;
			if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
			else stack.push(value);
		}
	}
}
function parseLooseCandidate(parser, filename, recovery) {
	let result;
	try {
		result = parser.parseSync(filename, recovery.text, PARSER_OPTIONS);
	} catch (error) {
		if (!isRecoverableLooseShapeFailure(error)) throw error;
		return {
			result: null,
			program: null,
			errors: [{ message: error.message }]
		};
	}
	return {
		result,
		program: result?.program ?? null,
		errors: result?.errors ?? []
	};
}
function recoveredResult(result, recovery, fragments = []) {
	if (fragments.length > 0) flattenSyntheticFragments(result.program, fragments);
	remapRecoveredTree(result.program, recovery.boundaries);
	if (Array.isArray(result.comments)) remapRecoveredTree(result.comments, recovery.boundaries);
	if (result.program !== null) normalizeCompletionPlaceholderSiblings(result.program);
	return result;
}
function looseRecovery(parser, filename, source) {
	const prepared = incompleteConstructRecovery(source, false);
	const variants = [{
		recovery: prepared.recovery,
		allowRenderWrapping: prepared.expressionLines.length === 0
	}];
	if (prepared.expressionLines.length > 0) variants.push({
		recovery: incompleteConstructRecovery(source, true).recovery,
		allowRenderWrapping: true
	});
	for (const { recovery, allowRenderWrapping } of variants) {
		isolateCompletionCandidate(recovery);
		let parsed = parseLooseCandidate(parser, filename, recovery);
		if (parsed.program !== null && parsed.errors.length === 0) return recoveredResult(parsed.result, recovery);
		const closing = tryIncompleteClosingRecovery(parser, filename, recovery, parsed.errors);
		if (closing !== null) return closing;
		if (!allowRenderWrapping || !parsed.errors.some((error) => LOOSE_RENDER_ERRORS.has(error?.message))) continue;
		const fragments = wrapRenderBlocks(recovery);
		if (fragments.length === 0) continue;
		parsed = parseLooseCandidate(parser, filename, recovery);
		if (parsed.program !== null && parsed.errors.length === 0) return recoveredResult(parsed.result, recovery, fragments);
	}
	return null;
}
function findSubmoduleSources(source) {
	const candidates = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (character === "\"" || character === "'" || character === "`") {
			index = skipQuoted(source, index, character);
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index + 2);
			index = newline === -1 ? source.length : newline + 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const close = source.indexOf("*/", index + 2);
			index = close === -1 ? source.length : close + 2;
			continue;
		}
		const identifier = readIdentifier(source, index);
		if (identifier === null) {
			index += codePointAt(source, index).width || 1;
			continue;
		}
		index = identifier.end;
		if (identifier.name !== "from") continue;
		const replaceStart = index;
		while (index < source.length && WHITESPACE.test(source[index])) index += 1;
		if (index === replaceStart) continue;
		const moduleSource = readIdentifier(source, index);
		if (moduleSource === null) continue;
		candidates.push({
			replaceStart,
			replaceEnd: moduleSource.end,
			name: moduleSource.name,
			start: moduleSource.start,
			end: moduleSource.end
		});
		index = moduleSource.end;
	}
	return candidates;
}
function submoduleRecovery(source, errors) {
	if (typeof source !== "string") return null;
	const unexpectedStarts = /* @__PURE__ */ new Set();
	for (const error of errors) {
		if (error?.message !== "Unexpected token" || !Array.isArray(error?.labels)) continue;
		for (const label of error.labels) if (Number.isInteger(label?.start)) unexpectedStarts.add(label.start);
	}
	if (unexpectedStarts.size === 0) return null;
	const candidates = findSubmoduleSources(source);
	if (!candidates.some((candidate) => unexpectedStarts.has(candidate.start))) return null;
	let rewritten = source;
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		const length = candidate.replaceEnd - candidate.replaceStart;
		const placeholder = `"${" ".repeat(length - 2)}"`;
		rewritten = rewritten.slice(0, candidate.replaceStart) + placeholder + rewritten.slice(candidate.replaceEnd);
	}
	return {
		source: rewritten,
		candidates
	};
}
function restoreSubmoduleSources(program, candidates) {
	const replacements = new Map(candidates.map((candidate) => [`${candidate.replaceStart}:${candidate.replaceEnd}`, candidate]));
	const seen = /* @__PURE__ */ new WeakSet();
	const stack = [program];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (SOURCE_DECLARATION_TYPES.has(node.type) && node.source !== null) {
			const replacement = replacements.get(`${node.source?.start}:${node.source?.end}`);
			if (replacement !== void 0) node.source = {
				type: "Identifier",
				name: replacement.name,
				start: replacement.start,
				end: replacement.end
			};
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === "parent" || value === null || typeof value !== "object") continue;
			if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
			else stack.push(value);
		}
	}
}
function compatibleComment(comment, positionAt, surrogateSource = null) {
	let value = comment?.value;
	if (surrogateSource !== null && typeof value === "string" && value.includes(REPLACEMENT_CHARACTER) && (comment.type === "Line" || comment.type === "Block")) {
		const end = comment.end - (comment.type === "Block" ? 2 : 0);
		const text = surrogateSource.slice(comment.start + 2, end);
		if (text.length === value.length) value = text;
	}
	return {
		...comment,
		value,
		loc: comment?.loc ?? {
			start: positionAt(comment?.start),
			end: positionAt(comment?.end)
		},
		context: comment?.context ?? null
	};
}
function keywordSpan(source, keyword, start, end, positionAt) {
	const offset = source.indexOf(keyword, Math.max(0, start));
	if (offset === -1 || offset + keyword.length > end) return null;
	return {
		start: offset,
		end: offset + keyword.length,
		loc: {
			start: positionAt(offset),
			end: positionAt(offset + keyword.length)
		}
	};
}
function unwrapParenthesizedExpression(value) {
	let expression = value;
	let parenthesized = false;
	while (expression?.type === "ParenthesizedExpression") {
		expression = expression.expression;
		parenthesized = true;
	}
	if (parenthesized && expression !== null && typeof expression === "object") {
		expression.metadata ??= { path: [] };
		expression.metadata.path ??= [];
		expression.metadata.parenthesized = true;
	}
	return expression;
}
const TEXT_COMMENT = /\/\*|(?:^|[ \t\r\n])\/\//u;
const JSX_TEXT_GT = /^Unexpected token\. Did you mean `\{'>'\}`/u;
function rejectsJsxTextGt(errors) {
	return errors.some((error) => typeof error?.message === "string" && JSX_TEXT_GT.test(error.message));
}
const SHORTHAND_ATTRIBUTE = /^Expected `\.\.\.` but found /u;
function rejectsShorthandAttribute(errors) {
	return errors.some((error) => typeof error?.message === "string" && SHORTHAND_ATTRIBUTE.test(error.message));
}
function hasTextComment(program) {
	const stack = [program];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node?.type === "JSXText" && TEXT_COMMENT.test(node.raw)) return true;
		for (const key in node) if (key !== "parent" && node[key] !== null && typeof node[key] === "object") stack.push(node[key]);
	}
	return false;
}
function stampTemplateBlock(value) {
	if (value?.type !== "BlockStatement") return;
	value.metadata ??= { path: [] };
	value.metadata.path ??= [];
	value.metadata.native_tsrx_template_block = true;
	value.metadata.templateMode = "script";
	value.metadata.allows_native_return = false;
}
function materializeDirectiveBlockMetadata(value) {
	if (value.type === "JSXIfExpression") {
		stampTemplateBlock(value.consequent);
		stampTemplateBlock(value.alternate);
	} else if (value.type === "JSXForExpression") {
		stampTemplateBlock(value.body);
		stampTemplateBlock(value.empty);
	} else if (value.type === "JSXTryExpression") {
		stampTemplateBlock(value.block);
		stampTemplateBlock(value.pending);
		stampTemplateBlock(value.handler);
		stampTemplateBlock(value.handler?.body);
	} else if (value.type === "JSXSwitchExpression") for (const switchCase of value.cases ?? []) {
		const body = switchCase?.consequent?.[0]?.body ?? [];
		stampTemplateBlock(switchCase?.consequent?.[0]);
		for (let index = 0; index < body.length; index += 1) {
			const statement = body[index];
			if (statement?.type === "BlockStatement" && statement.body?.length === 1 && statement.body[0]?.type === "ExpressionStatement") body[index] = {
				type: "JSXExpressionContainer",
				start: statement.start,
				end: statement.end,
				expression: statement.body[0].expression
			};
		}
	}
}
function materializeDirectiveRange(value, positionAt) {
	let finalBranch;
	if (value.type === "JSXIfExpression") finalBranch = value.alternate ?? value.consequent;
	else if (value.type === "JSXForExpression") finalBranch = value.empty ?? value.body;
	else if (value.type === "JSXTryExpression") finalBranch = value.handler ?? value.pending ?? value.block;
	else if (value.type === "JSXSwitchExpression") finalBranch = value.cases?.at(-1);
	if (!Number.isInteger(finalBranch?.end) || finalBranch.end <= value.end) return;
	value.end = finalBranch.end;
	if (value.loc?.end != null) value.loc.end = positionAt(value.end);
}
const SIGNATURE_TYPES = /* @__PURE__ */ new Set([
	"TSCallSignatureDeclaration",
	"TSConstructSignatureDeclaration",
	"TSConstructorType",
	"TSFunctionType",
	"TSMethodSignature"
]);
function omitTsrxCoreCompatDefault(type, key, value) {
	if (Array.isArray(value) && value.length === 0 && (key === "decorators" || key === "attributes" && (type === "ExportAllDeclaration" || type === "ExportNamedDeclaration" || type === "ImportDeclaration") || key === "implements" && (type === "ClassDeclaration" || type === "ClassExpression") || key === "extends" && type === "TSInterfaceDeclaration")) return true;
	if (value == null && (key === "accessibility" || key === "directive" || key === "hashbang" || key === "options" || key === "phase" || key === "returnType" || key === "superTypeArguments" || key === "typeAnnotation" || key === "typeArguments" || key === "typeParameters" || type === "RestElement" && key === "value")) return true;
	if (value !== false) return false;
	if (key === "abstract" || key === "const" || key === "declare" || key === "definite" || key === "global" || key === "in" || key === "out" || key === "override" || key === "readonly" || key === "static") return true;
	return key === "optional" && (type === "ArrayPattern" || type === "AssignmentPattern" || type === "Identifier" || type === "MethodDefinition" || type === "ObjectPattern" || type === "Property" || type === "PropertyDefinition" || type === "RestElement" || type === "TSMethodSignature" || type === "TSPropertySignature");
}
function stripOxcDefaultFields(value) {
	for (const key in value) if (omitTsrxCoreCompatDefault(value.type, key, value[key])) delete value[key];
}
const XHTML_ENTITIES = new Map(`
quot:22 amp:26 apos:27 lt:3c gt:3e nbsp:a0 iexcl:a1 cent:a2 pound:a3
curren:a4 yen:a5 brvbar:a6 sect:a7 uml:a8 copy:a9 ordf:aa laquo:ab
not:ac shy:ad reg:ae macr:af deg:b0 plusmn:b1 sup2:b2 sup3:b3 acute:b4
micro:b5 para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba raquo:bb frac14:bc
frac12:bd frac34:be iquest:bf Agrave:c0 Aacute:c1 Acirc:c2 Atilde:c3
Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb
Igrave:cc Iacute:cd Icirc:ce Iuml:cf ETH:d0 Ntilde:d1 Ograve:d2
Oacute:d3 Ocirc:d4 Otilde:d5 Ouml:d6 times:d7 Oslash:d8 Ugrave:d9
Uacute:da Ucirc:db Uuml:dc Yacute:dd THORN:de szlig:df agrave:e0
aacute:e1 acirc:e2 atilde:e3 auml:e4 aring:e5 aelig:e6 ccedil:e7
egrave:e8 eacute:e9 ecirc:ea euml:eb igrave:ec iacute:ed icirc:ee
iuml:ef eth:f0 ntilde:f1 ograve:f2 oacute:f3 ocirc:f4 otilde:f5 ouml:f6
divide:f7 oslash:f8 ugrave:f9 uacute:fa ucirc:fb uuml:fc yacute:fd
thorn:fe yuml:ff OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178
fnof:192 circ:2c6 tilde:2dc Alpha:391 Beta:392 Gamma:393 Delta:394
Epsilon:395 Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39a Lambda:39b
Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1 Sigma:3a3 Tau:3a4
Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omega:3a9 alpha:3b1 beta:3b2
gamma:3b3 delta:3b4 epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9
kappa:3ba lambda:3bb mu:3bc nu:3bd xi:3be omicron:3bf pi:3c0 rho:3c1
sigmaf:3c2 sigma:3c3 tau:3c4 upsilon:3c5 phi:3c6 chi:3c7 psi:3c8
omega:3c9 thetasym:3d1 upsih:3d2 piv:3d6 ensp:2002 emsp:2003 thinsp:2009
zwnj:200c zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014 lsquo:2018
rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020
Dagger:2021 bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033
lsaquo:2039 rsaquo:203a oline:203e frasl:2044 euro:20ac image:2111
weierp:2118 real:211c trade:2122 alefsym:2135 larr:2190 uarr:2191
rarr:2192 darr:2193 harr:2194 crarr:21b5 lArr:21d0 uArr:21d1 rArr:21d2
dArr:21d3 hArr:21d4 forall:2200 part:2202 exist:2203 empty:2205
nabla:2207 isin:2208 notin:2209 ni:220b prod:220f sum:2211 minus:2212
lowast:2217 radic:221a prop:221d infin:221e ang:2220 and:2227 or:2228
cap:2229 cup:222a int:222b there4:2234 sim:223c cong:2245 asymp:2248
ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 sube:2286
supe:2287 oplus:2295 otimes:2297 perp:22a5 sdot:22c5 lceil:2308
rceil:2309 lfloor:230a rfloor:230b lang:2329 rang:232a loz:25ca
spades:2660 clubs:2663 hearts:2665 diams:2666
`.trim().split(/\s+/u).map((entry) => {
	const [name, code] = entry.split(":");
	return [name, String.fromCodePoint(Number.parseInt(code, 16))];
}));
function readCharacterReference(raw, at) {
	let name = "";
	for (let index = at + 1, count = 0; index < raw.length && count++ < 10; index += 1) {
		const ch = raw[index];
		if (ch !== ";") {
			name += ch;
			continue;
		}
		let entity;
		if (name[0] === "#") {
			const hex = name[1] === "x" || name[1] === "X";
			const digits = name.slice(hex ? 2 : 1);
			if ((hex ? /^[\da-f]+$/iu : /^\d+$/u).test(digits)) {
				const code = Number.parseInt(digits, hex ? 16 : 10);
				if (code <= 1114111) entity = String.fromCodePoint(code);
			}
		} else entity = XHTML_ENTITIES.get(name);
		return entity === void 0 ? void 0 : [entity, index + 1];
	}
}
function decodeCharacterReferences(raw, lineFeeds) {
	let value = "";
	let chunk = 0;
	let index = 0;
	while (index < raw.length) {
		const ch = raw.charCodeAt(index);
		if (ch === 38) {
			const reference = readCharacterReference(raw, index);
			if (reference !== void 0) {
				value += raw.slice(chunk, index) + reference[0];
				index = chunk = reference[1];
				continue;
			}
		} else if (ch === 13 && lineFeeds && raw.charCodeAt(index + 1) === 10) {
			value += raw.slice(chunk, index) + "\n";
			index = chunk = index + 2;
			continue;
		}
		index += 1;
	}
	return value + raw.slice(chunk);
}
function decodeJsxReferences(value) {
	if (value.type === "JSXText") {
		const raw = value.raw;
		if (typeof raw !== "string" || !raw.includes("&") && !raw.includes("\r")) return;
		value.value = decodeCharacterReferences(raw, true);
		return;
	}
	const literal = value.value;
	if (literal?.type !== "Literal" || typeof literal.value !== "string" || typeof literal.raw !== "string" || !literal.raw.includes("&")) return;
	literal.value = decodeCharacterReferences(literal.raw.slice(1, -1), false);
}
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const REPLACEMENT_CHARACTER = "�";
function pushReplacementSource(text, index, units) {
	const unit = text.charCodeAt(index);
	if (unit >= 55296 && unit <= 56319) {
		const next = text.charCodeAt(index + 1);
		if (next >= 56320 && next <= 57343) return 2;
		units.push(unit);
	} else if (unit >= 56320 && unit <= 57343) units.push(unit);
	else if (unit === 65533) units.push(null);
	return 1;
}
function javascriptReplacementSources(text) {
	const units = [];
	let index = 0;
	while (index < text.length) {
		if (text.charCodeAt(index) !== 92) {
			index += pushReplacementSource(text, index, units);
			continue;
		}
		const escaped = text[index + 1];
		if (escaped === void 0) return void 0;
		if (escaped === "u") {
			const braced = text[index + 2] === "{";
			const close = braced ? text.indexOf("}", index + 3) : index + 6;
			if (close === -1) return void 0;
			const digits = text.slice(index + (braced ? 3 : 2), close);
			if (/^[\da-f]+$/iu.test(digits) && Number.parseInt(digits, 16) === 65533) units.push(null);
			index = braced ? close + 1 : close;
		} else if (escaped === "x") index += 4;
		else if (escaped === "\r" && text[index + 2] === "\n") index += 3;
		else index += 1 + pushReplacementSource(text, index + 1, units);
	}
	return units;
}
function restoreReplacements(value, units) {
	if (units === void 0) return value;
	const parts = value.split(REPLACEMENT_CHARACTER);
	if (parts.length - 1 !== units.length) return value;
	let restored = parts[0];
	for (let index = 0; index < units.length; index += 1) {
		const unit = units[index];
		restored += (unit === null ? REPLACEMENT_CHARACTER : String.fromCharCode(unit)) + parts[index + 1];
	}
	return restored;
}
function restoreLoneSurrogates(value, source, parent) {
	const authored = (start, end) => {
		if (!Number.isInteger(start) || !Number.isInteger(end)) return void 0;
		const text = source.slice(start, end);
		return LONE_SURROGATE.test(text) ? text : void 0;
	};
	if (value.type === "TemplateElement") {
		const text = authored(value.start, value.end);
		if (text === void 0 || value.value == null) return;
		value.value.raw = text.replace(/\r\n?/gu, "\n");
		if (typeof value.value.cooked === "string") value.value.cooked = restoreReplacements(value.value.cooked, javascriptReplacementSources(text));
		return;
	}
	if (value.type === "JSXText") {
		if (typeof value.raw !== "string" || !value.raw.includes(REPLACEMENT_CHARACTER)) return;
		const text = authored(value.start, value.end);
		if (text === void 0) return;
		value.raw = text;
		value.value = decodeCharacterReferences(text, true);
		return;
	}
	if (value.type !== "Literal" || typeof value.raw !== "string") return;
	if (!value.raw.includes(REPLACEMENT_CHARACTER)) return;
	const text = authored(value.start, value.end);
	if (text === void 0) return;
	value.raw = text;
	if (value.regex != null) {
		const pattern = text.slice(1, text.lastIndexOf("/"));
		value.regex.pattern = pattern;
		try {
			value.value = new RegExp(pattern, value.regex.flags);
		} catch {
			value.value = null;
		}
	} else if (typeof value.value === "string") {
		const interior = text.slice(1, -1);
		value.value = parent?.type === "JSXAttribute" ? decodeCharacterReferences(interior, false) : restoreReplacements(value.value, javascriptReplacementSources(interior));
		if (parent?.type === "ExpressionStatement" && typeof parent.directive === "string") parent.directive = interior;
	}
}
function narrowTemplateElements(value, positionAt) {
	const quasis = value.quasis;
	if (!Array.isArray(quasis) || quasis.length === 0 || quasis[0]?.start !== value.start) return;
	for (const element of quasis) {
		if (!Number.isInteger(element?.start) || !Number.isInteger(element?.end)) continue;
		element.start += 1;
		element.end -= element.tail ? 1 : 2;
		if (Array.isArray(element.range)) element.range = [element.start, element.end];
		element.loc = {
			start: positionAt(element.start),
			end: positionAt(element.end)
		};
	}
}
function materializeCompatibilityProgram(program, source, filename, loose, positionAt, restoresLoneSurrogates = false, preserveParens = false) {
	if (typeof source !== "string") return;
	const decodesJsx = source.includes("&") || source.includes("\r");
	restoresLoneSurrogates &&= LONE_SURROGATE.test(source);
	const surrogateRestored = /* @__PURE__ */ new WeakSet();
	const defaultsStripped = program[TSRX_CORE_COMPAT_DEFAULTS_STRIPPED] === true;
	if (defaultsStripped) delete program[TSRX_CORE_COMPAT_DEFAULTS_STRIPPED];
	const stack = [program];
	const insideHeadStack = [false];
	const templateElements = [];
	while (stack.length > 0) {
		const value = stack.pop();
		const insideHead = insideHeadStack.pop();
		if (value === null || typeof value !== "object") continue;
		if (value.type === "StyleSheet") continue;
		if (value.type === "Program") {
			value.start = 0;
			value.end = source.length;
			value.loc = {
				start: positionAt(0),
				end: positionAt(source.length)
			};
		}
		if (!defaultsStripped) stripOxcDefaultFields(value);
		if (Number.isInteger(value.start) && Number.isInteger(value.end) && value.loc == null) value.loc = {
			start: positionAt(value.start),
			end: positionAt(value.end)
		};
		if (value.type === "JSXElement" || value.type === "JSXFragment" || value.type === "JSXStyleElement") {
			value.metadata ??= { path: [] };
			value.metadata.path ??= [];
			value.metadata.native_tsrx = true;
			const elementName = value.openingElement?.name?.name;
			value.metadata.templateMode = value.type === "JSXStyleElement" || elementName === "script" || value.openingElement?.selfClosing === true ? "script" : "template";
			templateElements.push(value);
		}
		const comment = value.type === "JSXEmptyExpression" && source.slice(value.start, value.end);
		if (comment && /^(\/\/[^\r\n]*|\/\*(?:(?!\*\/)[\s\S])*\*\/)$/u.test(comment)) {
			const type = comment[1] === "/" ? "Line" : "Block";
			let text = comment.slice(2, type === "Line" ? void 0 : -2);
			const indent = /[ \t]*/u.exec(source.slice(source.lastIndexOf("\n", value.start - 1) + 1))[0];
			if (type === "Block" && text.includes("\n")) text = text.replace(new RegExp(`^${indent}`, "gm"), "");
			const { start, end, loc } = value;
			value.innerComments = [{
				type,
				value: text,
				start,
				end,
				loc
			}];
		}
		if (value.type === "TSModuleDeclaration") {
			value.metadata ??= { path: [] };
			value.metadata.path ??= [];
			value.metadata.module_keyword = value.kind;
		}
		if (SIGNATURE_TYPES.has(value.type) && "params" in value) {
			const { params, returnType } = value;
			delete value.params;
			delete value.returnType;
			value.typeParameters = value.typeParameters ?? void 0;
			value.parameters = params;
			if (returnType != null) value.typeAnnotation = returnType;
		}
		if (value.type === "JSXMemberExpression") value.computed = false;
		if (value.type === "TSConstructorType") value.abstract ??= false;
		if (value.type === "TSTypeParameter") {
			if (value.constraint === null) value.constraint = void 0;
			if (value.default === null) value.default = void 0;
		}
		if (value.type === "TSMappedType" && value.key != null) {
			const { key, constraint } = value;
			value.typeParameter = {
				type: "TSTypeParameter",
				name: key,
				constraint,
				start: key.start,
				end: constraint.end
			};
			delete value.key;
			delete value.constraint;
		}
		if (value.type === "TemplateLiteral" || value.type === "TSTemplateLiteralType") narrowTemplateElements(value, positionAt);
		if (restoresLoneSurrogates && !surrogateRestored.has(value)) {
			const child = value.type === "JSXAttribute" ? value.value : value.type === "ExpressionStatement" && typeof value.directive === "string" ? value.expression : null;
			if (child?.type === "Literal") {
				restoreLoneSurrogates(child, source, value);
				surrogateRestored.add(child);
			} else restoreLoneSurrogates(value, source, null);
		}
		if (decodesJsx && (value.type === "JSXText" || value.type === "JSXAttribute")) decodeJsxReferences(value);
		materializeDirectiveBlockMetadata(value);
		materializeDirectiveRange(value, positionAt);
		if ((value.type === "JSXIfExpression" || value.type === "IfStatement") && value.alternate != null && value.alternateKeyword == null) value.alternateKeyword = keywordSpan(source, "@else", value.consequent?.end ?? value.start, value.alternate?.end ?? value.end, positionAt);
		else if (value.type === "JSXForExpression" && value.empty != null && value.emptyKeyword == null) value.emptyKeyword = keywordSpan(source, "@empty", value.body?.end ?? value.start, value.empty?.end ?? value.end, positionAt);
		else if (value.type === "SwitchCase" && value.keyword == null) value.keyword = keywordSpan(source, value.test == null ? "@default" : "@case", value.start, value.end, positionAt);
		else if (value.type === "JSXTryExpression") {
			if (value.pending != null && value.pendingKeyword == null) value.pendingKeyword = keywordSpan(source, "@pending", value.block?.end ?? value.start, value.pending?.end ?? value.end, positionAt);
			if (value.handler != null && value.handlerKeyword == null) value.handlerKeyword = keywordSpan(source, "@catch", value.pending?.end ?? value.block?.end ?? value.start, value.handler?.end ?? value.end, positionAt);
		}
		if (value.type === "JSXStyleElement" && typeof value.css === "string" && value.openingElement?.selfClosing !== true) {
			const style = parse_style(value.css, {
				filename,
				line: value.openingElement?.loc?.start?.line ?? value.loc?.start?.line ?? 1,
				column: value.openingElement?.loc?.start?.column ?? value.loc?.start?.column ?? 0
			}, { loose });
			value.children = [style];
			if (!insideHead) {
				value.metadata ??= { path: [] };
				value.metadata.styleScopeHash = style.hash;
			}
		}
		const elementName = value.openingElement?.name?.name;
		const childInsideHead = insideHead || value.type === "JSXElement" && elementName === "head";
		for (const key in value) {
			let child = value[key];
			if (key === "parent" || key === "loc" || key === "metadata" || key.endsWith("Keyword") || child === null || typeof child !== "object") continue;
			if (Array.isArray(child)) for (let index = child.length - 1; index >= 0; index -= 1) {
				const unwrapped = preserveParens ? child[index] : unwrapParenthesizedExpression(child[index]);
				if (unwrapped !== child[index]) child[index] = unwrapped;
				stack.push(unwrapped);
				insideHeadStack.push(childInsideHead);
			}
			else {
				const unwrapped = preserveParens ? child : unwrapParenthesizedExpression(child);
				if (unwrapped !== child) {
					value[key] = unwrapped;
					child = unwrapped;
				}
				stack.push(child);
				insideHeadStack.push(childInsideHead);
			}
		}
	}
	templateElements.sort((left, right) => left.start - right.start || right.end - left.end);
	for (let index = 0; index < templateElements.length; index += 1) templateElements[index].metadata.commentContainerId = index + 1;
}
function missingProgramError(filename) {
	const error = /* @__PURE__ */ new SyntaxError(`@tsrx/oxc/parser did not return a Program for ${filename}`);
	error.code = void 0;
	error.pos = void 0;
	error.raisedAt = void 0;
	error.end = void 0;
	error.loc = void 0;
	error.fileName = filename;
	error.type = "fatal";
	return error;
}
function addBindingNames(pattern, bindings) {
	if (pattern === null || typeof pattern !== "object") return;
	switch (pattern.type) {
		case "Identifier":
			bindings.add(pattern.name);
			break;
		case "RestElement":
			addBindingNames(pattern.argument, bindings);
			break;
		case "AssignmentPattern":
			addBindingNames(pattern.left, bindings);
			break;
		case "ArrayPattern":
			for (const element of pattern.elements ?? []) addBindingNames(element, bindings);
			break;
		case "ObjectPattern":
			for (const property of pattern.properties ?? []) addBindingNames(property?.type === "RestElement" ? property.argument : property?.value, bindings);
			break;
		case "TSParameterProperty": addBindingNames(pattern.parameter, bindings);
	}
}
function addDeclarationBindings(declaration, bindings) {
	if (declaration === null || typeof declaration !== "object") return;
	switch (declaration.type) {
		case "VariableDeclaration":
			for (const declarator of declaration.declarations ?? []) addBindingNames(declarator?.id, bindings);
			break;
		case "FunctionDeclaration":
		case "ClassDeclaration":
		case "TSDeclareFunction":
		case "TSEnumDeclaration":
		case "TSInterfaceDeclaration":
		case "TSModuleDeclaration":
		case "TSTypeAliasDeclaration":
		case "TSImportEqualsDeclaration": addBindingNames(declaration.id, bindings);
	}
}
function undefinedLocalExportDiagnostics(program) {
	if (!Array.isArray(program?.body)) return [];
	const bindings = /* @__PURE__ */ new Set();
	for (const statement of program.body) {
		if (statement?.type === "ImportDeclaration") {
			for (const specifier of statement.specifiers ?? []) addBindingNames(specifier?.local, bindings);
			continue;
		}
		if (statement?.type === "ExportNamedDeclaration" || statement?.type === "ExportDefaultDeclaration") {
			addDeclarationBindings(statement.declaration, bindings);
			continue;
		}
		addDeclarationBindings(statement, bindings);
	}
	const diagnostics = [];
	for (const statement of program.body) {
		if (statement?.type !== "ExportNamedDeclaration" || statement.declaration != null || statement.source != null) continue;
		for (const specifier of statement.specifiers ?? []) {
			const local = specifier?.local;
			const name = local?.name ?? local?.value;
			if (typeof name !== "string" || bindings.has(name)) continue;
			diagnostics.push({
				severity: "Error",
				message: `Export '${name}' is not defined`,
				labels: [{
					start: Number.isInteger(local?.start) ? local.start : statement.start,
					end: Number.isInteger(local?.end) ? local.end : statement.end,
					message: ""
				}],
				helpMessage: null,
				codeframe: null
			});
		}
	}
	return diagnostics;
}
const SCOPE_TOP = 1;
const SCOPE_FUNCTION = 2;
const SCOPE_VAR = 4;
const SCOPE_SIMPLE_CATCH = 8;
const BIND_VAR = 1;
const BIND_LEXICAL = 2;
const SCOPE_SKIPPED_KEYS = /* @__PURE__ */ new Set([
	"type",
	"start",
	"end",
	"loc",
	"range",
	"metadata",
	"typeAnnotation",
	"returnType",
	"typeParameters",
	"typeArguments",
	"superTypeArguments",
	"superTypeParameters",
	"implements",
	"leadingComments",
	"trailingComments",
	"innerComments",
	"comments",
	"css",
	"content"
]);
const SCOPE_TS_EXPRESSION_WRAPPERS = /* @__PURE__ */ new Set([
	"TSAsExpression",
	"TSSatisfiesExpression",
	"TSNonNullExpression",
	"TSTypeAssertion",
	"TSInstantiationExpression",
	"TSExportAssignment"
]);
const SCOPE_CHILD_KEYS = /* @__PURE__ */ new Map([
	["Identifier", []],
	["Literal", []],
	["JSXText", []],
	["JSXIdentifier", []],
	["JSXNamespacedName", []],
	["JSXMemberExpression", []],
	["TemplateElement", []],
	["ThisExpression", []],
	["Super", []],
	["PrivateIdentifier", []],
	["JSXEmptyExpression", []],
	["JSXClosingElement", []],
	["JSXOpeningFragment", []],
	["JSXClosingFragment", []],
	["EmptyStatement", []],
	["DebuggerStatement", []],
	["BreakStatement", []],
	["ContinueStatement", []],
	["MetaProperty", []],
	["ExpressionStatement", ["expression"]],
	["ReturnStatement", ["argument"]],
	["ThrowStatement", ["argument"]],
	["IfStatement", [
		"test",
		"consequent",
		"alternate"
	]],
	["WhileStatement", ["test", "body"]],
	["DoWhileStatement", ["body", "test"]],
	["LabeledStatement", ["body"]],
	["CallExpression", ["callee", "arguments"]],
	["NewExpression", ["callee", "arguments"]],
	["MemberExpression", ["object", "property"]],
	["ChainExpression", ["expression"]],
	["ParenthesizedExpression", ["expression"]],
	["SequenceExpression", ["expressions"]],
	["BinaryExpression", ["left", "right"]],
	["LogicalExpression", ["left", "right"]],
	["AssignmentExpression", ["left", "right"]],
	["ConditionalExpression", [
		"test",
		"consequent",
		"alternate"
	]],
	["UnaryExpression", ["argument"]],
	["UpdateExpression", ["argument"]],
	["AwaitExpression", ["argument"]],
	["YieldExpression", ["argument"]],
	["SpreadElement", ["argument"]],
	["ObjectExpression", ["properties"]],
	["ArrayExpression", ["elements"]],
	["Property", ["key", "value"]],
	["TemplateLiteral", ["expressions"]],
	["TaggedTemplateExpression", ["tag", "quasi"]],
	["ImportExpression", ["source", "options"]],
	["JSXElement", ["openingElement", "children"]],
	["JSXFragment", ["children"]],
	["JSXOpeningElement", ["name", "attributes"]],
	["JSXAttribute", ["value"]],
	["JSXExpressionContainer", ["expression"]],
	["JSXSpreadAttribute", ["argument"]],
	["JSXSpreadChild", ["expression"]],
	["JSXIfExpression", [
		"test",
		"consequent",
		"alternate"
	]],
	["MethodDefinition", [
		"decorators",
		"key",
		"value"
	]],
	["PropertyDefinition", [
		"decorators",
		"key",
		"value"
	]],
	["AccessorProperty", [
		"decorators",
		"key",
		"value"
	]],
	["Decorator", ["expression"]],
	["ExportDefaultDeclaration", ["declaration"]],
	["ExportAllDeclaration", []]
]);
const DECLARED_LEXICAL = 1;
const DECLARED_VAR = 2;
const DECLARED_TYPE = 4;
const DECLARED_ENUM = 8;
const DECLARED_EXPORT_ONLY = 16;
function scopeHas(scope, name, kind) {
	return scope.names !== null && ((scope.names.get(name) ?? 0) & kind) !== 0;
}
function scopeAdd(scope, name, kind) {
	scope.names ??= /* @__PURE__ */ new Map();
	scope.names.set(name, (scope.names.get(name) ?? 0) | kind);
}
function scopeDiagnostic(message, start, end, fatal) {
	return {
		severity: "Error",
		message,
		labels: [{
			start,
			end,
			message: ""
		}],
		helpMessage: null,
		codeframe: null,
		compatFatal: fatal
	};
}
function nextTokenEnd(source, offset) {
	let index = offset;
	while (index < source.length && /\s/u.test(source[index])) index += 1;
	return Math.min(index + 1, source.length);
}
function scopeDiagnostics(program, source) {
	if (!Array.isArray(program?.body)) return [];
	const diagnostics = [];
	const scopes = [];
	const undefinedExports = /* @__PURE__ */ new Map();
	const enter = (flags) => {
		scopes.push({
			flags,
			names: null,
			firstLexical: void 0
		});
	};
	const exit = () => {
		scopes.pop();
	};
	const current = () => scopes[scopes.length - 1];
	const redeclared = (name, start) => {
		diagnostics.push(scopeDiagnostic(`Identifier '${name}' has already been declared`, start, start + 1, {
			start,
			end: start + 1
		}));
	};
	const pushLexical = (scope, name) => {
		scope.firstLexical ??= name;
		scopeAdd(scope, name, DECLARED_LEXICAL);
	};
	const declareName = (name, binding, start) => {
		const scope = current();
		if (binding === BIND_LEXICAL) {
			if (scopeHas(scope, name, 3)) redeclared(name, start);
			pushLexical(scope, name);
			if (scope.flags & SCOPE_TOP) undefinedExports.delete(name);
			return;
		}
		let reported = false;
		for (let index = scopes.length - 1; index >= 0; index -= 1) {
			const candidate = scopes[index];
			if (!reported && scopeHas(candidate, name, DECLARED_LEXICAL) && !(candidate.flags & SCOPE_SIMPLE_CATCH && candidate.firstLexical === name)) {
				redeclared(name, start);
				reported = true;
			}
			scopeAdd(candidate, name, DECLARED_VAR);
			if (candidate.flags & SCOPE_TOP) undefinedExports.delete(name);
			if (candidate.flags & SCOPE_VAR) break;
		}
	};
	const patternIdentifiers = (pattern, out) => {
		if (pattern === null || typeof pattern !== "object") return out;
		switch (pattern.type) {
			case "Identifier":
				out.push(pattern);
				break;
			case "RestElement":
				patternIdentifiers(pattern.argument, out);
				break;
			case "AssignmentPattern":
				patternIdentifiers(pattern.left, out);
				break;
			case "ArrayPattern":
				for (const element of pattern.elements ?? []) patternIdentifiers(element, out);
				break;
			case "ObjectPattern":
				for (const property of pattern.properties ?? []) patternIdentifiers(property?.type === "RestElement" ? property.argument : property?.value, out);
				break;
			case "TSParameterProperty": patternIdentifiers(pattern.parameter, out);
		}
		return out;
	};
	const patternExpressions = (pattern, out) => {
		if (pattern === null || typeof pattern !== "object") return out;
		switch (pattern.type) {
			case "Identifier":
				out.push(pattern.decorators);
				break;
			case "RestElement":
				patternExpressions(pattern.argument, out);
				break;
			case "AssignmentPattern":
				patternExpressions(pattern.left, out);
				out.push(pattern.right);
				break;
			case "ArrayPattern":
				for (const element of pattern.elements ?? []) patternExpressions(element, out);
				break;
			case "ObjectPattern":
				for (const property of pattern.properties ?? []) if (property?.type === "RestElement") patternExpressions(property.argument, out);
				else {
					if (property?.computed) out.push(property.key);
					patternExpressions(property?.value, out);
				}
				break;
			case "TSParameterProperty":
				out.push(pattern.decorators);
				patternExpressions(pattern.parameter, out);
				break;
			default: out.push(pattern);
		}
		return out;
	};
	const declareIdentifiers = (pattern, binding) => {
		for (const identifier of patternIdentifiers(pattern, [])) declareName(identifier.name, binding, identifier.start);
	};
	const declarePattern = (pattern, binding, out) => {
		patternExpressions(pattern, out);
		out.push(() => declareIdentifiers(pattern, binding));
	};
	const checkParams = (params) => {
		const first = /* @__PURE__ */ new Map();
		const reported = /* @__PURE__ */ new Set();
		for (const param of params ?? []) for (const identifier of patternIdentifiers(param, [])) {
			const { name, start } = identifier;
			if (name === "this") continue;
			if (first.has(name)) {
				if (!reported.has(name)) {
					const firstStart = first.get(name);
					diagnostics.push(scopeDiagnostic("Argument name clash", firstStart, firstStart + name.length, null));
					reported.add(name);
				}
				const end = Number.isInteger(identifier.end) ? identifier.end : start + name.length;
				diagnostics.push(scopeDiagnostic("Argument name clash", start, end, {
					start,
					end: start + 1
				}));
				continue;
			}
			first.set(name, start);
			declareName(name, BIND_VAR, start);
		}
	};
	const declareTopLevelName = (scope, name, kind) => {
		scopeAdd(scope, name, kind);
		if (scope.flags & SCOPE_TOP) undefinedExports.delete(name);
	};
	const scopeDeclares = (scope, name) => scopeHas(scope, name, 23);
	const tasks = [];
	const enterBlock = () => enter(0);
	const enterVarScope = () => enter(SCOPE_VAR);
	const enterFunction = () => enter(6);
	const enterSimpleCatch = () => enter(SCOPE_SIMPLE_CATCH);
	const schedule = (sequence) => {
		for (let index = sequence.length - 1; index >= 0; index -= 1) {
			const task = sequence[index];
			if (task !== null && (typeof task === "object" || typeof task === "function")) tasks.push(task);
		}
	};
	const bodyStatements = (body) => body?.type === "BlockStatement" ? body.body : body;
	const visitFunction = (node, declaration) => {
		const outer = current();
		const body = node.body;
		const sequence = [enterFunction];
		for (const param of node.params ?? []) patternExpressions(param, sequence);
		if (body?.type === "JSXCodeBlock") sequence.push(body, () => checkParams(node.params));
		else if (body != null) sequence.push(() => checkParams(node.params), bodyStatements(body));
		sequence.push(exit);
		if (declaration && node.id?.type === "Identifier") {
			const id = node.id;
			sequence.push(() => {
				if (body != null) declareName(id.name, outer.flags & SCOPE_FUNCTION ? BIND_VAR : BIND_LEXICAL, id.start);
				else if (node.declare && outer.flags & SCOPE_TOP) {
					scopeAdd(outer, id.name, DECLARED_EXPORT_ONLY);
					undefinedExports.delete(id.name);
				}
			});
		}
		schedule(sequence);
	};
	const visitClass = (node, declaration) => {
		const sequence = [node.decorators];
		if (declaration && node.id?.type === "Identifier") {
			const id = node.id;
			sequence.push(() => declareName(id.name, BIND_LEXICAL, id.start));
		}
		sequence.push(node.superClass);
		for (const member of node.body?.body ?? []) if (member?.type === "StaticBlock") sequence.push(enterVarScope, member.body, exit);
		else sequence.push(member);
		schedule(sequence);
	};
	const visitCatch = (clause) => {
		const param = clause.param;
		const sequence = [];
		if (param?.type === "Identifier") sequence.push(enterSimpleCatch, () => pushLexical(current(), param.name));
		else {
			sequence.push(enterBlock);
			if (param != null) declarePattern(param, BIND_LEXICAL, sequence);
		}
		if (clause.resetParam != null) declarePattern(clause.resetParam, BIND_LEXICAL, sequence);
		sequence.push(bodyStatements(clause.body), exit);
		schedule(sequence);
	};
	const checkLocalExports = (node) => {
		for (const specifier of node.specifiers ?? []) {
			const local = specifier?.local;
			if (local?.type !== "Identifier") continue;
			if (scopes.some((scope) => scopeDeclares(scope, local.name))) undefinedExports.delete(local.name);
			else undefinedExports.set(local.name, local);
		}
	};
	const step = (node) => {
		if (Array.isArray(node)) {
			for (let index = node.length - 1; index >= 0; index -= 1) {
				const child = node[index];
				if (child !== null && typeof child === "object") tasks.push(child);
			}
			return;
		}
		const childKeys = SCOPE_CHILD_KEYS.get(node.type);
		if (childKeys !== void 0) {
			for (let index = childKeys.length - 1; index >= 0; index -= 1) {
				const child = node[childKeys[index]];
				if (child !== null && typeof child === "object") tasks.push(child);
			}
			return;
		}
		switch (node.type) {
			case "VariableDeclaration": {
				const binding = node.kind === "var" ? BIND_VAR : BIND_LEXICAL;
				const sequence = [];
				for (const declarator of node.declarations ?? []) {
					declarePattern(declarator?.id, binding, sequence);
					sequence.push(declarator?.init);
				}
				schedule(sequence);
				return;
			}
			case "FunctionDeclaration":
			case "TSDeclareFunction":
				visitFunction(node, true);
				return;
			case "FunctionExpression":
			case "ArrowFunctionExpression":
			case "TSEmptyBodyFunctionExpression":
				visitFunction(node, false);
				return;
			case "ClassDeclaration":
				visitClass(node, true);
				return;
			case "ClassExpression":
				visitClass(node, false);
				return;
			case "BlockStatement":
				schedule([
					enterBlock,
					node.body,
					exit
				]);
				return;
			case "StaticBlock":
				schedule([
					enterVarScope,
					node.body,
					exit
				]);
				return;
			case "CatchClause":
				visitCatch(node);
				return;
			case "TryStatement":
			case "JSXTryExpression":
				schedule([
					node.block,
					node.pending,
					node.handler,
					node.finalizer
				]);
				return;
			case "ForStatement":
				schedule([
					enterBlock,
					node.init,
					node.test,
					node.update,
					node.body,
					exit
				]);
				return;
			case "ForInStatement":
			case "ForOfStatement":
			case "JSXForExpression":
				schedule([
					enterBlock,
					node.left,
					node.right,
					node.index,
					node.key,
					node.body,
					exit,
					node.empty
				]);
				return;
			case "SwitchStatement":
			case "JSXSwitchExpression": {
				const sequence = [node.discriminant, enterBlock];
				for (const clause of node.cases ?? []) sequence.push(clause?.test, clause?.consequent);
				sequence.push(exit);
				schedule(sequence);
				return;
			}
			case "JSXCodeBlock":
				schedule([
					enterBlock,
					node.body,
					node.render,
					exit
				]);
				return;
			case "ImportDeclaration":
				for (const specifier of node.specifiers ?? []) {
					const local = specifier?.local;
					if (local?.type === "Identifier") declareName(local.name, BIND_LEXICAL, local.start);
				}
				return;
			case "TSImportEqualsDeclaration":
				if (node.id?.type === "Identifier") declareName(node.id.name, BIND_LEXICAL, node.id.start);
				return;
			case "ExportNamedDeclaration":
				if (node.source == null && current().flags & SCOPE_TOP) schedule([node.declaration, () => checkLocalExports(node)]);
				else schedule([node.declaration]);
				return;
			case "TSEnumDeclaration": {
				const scope = current();
				const name = node.id?.name;
				if (typeof name !== "string" || scopeHas(scope, name, DECLARED_ENUM)) return;
				declareName(name, BIND_LEXICAL, node.id.start);
				scopeAdd(scope, name, DECLARED_ENUM);
				return;
			}
			case "TSInterfaceDeclaration":
				if (node.id?.type === "Identifier") declareTopLevelName(current(), node.id.name, DECLARED_TYPE);
				return;
			case "TSTypeAliasDeclaration": {
				const scope = current();
				const id = node.id;
				if (id?.type !== "Identifier") return;
				if (scopeHas(scope, id.name, DECLARED_TYPE)) diagnostics.push(scopeDiagnostic(`type '${id.name}' has already been declared.`, id.start, id.start + 1, {
					start: id.start,
					raisedAt: nextTokenEnd(source, id.end),
					raise: true
				}));
				declareTopLevelName(scope, id.name, DECLARED_TYPE);
				return;
			}
			case "TSModuleDeclaration": {
				let id = node.id;
				while (id?.type === "TSQualifiedName") id = id.left;
				if (id?.type === "Identifier" && node.kind !== "global") declareTopLevelName(current(), id.name, DECLARED_EXPORT_ONLY);
				let body = node.body;
				while (body?.type === "TSModuleDeclaration") body = body.body;
				if (body?.type === "TSModuleBlock") schedule([
					enterVarScope,
					body.body,
					exit
				]);
				return;
			}
			case "JSXStyleElement":
			case "StyleSheet": return;
		}
		if (typeof node.type === "string" && node.type.startsWith("TS")) {
			if (SCOPE_TS_EXPRESSION_WRAPPERS.has(node.type)) schedule([node.expression]);
			return;
		}
		const children = [];
		for (const key in node) {
			if (SCOPE_SKIPPED_KEYS.has(key)) continue;
			children.push(node[key]);
		}
		schedule(children);
	};
	enter(5);
	schedule([program.body]);
	while (tasks.length > 0) {
		const task = tasks.pop();
		if (typeof task === "function") task();
		else step(task);
	}
	exit();
	for (const [name, local] of undefinedExports) diagnostics.push(scopeDiagnostic(`Export '${name}' is not defined`, local.start, local.start + 1, {
		start: local.start,
		raisedAt: source.length,
		raise: true
	}));
	return diagnostics;
}
function scopeFatalError(error, filename, positionAt) {
	const fatal = error.compatFatal;
	if (fatal.raise) return acornRaise(error.message, fatal.start, positionAt, fatal.raisedAt);
	const message = error.message;
	return compileError({
		message,
		code: compatibleDiagnosticCode(null, message),
		start: fatal.start,
		end: fatal.end
	}, filename, positionAt, "fatal", Error);
}
function strictError(errors, filename, positionAt, source) {
	const error = errors.find((candidate) => candidate?.compatFatal !== null) ?? errors[0];
	if (error?.compatFatal != null) return scopeFatalError(error, filename, positionAt);
	if (isUnclosedTag(error)) return unclosedTagRaise(error, positionAt);
	return coreThrownError(error, filename, positionAt, source);
}
function mergeBySourceOrder(left, right) {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	const merged = [];
	let l = 0;
	let r = 0;
	while (l < left.length && r < right.length) if (diagnosticStart(right[r]) < diagnosticStart(left[l])) merged.push(right[r++]);
	else merged.push(left[l++]);
	while (l < left.length) merged.push(left[l++]);
	while (r < right.length) merged.push(right[r++]);
	return merged;
}
const SCRIPT_END_TAG_START = /<\/script/giu;
const SCRIPT_END_TAG_IN_BODY_CODE = "TSRX1004";
function mayHaveScriptEndTagInBody(source) {
	if (typeof source !== "string") return false;
	SCRIPT_END_TAG_START.lastIndex = 0;
	let match;
	while ((match = SCRIPT_END_TAG_START.exec(source)) !== null) {
		if (match[0] !== "<\/script") return true;
		if (!/^[\t\n\f\r ]*>/u.test(source.slice(match.index + match[0].length))) return true;
	}
	return false;
}
function scriptEndTagDiagnostics(program, source) {
	if (!mayHaveScriptEndTagInBody(source)) return [];
	const diagnostics = [];
	const stack = [program];
	while (stack.length > 0) {
		const value = stack.pop();
		if (value === null || typeof value !== "object") continue;
		if (Array.isArray(value)) {
			for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
			continue;
		}
		if (value.type === "JSXElement" && value.openingElement?.name?.type === "JSXIdentifier" && value.openingElement.name.name === "script" && typeof value.content === "string" && Number.isInteger(value.openingElement.end)) {
			const contentStart = value.openingElement.end;
			SCRIPT_END_TAG_START.lastIndex = 0;
			let match;
			while ((match = SCRIPT_END_TAG_START.exec(value.content)) !== null) {
				const written = match[0];
				const start = contentStart + match.index;
				diagnostics.push({
					severity: "Error",
					message: `'${written}' can end a script in HTML, so a '<script>' body can't contain it. Write '<\\/${written.slice(2)}' instead.`,
					code: SCRIPT_END_TAG_IN_BODY_CODE,
					labels: [{
						start,
						end: start + written.length,
						message: ""
					}],
					helpMessage: null,
					codeframe: null
				});
			}
		}
		for (const key in value) {
			if (key === "loc" || key === "metadata" || key === "content") continue;
			const child = value[key];
			if (child !== null && typeof child === "object") stack.push(child);
		}
	}
	return diagnostics;
}
function sortBySourceOrder(errors) {
	const dynamic = [];
	const others = [];
	for (const [index, error] of errors.entries()) (error?.message === DYNAMIC_TAG_REFERENCE_MESSAGE ? dynamic : others).push({
		error,
		index
	});
	others.sort((left, right) => diagnosticStart(left.error) - diagnosticStart(right.error) || left.index - right.index);
	const merged = [];
	let next = 0;
	for (const entry of dynamic) {
		while (next < others.length && diagnosticStart(others[next].error) < diagnosticStart(entry.error)) {
			merged.push(others[next].error);
			next += 1;
		}
		merged.push(entry.error);
	}
	for (; next < others.length; next += 1) merged.push(others[next].error);
	return merged;
}
function diagnosticStart(error) {
	const { start } = primarySpan(error);
	return Number.isInteger(start) ? start : Number.POSITIVE_INFINITY;
}
function isEventAttribute(name) {
	return name.startsWith("on") && name.length > 2 && name[2] === name[2].toUpperCase();
}
function isCaptureEvent(name) {
	const lowered = name.toLowerCase();
	return name.endsWith("Capture") && lowered !== "gotpointercapture" && lowered !== "lostpointercapture";
}
function normalizeEventName(name) {
	const original = name.slice(2);
	return (isCaptureEvent(original) ? original.slice(0, -7) : original).toLowerCase();
}
function createTsrxCoreCompat(parser) {
	if (typeof parser?.parseSync !== "function") throw new TypeError("@tsrx/oxc-core-compat requires a parseSync function");
	return Object.freeze({
		isEventAttribute,
		normalizeEventName,
		parseModule(source, filename = "module.tsrx", options) {
			const resolvedFilename = filename || "module.tsrx";
			const collecting = Boolean(options?.collect || options?.loose);
			const wantsComments = Array.isArray(options?.comments);
			const preserveParens = options?.preserveParens === true;
			const eagerTsrx = !options?.loose && !wantsComments && !preserveParens;
			let selectedParserOptions = parserOptions(resolvedFilename, eagerTsrx);
			let positionAt;
			const positions = () => positionAt ??= positionLookup(source);
			let result;
			try {
				try {
					result = parser.parseSync(resolvedFilename, source, nativeParserOptions(selectedParserOptions, preserveParens));
				} catch (ordinaryError) {
					if (selectedParserOptions !== TYPESCRIPT_REACT_PARSER_OPTIONS || typeof source !== "string" || !(source.includes("@{") || TEXT_COMMENT.test(source) || rejectsJsxTextGt([ordinaryError, ...ordinaryError?.errors ?? []]) || rejectsShorthandAttribute([ordinaryError, ...ordinaryError?.errors ?? []]))) throw ordinaryError;
					let retry = null;
					try {
						retry = tsrxRetry(parser, resolvedFilename, source, eagerTsrx);
					} catch {
						retry = null;
					}
					if (retry !== null) {
						result = retry.result;
						selectedParserOptions = retry.options;
					} else {
						const failure = rejectsShorthandAttribute([ordinaryError, ...ordinaryError?.errors ?? []]) ? tsrxFailure(parser, resolvedFilename, source, eagerTsrx) : null;
						if (failure?.error !== void 0) throw failure.error;
						if (failure === null) throw ordinaryError;
						result = failure.result;
						selectedParserOptions = failure.options;
					}
				}
			} catch (error) {
				if (options?.loose && typeof source === "string" && isRecoverableLooseShapeFailure(error)) {
					const recovered = looseRecovery(parser, resolvedFilename, source);
					if (recovered === null) throw error;
					result = recovered;
				} else {
					if (isOperationalError(error) || !isSyntaxErrorLike(error)) throw error;
					if (isDynamicTagNotExpression(error)) throw dynamicTagNotExpressionError(error, positions());
					if (isUnclosedTag(error)) throw unclosedTagFailure(error, collecting, positions(), source);
					const translated = coreThrownError(error, resolvedFilename, positions(), source);
					if (collecting && Array.isArray(options?.errors)) options.errors.push(toCompileError(error, resolvedFilename, positions(), "usage", source));
					throw translated;
				}
			}
			if (selectedParserOptions === TYPESCRIPT_REACT_PARSER_OPTIONS && typeof source === "string" && (parserResultProgram(result) === null || parserResultErrors(result).length > 0 ? source.includes("@{") || TEXT_COMMENT.test(source) || rejectsJsxTextGt(parserResultErrors(result)) || rejectsShorthandAttribute(parserResultErrors(result)) : hasTextComment(parserResultProgram(result)))) {
				let retry = null;
				try {
					retry = tsrxRetry(parser, resolvedFilename, source, eagerTsrx);
				} catch {}
				if (retry !== null) {
					result = retry.result;
					selectedParserOptions = retry.options;
				} else if (rejectsShorthandAttribute(parserResultErrors(result))) {
					const failure = tsrxFailure(parser, resolvedFilename, source, eagerTsrx);
					if (failure?.error !== void 0) throw failure.error;
					if (failure !== null) {
						result = failure.result;
						selectedParserOptions = failure.options;
					}
				}
			}
			if (parserResultProgram(result) === null) {
				const notExpression = parserResultErrors(result).find(isDynamicTagNotExpression);
				if (notExpression !== void 0) throw dynamicTagNotExpressionError(notExpression, positions());
				const unclosed = parserResultErrors(result)[0];
				if (isUnclosedTag(unclosed)) throw unclosedTagFailure(unclosed, collecting, positions(), source);
			}
			let program;
			let comments;
			let nativeErrors;
			try {
				program = parserResultProgram(result);
				nativeErrors = parserResultErrors(result);
				if (program === null) {
					const recovery = submoduleRecovery(source, nativeErrors);
					if (recovery !== null) {
						result = parser.parseSync(resolvedFilename, recovery.source, nativeParserOptions(selectedParserOptions, preserveParens));
						program = parserResultProgram(result);
						nativeErrors = parserResultErrors(result);
						if (program !== null) restoreSubmoduleSources(program, recovery.candidates);
					}
				}
				if (program === null && options?.loose && typeof source === "string") {
					const recovered = looseRecovery(parser, resolvedFilename, source);
					if (recovered !== null) {
						result = recovered;
						program = recovered.program;
						nativeErrors = recovered.errors ?? [];
					}
				}
				if (program !== null && options?.loose && typeof source === "string" && source.includes(COMPLETION_PLACEHOLDER)) normalizeCompletionPlaceholderSiblings(program);
				if (program !== null && selectedParserOptions.showSemanticErrors === true) {
					const compatibilityErrors = undefinedLocalExportDiagnostics(program);
					if (compatibilityErrors.length > 0) nativeErrors = [...nativeErrors, ...compatibilityErrors];
				}
				if (nativeErrors.length > 1 && nativeErrors.some((error) => error?.message === DYNAMIC_TAG_REFERENCE_MESSAGE)) nativeErrors = sortBySourceOrder(nativeErrors);
				if (program !== null) {
					const scriptErrors = scriptEndTagDiagnostics(program, source);
					if (scriptErrors.length > 0) nativeErrors = sortBySourceOrder([...nativeErrors, ...scriptErrors]);
				}
				if (program !== null && (selectedParserOptions === PARSER_OPTIONS || selectedParserOptions === EAGER_PARSER_OPTIONS)) {
					const scopeErrors = scopeDiagnostics(program, source);
					if (scopeErrors.length > 0) {
						const exportErrors = scopeErrors.filter((error) => error.message.startsWith("Export '"));
						const declarationErrors = scopeErrors.filter((error) => !error.message.startsWith("Export '"));
						nativeErrors = [...mergeBySourceOrder(nativeErrors, declarationErrors), ...exportErrors];
					}
				}
				comments = wantsComments ? result?.comments ?? [] : [];
			} catch (error) {
				if (isOperationalError(error) || !isSyntaxErrorLike(error)) throw error;
				if (isDynamicTagNotExpression(error)) throw dynamicTagNotExpressionError(error, positions());
				const translated = coreThrownError(error, resolvedFilename, positions(), source);
				if (collecting && Array.isArray(options?.errors)) options.errors.push(toCompileError(error, resolvedFilename, positions(), "usage", source));
				throw translated;
			}
			if (nativeErrors.length > 0) {
				if (!collecting) throw strictError(nativeErrors, resolvedFilename, positions(), source);
				if (Array.isArray(options?.errors)) for (const error of nativeErrors) options.errors.push(toCompileError(error, resolvedFilename, positions(), "usage", source));
			}
			if (program === null) {
				if (nativeErrors.length > 0) throw coreThrownError(nativeErrors[0], resolvedFilename, positions(), source);
				throw missingProgramError(resolvedFilename);
			}
			const ordinaryLane = selectedParserOptions !== PARSER_OPTIONS && selectedParserOptions !== EAGER_PARSER_OPTIONS;
			materializeCompatibilityProgram(program, source, resolvedFilename, Boolean(options?.loose), positions(), ordinaryLane, preserveParens);
			if (wantsComments) {
				const restores = ordinaryLane && typeof source === "string" && LONE_SURROGATE.test(source);
				for (const comment of comments) options.comments.push(compatibleComment(comment, positions(), restores ? source : null));
			}
			return program;
		}
	});
}
//#endregion
export { createTsrxCoreCompat, isEventAttribute, normalizeEventName };
