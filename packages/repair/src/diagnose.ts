/**
 * Parse CI / compiler / test output into structured failure observations.
 */
import type { FailureKind, FailureObservation } from "./types.js";

const PATTERNS: Array<{
  kind: FailureKind;
  re: RegExp;
  map: (m: RegExpMatchArray) => Partial<FailureObservation>;
}> = [
  {
    kind: "type_error",
    re: /(?:error\s+TS\d+:|error:)\s*(.+?)(?:\r?\n|$)/gi,
    map: (m) => ({ message: m[1]!.trim() }),
  },
  {
    kind: "type_error",
    re: /([^\s:]+\.[tj]sx?):(\d+):(\d+)[\s-]+error\s+TS\d+:\s*(.+)/gi,
    map: (m) => ({
      filePath: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      message: m[4]!.trim(),
    }),
  },
  {
    kind: "undefined_symbol",
    re: /Cannot find name ['"](\w+)['"]/gi,
    map: (m) => ({ symbol: m[1], message: `Cannot find name '${m[1]}'` }),
  },
  {
    kind: "undefined_symbol",
    re: /'(\w+)' is not defined/gi,
    map: (m) => ({ symbol: m[1], message: `'${m[1]}' is not defined` }),
  },
  {
    kind: "missing_module",
    re: /Cannot find module ['"]([^'"]+)['"]/gi,
    map: (m) => ({ symbol: m[1], message: `Cannot find module '${m[1]}'` }),
  },
  {
    kind: "syntax_error",
    re: /SyntaxError:\s*(.+?)(?:\r?\n|$)/gi,
    map: (m) => ({ message: m[1]!.trim() }),
  },
  {
    kind: "test_assert",
    re: /(?:AssertionError|expect\(received\))[\s\S]{0,200}/gi,
    map: (m) => ({ message: m[0]!.slice(0, 200) }),
  },
  {
    kind: "api_rename_leftover",
    re: /(?:Property|Object literal may only specify known properties).*?['"](\w+)['"]/gi,
    map: (m) => ({ symbol: m[1], message: m[0]!.slice(0, 160) }),
  },
];

export function diagnoseFailureLog(log: string): FailureObservation[] {
  const out: FailureObservation[] = [];
  const seen = new Set<string>();

  // Explicit mendpoint FIXMEs are repair targets
  for (const m of log.matchAll(/FIXME\(mendpoint\):\s*(.+)/g)) {
    const key = `fixme:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "fixme_mendpoint",
      message: m[1]!.trim(),
      suggestion: "Resolve or remove FIXME after migration",
    });
  }

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of log.matchAll(p.re)) {
      const partial = p.map(m);
      const key = `${p.kind}:${partial.filePath ?? ""}:${partial.line ?? ""}:${partial.message ?? m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: p.kind,
        message: partial.message ?? m[0]!.slice(0, 200),
        filePath: partial.filePath,
        line: partial.line,
        column: partial.column,
        symbol: partial.symbol,
        raw: m[0]!.slice(0, 400),
      });
    }
  }

  if (!out.length && log.trim()) {
    out.push({
      kind: "unknown",
      message: log.trim().slice(0, 300),
      raw: log.slice(0, 800),
    });
  }

  return out.slice(0, 40);
}

/** Scan repo text for leftover rename symbols and FIXMEs */
export function diagnoseWorkingTree(
  files: Array<{ path: string; content: string }>,
  renameMap?: Record<string, string>,
): FailureObservation[] {
  const out: FailureObservation[] = [];
  for (const f of files) {
    if (/FIXME\(mendpoint\)/.test(f.content)) {
      out.push({
        kind: "fixme_mendpoint",
        filePath: f.path,
        message: "Unresolved FIXME(mendpoint) marker",
        suggestion: "Address removed endpoint or delete marker after fix",
      });
    }
    if (renameMap) {
      for (const [from, to] of Object.entries(renameMap)) {
        if (from === to) continue;
        const re = new RegExp(`\\b${escapeReg(from)}\\b`);
        if (re.test(f.content)) {
          out.push({
            kind: "api_rename_leftover",
            filePath: f.path,
            symbol: from,
            message: `Leftover symbol '${from}' should be '${to}'`,
            suggestion: `rename ${from} to ${to}`,
          });
        }
      }
    }
  }
  return out;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
