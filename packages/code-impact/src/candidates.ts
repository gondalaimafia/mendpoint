/**
 * Stage: Candidate Discovery (fast, high-recall, deterministic).
 *
 * Layered by reliability:
 * 1. SDK / module graph matches
 * 2. Syntactic / pattern matches (path, field tokens)
 * 3. String & configuration heuristics
 * 4. Import-based expansion (+ call-graph hops handled in expansion stage)
 */
import type {
  CandidateSite,
  CandidateSource,
  Confidence,
  ImpactableSurface,
} from "@mendpoint/shared";
import type { CodebaseIndex } from "@mendpoint/codebase-index";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function confFromSource(source: CandidateSource, breaking: boolean): Confidence {
  if (source === "sdk_graph") return breaking ? "high" : "medium";
  if (source === "syntactic") return "high";
  if (source === "string_heuristic") return "medium";
  if (source === "import_expansion") return "medium";
  return "low";
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-segment matching for dotted identifiers / paths. A token matches a value
 * only when one's segment sequence is a contiguous run of *whole* segments in the
 * other — so `balance` matches `client.balance.retrieve` and a bare `balance`,
 * but never `unbalanced`, `rebalance`, or `balanceSheet`, and a short value like
 * `bal` never matches the longer token `balance`.
 */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function dottedSegments(s: string): string[] {
  return s.toLowerCase().split(".").filter(Boolean);
}

function tokenMatchesUsage(token: string, value: string): boolean {
  const t = dottedSegments(token);
  const v = dottedSegments(value);
  if (!t.length || !v.length) return false;
  return containsRun(v, t) || containsRun(t, v);
}

function pathSegments(s: string): string[] {
  return s
    .replace(/\{[^}]+\}/g, "")
    .split("/")
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}

function pathMatchesUsage(hint: string, value: string): boolean {
  const h = pathSegments(hint);
  const v = pathSegments(value);
  if (!h.length || !v.length) return false;
  return containsRun(v, h) || containsRun(h, v);
}

/**
 * Whether a path hint appears in a free-text source line at a segment boundary.
 * The trailing lookahead stops `/v1/balance` from matching `/v1/balances`.
 */
function pathInLine(line: string, hint: string): boolean {
  const variants = new Set([hint, hint.replace(/\{[^}]+\}/g, "")]);
  for (const h of variants) {
    if (!h || h.length < 4) continue;
    if (new RegExp(`${escapeReg(h)}(?![A-Za-z0-9_])`).test(line)) return true;
  }
  return false;
}

type Acc = Map<string, CandidateSite>;

function keyOf(file: string, line: number, symbol: string) {
  return `${file}:${line}:${symbol}`;
}

function add(
  acc: Acc,
  site: Omit<CandidateSite, "sources" | "surfaceIds" | "initialConfidence"> & {
    source: CandidateSource;
    surfaceId: string;
    confidence: Confidence;
  },
) {
  const k = keyOf(site.filePath, site.lineStart, site.symbol);
  const existing = acc.get(k);
  if (existing) {
    if (!existing.sources.includes(site.source)) existing.sources.push(site.source);
    if (!existing.surfaceIds.includes(site.surfaceId)) existing.surfaceIds.push(site.surfaceId);
    // upgrade confidence if higher
    const rank = { low: 0, medium: 1, high: 2 };
    if (rank[site.confidence] > rank[existing.initialConfidence]) {
      existing.initialConfidence = site.confidence;
    }
    return;
  }
  acc.set(k, {
    filePath: site.filePath,
    lineStart: site.lineStart,
    lineEnd: site.lineEnd,
    symbol: site.symbol,
    functionName: site.functionName,
    surfaceIds: [site.surfaceId],
    sources: [site.source],
    initialConfidence: site.confidence,
    evidence: site.evidence,
  });
}

