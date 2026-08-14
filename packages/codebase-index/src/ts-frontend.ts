/**
 * TypeScript compiler API front-end for stronger indexing (Phase B).
 * Falls back silently if typescript is unavailable.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  classifyCallee,
  classifyField,
  resolveSdkContext,
  type SdkDetection,
  type SdkMatchSets,
} from "./sdk-detect.js";

export type TsExtractedFunction = {
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  callees: string[];
};

export type TsApiUsage = {
  filePath: string;
  line: number;
  kind: "sdk_call" | "http_path" | "import" | "field_token";
  value: string;
  functionName?: string;
  detection?: SdkDetection;
};

/** Resolved provider surface + import-resolved receivers for the file. */
export type TsSdkContext = {
  sets: SdkMatchSets;
  fileReceivers: ReadonlySet<string>;
};

let tsMod: typeof import("typescript") | null | undefined;

/** Load TypeScript compiler API (sync via createRequire for tsx/node). */
export function loadTypescriptSync(): typeof import("typescript") | null {
  if (tsMod !== undefined) return tsMod;
  try {
    const req = createRequire(import.meta.url);
    tsMod = req("typescript") as typeof import("typescript");
  } catch {
    tsMod = null;
  }
  return tsMod;
}

export async function loadTypescript(): Promise<typeof import("typescript") | null> {
  const sync = loadTypescriptSync();
  if (sync) return sync;
  try {
    tsMod = await import("typescript");
    return tsMod;
  } catch {
    tsMod = null;
    return null;
  }
}

export function extractWithTypescript(
  repoRoot: string,
  absPath: string,
  ts: typeof import("typescript"),
  sourceText?: string,
  sdkContext?: TsSdkContext,
): { functions: TsExtractedFunction[]; usages: TsApiUsage[]; imports: string[] } {
  const text = sourceText ?? readFileSync(absPath, "utf8");
  const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sets = sdkContext?.sets ?? resolveSdkContext();
  const fileReceivers = sdkContext?.fileReceivers ?? new Set<string>();

  const functions: TsExtractedFunction[] = [];
  const usages: TsApiUsage[] = [];
  const imports: string[] = [];

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: import("typescript").Node, fnStack: string[]) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      let callee = "";
      if (ts.isIdentifier(expr)) callee = expr.text;
      else if (ts.isPropertyAccessExpression(expr)) {
        callee = expr.getText(sf);
      }
      if (callee) {
        const line = lineOf(node.getStart(sf));
        const detection = classifyCallee(callee, sets, fileReceivers);
        if (detection) {
          usages.push({
            filePath: rel,
            line,
            kind: "sdk_call",
            value: callee,
            functionName: fnStack[fnStack.length - 1],
            detection,
          });
        }
      }
      for (const arg of node.arguments) {
        if (ts.isStringLiteral(arg) && arg.text.includes("/v")) {
          usages.push({
            filePath: rel,
            line: lineOf(arg.getStart(sf)),
            kind: "http_path",
            value: arg.text,
            functionName: fnStack[fnStack.length - 1],
          });
        }
      }
    }

    if (ts.isStringLiteral(node) && /\/v\d+\//.test(node.text)) {
      usages.push({
        filePath: rel,
        line: lineOf(node.getStart(sf)),
        kind: "http_path",
        value: node.text,
        functionName: fnStack[fnStack.length - 1],
      });
    }

    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const n = node.name.text;
      const detection = classifyField(n, sets);
      if (detection) {
        usages.push({
          filePath: rel,
          line: lineOf(node.getStart(sf)),
          kind: "field_token",
          value: n,
          functionName: fnStack[fnStack.length - 1],
          detection,
        });
      }
    }

    let nextStack = fnStack;
    let fnName: string | null = null;
    if (ts.isFunctionDeclaration(node) && node.name) {
      fnName = node.name.text;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        fnName = node.name.text;
      }
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      fnName = node.name.text;
    }

    if (
      fnName &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node))
    ) {
      const body = ts.isVariableDeclaration(node) ? node.initializer : node;
      const start = lineOf(node.getStart(sf));
      const end = lineOf(node.getEnd());
      const callees: string[] = [];
      const collect = (n: import("typescript").Node) => {
        if (ts.isCallExpression(n)) {
          if (ts.isIdentifier(n.expression)) callees.push(n.expression.text);
          else if (ts.isPropertyAccessExpression(n.expression)) {
            callees.push(n.expression.name.text);
            callees.push(n.expression.getText(sf));
          }
        }
        ts.forEachChild(n, collect);
      };
      if (body) ts.forEachChild(body, collect);
      functions.push({
        name: fnName,
        filePath: rel,
        lineStart: start,
        lineEnd: end,
        callees: [...new Set(callees)],
      });
      nextStack = [...fnStack, fnName];
    }

    ts.forEachChild(node, (c) => visit(c, nextStack));
  };

  visit(sf, []);
  return { functions, usages, imports: [...new Set(imports)] };
}

export function isTypescriptFile(path: string): boolean {
  return /\.(tsx?|jsx?|mts|cts)$/.test(path);
}
