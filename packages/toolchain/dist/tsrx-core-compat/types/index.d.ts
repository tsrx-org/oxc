import type { Program, CommentWithLocation, SourceLocation } from "./estree.js";

export interface CompileError extends Error {
  code: string | undefined;
  pos: number | undefined;
  raisedAt: number | undefined;
  end: number | undefined;
  loc: SourceLocation | undefined;
  fileName: string | null;
  type: "fatal" | "usage";
}

export interface ParseOptions {
  collect?: boolean;
  loose?: boolean;
  /**
   * Keep each parenthesized expression as a `ParenthesizedExpression` node, as `@tsrx/core`
   * does. By default the parentheses are removed and the inner expression is returned.
   */
  preserveParens?: boolean;
  errors?: CompileError[];
  comments?: CommentWithLocation[];
}

export interface CustomMappingData {
  embeddedId?: string;
  content?: string;
  [key: string]: unknown;
}

export interface MappingData {
  verification: boolean;
  completion: boolean;
  semantic: boolean;
  navigation: boolean;
  structure: boolean;
  format: boolean;
  customData: CustomMappingData;
}

export interface CodeMapping {
  sourceOffsets: number[];
  generatedOffsets: number[];
  lengths: number[];
  generatedLengths: number[];
  data: MappingData;
}

export interface VolarMappingsResult {
  code: string;
  mappings: CodeMapping[];
  cssMappings: CodeMapping[];
  errors: CompileError[];
  sourceAst: Program;
}