export function discoverCandidates(
  index: CodebaseIndex,
  surfaces: ImpactableSurface[],
): CandidateSite[] {
  const acc: Acc = new Map();
  const breaking = surfaces.some((s) => s.severity === "breaking");

  // 1) SDK graph — apiUsages kind sdk_call. A call matched against the known
  //    provider surface is a high-signal `sdk_graph` hit; one recognised only by
  //    the provider-agnostic fallback heuristic is downgraded to a low-confidence
  //    `string_heuristic` hit so a guess is never labelled like a real match.
  for (const surface of surfaces) {
    for (const token of surface.searchTokens) {
      for (const u of index.apiUsages) {
        if (u.kind !== "sdk_call") continue;
        if (!tokenMatchesUsage(token, u.value)) continue;
        const heuristic = u.detection === "general_heuristic";
        add(acc, {
          filePath: u.filePath,
          lineStart: u.line,
          lineEnd: u.line,
          symbol: u.value,
          functionName: u.functionName,
          evidence: u.value,
          source: heuristic ? "string_heuristic" : "sdk_graph",
          surfaceId: surface.id,
          confidence: heuristic
            ? "low"
            : confFromSource("sdk_graph", surface.severity === "breaking"),
        });
      }
    }
  }

  // 2) Syntactic — HTTP paths + field tokens in source lines
  for (const surface of surfaces) {
    const pathHints = [surface.path, ...(surface.path ? [surface.path.replace(/\{[^}]+\}/g, "")] : [])]
      .filter(Boolean) as string[];
    const fieldHints = [surface.field, surface.fromField, surface.toField].filter(
      Boolean,
    ) as string[];

    for (const u of index.apiUsages) {
      if (u.kind === "http_path") {
        for (const hint of pathHints) {
          if (pathMatchesUsage(hint, u.value)) {
            add(acc, {
              filePath: u.filePath,
              lineStart: u.line,
              lineEnd: u.line,
              symbol: surface.path ?? u.value,
              functionName: u.functionName,
              evidence: u.value,
              source: "syntactic",
              surfaceId: surface.id,
              confidence: confFromSource("syntactic", surface.severity === "breaking"),
            });
          }
        }
      }
    }

    // Field tokens: scan file lines for word matches (only files that already look API-related)
    const apiFiles = new Set(
      index.apiUsages.map((u) => u.filePath).concat(
        index.files.filter((f) => f.imports.some((i) => /fetch|axios|http|acme|stripe/i.test(i))).map((f) => f.path),
      ),
    );
    // Always scan all code files for field renames — precise token match
    for (const file of index.files) {
      if (file.isTest && fieldHints.length === 0) continue;
      let text: string;
      try {
        text = readFileSync(join(index.repoRoot, file.path), "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        for (const field of fieldHints) {
          if (!new RegExp(`\\b${escapeReg(field)}\\b`).test(line)) continue;
          // Promote to syntactic only on real provider-surface evidence: the file
          // already touches API surfaces, or the line references this surface's
          // actual path. The mere presence of "api"/"http"/"charge" is not
          // evidence and no longer promotes confidence.
          const onSurfacePath = pathHints.some((h) => pathInLine(line, h));
          const source: CandidateSource =
            apiFiles.has(file.path) || onSurfacePath ? "syntactic" : "string_heuristic";
          add(acc, {
            filePath: file.path,
            lineStart: lineNo,
            lineEnd: lineNo,
            symbol: field,
            functionName: index.functions.find(
              (f) => f.filePath === file.path && lineNo >= f.lineStart && lineNo <= f.lineEnd,
            )?.name,
            evidence: line.trim(),
            source,
            surfaceId: surface.id,
            confidence: confFromSource(source, surface.severity === "breaking" || breaking),
          });
        }
        for (const hint of pathHints) {
          if (!hint || hint.length < 4) continue;
          if (!pathInLine(line, hint)) continue;
          if (!line.includes("/v") && !line.includes("http")) continue;
          add(acc, {
            filePath: file.path,
            lineStart: lineNo,
            lineEnd: lineNo,
            symbol: surface.path ?? hint,
            evidence: line.trim(),
            source: "syntactic",
            surfaceId: surface.id,
            confidence: confFromSource("syntactic", true),
          });
        }
      });
    }
  }

  // 3) Config heuristics
  for (const surface of surfaces) {
    for (const u of index.apiUsages) {
      if (u.kind !== "config") continue;
      add(acc, {
        filePath: u.filePath,
        lineStart: u.line,
        lineEnd: u.line,
        symbol: "config",
        functionName: u.functionName,
        evidence: u.value,
        source: "string_heuristic",
        surfaceId: surface.id,
        confidence: "low",
      });
    }
  }

  // 4) Import expansion — files importing packages that look like the provider
  const providerHints = surfaces.flatMap((s) => s.searchTokens).filter((t) => t.length > 2);
  for (const file of index.files) {
    const touchesVendor = file.imports.some((i) =>
      providerHints.some((h) => i.toLowerCase().includes(h.toLowerCase().split("/")[0] ?? "")),
    );
    if (!touchesVendor) continue;
    // Mark file-level candidate at first line of first function or line 1
    const fn = index.functions.find((f) => f.filePath === file.path);
    const line = fn?.lineStart ?? 1;
    for (const surface of surfaces.slice(0, 3)) {
      add(acc, {
        filePath: file.path,
        lineStart: line,
        lineEnd: line,
        symbol: file.imports[0] ?? "import",
        functionName: fn?.name,
        evidence: `import expansion: ${file.imports.join(", ")}`,
        source: "import_expansion",
        surfaceId: surface.id,
        confidence: confFromSource("import_expansion", false),
      });
    }
  }

  return [...acc.values()].sort((a, b) => {
    const rank = { high: 2, medium: 1, low: 0 };
    return rank[b.initialConfidence] - rank[a.initialConfidence];
  });
}
