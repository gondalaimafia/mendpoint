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
import type { CodebaseIndex, FileRecord } from "@mendpoint/codebase-index";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProviderReachability } from "./lang-import-graph.js";

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

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/**
 * Whether `field` appears as a genuine field *reference* on `line`, as opposed to
 * a word that merely sits inside a prose comment or a free-text string. A
 * field-rename tool edits code references (`data.source`, `source:`, a
 * destructured `source`) and structured wire tokens (a Go struct tag
 * `json:"source"`, a Java `@JsonProperty("source")`, a JS field id
 * `new ValidationError(..., 'source')`) — but not the word "source" inside a log
 * message or a sentence.
 *
 * We walk the line tracking string state and stopping at the line's comment
 * marker. A whole-word match reached in code is genuine. A whole-word match
 * reached inside a string is genuine only when it is a discrete quoted/structural
 * token (not flanked by whitespace) — the shape of a wire key, tag, or field id
 * — and prose when it is flanked by a space, the shape of a word in a sentence.
 * The match is case-insensitive so a Go/Java field (`e.Source`,
 * `Source: req.Source`) counts even though the wire token the change carries is
 * lower-case. This is the discriminator that separates `bin/server.js`'s
 * `'loaded configuration source ...'` log string from a real `source` reference,
 * without a blanket "strings never count" rule that would drop a Go/Java wire
 * field carried in a string literal or a capitalised field the case-sensitive
 * candidate scan never saw as code.
 *
 * Comment and string syntax is language-aware: Python uses `#` line comments and
 * has no back-quote string, while JS/TS/Go/Java use `//` and (except Java) a
 * back-quote string. Getting this wrong reads a Javadoc `{@link #member}` as a
 * comment or a Python `//` floor-division as one, silently dropping real fields.
 */
function sourceHasGenuineReference(
  text: string,
  field: string,
  language: FileRecord["language"],
): boolean {
  const lower = field.toLowerCase();
  const matchesAt = (i: number): boolean =>
    text.slice(i, i + field.length).toLowerCase() === lower;
  const firstLower = lower[0]!;
  const hashComments = language === "python" || language === "ruby";
  const slashComments = !hashComments;
  const backtickStrings =
    language === "javascript" || language === "typescript" || language === "go";
  const tripleQuoted = language === "python";
  let inString: { quote: string; width: 1 | 3 } | null = null;
  let inBlockComment = false;
  let inLineComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && text[i + 1] === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (
        c === inString.quote &&
        (inString.width === 1 || text.slice(i, i + 3) === inString.quote.repeat(3))
      ) {
        i += inString.width - 1;
        inString = null;
        continue;
      }
      if (c.toLowerCase() === firstLower && matchesAt(i)) {
        const before = text[i - 1] ?? "";
        const after = text[i + field.length] ?? "";
        if (!isWordChar(before) && !isWordChar(after)) {
          // Discrete quoted/structural token (wire key, tag, field id) is a real
          // reference; a token flanked by whitespace is a word in running text.
          if (!/\s/.test(before) && !/\s/.test(after)) return true;
        }
        i += field.length - 1;
      }
      continue;
    }
    if (hashComments && c === "#") {
      inLineComment = true;
      continue;
    }
    if (slashComments && c === "/" && text[i + 1] === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (slashComments && c === "/" && text[i + 1] === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || (backtickStrings && c === "`")) {
      const width = tripleQuoted && text.slice(i, i + 3) === c.repeat(3) ? 3 : 1;
      inString = { quote: c, width };
      i += width - 1;
      continue;
    }
    if (c.toLowerCase() === firstLower && matchesAt(i)) {
      const before = i === 0 ? "" : text[i - 1]!;
      const after = text[i + field.length] ?? "";
      if (!isWordChar(before) && !isWordChar(after)) return true; // code identifier
      i += field.length - 1;
    }
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

/**
 * Files carrying a first-class provider signal for this change: an HTTP path
 * that matches the changed surface, or an import of the provider package. These
 * anchor provider provenance — provider-reachable files are the ones that
 * transitively import an anchor.
 */
function providerAnchors(
  index: CodebaseIndex,
  surfaces: ImpactableSurface[],
): Set<string> {
  const anchors = new Set<string>();
  const pathHints = surfaces
    .flatMap((s) => (s.path ? [s.path, s.path.replace(/\{[^}]+\}/g, "")] : []))
    .filter(Boolean) as string[];
  for (const u of index.apiUsages) {
    if (u.kind === "http_path" && pathHints.some((h) => pathMatchesUsage(h, u.value))) {
      anchors.add(u.filePath);
    }
  }
  // Provider package imports. Derive hints from the surface slug only (not
  // resource names like "charges", which collide with local modules such as
  // `../db/charges`).
  const importHints = [
    ...new Set(
      surfaces.flatMap((s) =>
        (s.canonicalId.split(".")[0] ?? "")
          .split(/[^A-Za-z0-9]+/)
          .map((p) => p.toLowerCase())
          .filter((p) => p.length >= 3 && p !== "api"),
      ),
    ),
  ];
  if (importHints.length) {
    for (const f of index.files) {
      if (
        f.imports.some((i) => {
          // Package imports only. A relative specifier that merely contains the
          // slug (e.g. `../providers/meridian/signing`) is an internal module,
          // not the provider package, and must not anchor provenance.
          if (i.startsWith(".")) return false;
          const spec = i.toLowerCase();
          return importHints.some((h) => spec === h || spec.endsWith(`/${h}`) || spec.includes(h));
        })
      ) {
        anchors.add(f.path);
      }
    }
  }
  return anchors;
}

export function discoverCandidates(
  index: CodebaseIndex,
  allSurfaces: ImpactableSurface[],
): CandidateSite[] {
  const acc: Acc = new Map();
  // Ambiguous field changes have more than one plausible successor. The tool
  // abstains on them: they never drive confident candidate discovery or edits.
  // They are surfaced separately as a human-decision outcome.
  const surfaces = allSurfaces.filter(
    (s) =>
      s.op !== "request_field_ambiguous" && s.op !== "response_field_ambiguous",
  );
  const breaking = surfaces.some((s) => s.severity === "breaking");

  // Provider provenance. A field-name or SDK-call match only earns a confident
  // tier when the file can reach the provider surface through imports. Anchors
  // that we cannot locate (no HTTP path, no vendor package) leave `gateEnabled`
  // false, so confidence falls back to the token match — absence of a locatable
  // surface degrades precision, never recall.
  const anchors = providerAnchors(index, surfaces);
  const { reachable } = buildProviderReachability(index.files, index.repoRoot, anchors);
  const gateEnabled = anchors.size > 0;
  const gate = (
    filePath: string,
    source: CandidateSource,
    confidence: Confidence,
  ): { source: CandidateSource; confidence: Confidence } =>
    gateEnabled && !reachable.has(filePath)
      ? { source: "string_heuristic", confidence: "low" }
      : { source, confidence };

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
        const g = gate(
          u.filePath,
          heuristic ? "string_heuristic" : "sdk_graph",
          heuristic ? "low" : confFromSource("sdk_graph", surface.severity === "breaking"),
        );
        add(acc, {
          filePath: u.filePath,
          lineStart: u.line,
          lineEnd: u.line,
          symbol: u.value,
          functionName: u.functionName,
          evidence: u.value,
          source: g.source,
          surfaceId: surface.id,
          confidence: g.confidence,
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
        // A path found in a doc comment anchors provenance (handled in
        // providerAnchors) but is not itself an edit site — do not raise it to a
        // confident candidate.
        if (u.inComment) continue;
        for (const hint of pathHints) {
          if (pathMatchesUsage(hint, u.value)) {
            const g = gate(
              u.filePath,
              "syntactic",
              confFromSource("syntactic", surface.severity === "breaking"),
            );
            add(acc, {
              filePath: u.filePath,
              lineStart: u.line,
              lineEnd: u.line,
              symbol: surface.path ?? u.value,
              functionName: u.functionName,
              evidence: u.value,
              source: g.source,
              surfaceId: surface.id,
              confidence: g.confidence,
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
      // Per-field: does this file reference the field as real code / a wire token
      // anywhere, or only ever mention the word in prose? A provider-reachable
      // file that never genuinely references the field (only a log message or a
      // comment mentions it) is not an edit site — this is what lets the gate
      // demote `bin/server.js` without a blanket string/comment blacklist.
      const fileGenuine = new Map<string, boolean>();
      for (const field of fieldHints) {
        fileGenuine.set(
          field,
          sourceHasGenuineReference(text, field, file.language),
        );
      }
      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        for (const field of fieldHints) {
          if (!new RegExp(`\\b${escapeReg(field)}\\b`, "i").test(line)) continue;
          // Promote to syntactic only on real provider-surface evidence: the file
          // already touches API surfaces, or the line references this surface's
          // actual path. The mere presence of "api"/"http"/"charge" is not
          // evidence and no longer promotes confidence.
          const onSurfacePath = pathHints.some((h) => pathInLine(line, h));
          const rawSource: CandidateSource =
            apiFiles.has(file.path) || onSurfacePath ? "syntactic" : "string_heuristic";
          let g = gate(
            file.path,
            rawSource,
            confFromSource(rawSource, surface.severity === "breaking" || breaking),
          );
          // When provider provenance is established, a file that never
          // references this field in real code or a wire token — only mentions
          // the word in a log string or a comment — is not an edit site. Degrade
          // it like a non-reachable match. Gating stays off when no anchor is
          // locatable, so a token-only repo (e.g. deeply-indirected wrappers
          // whose provider signal is a comment) keeps its recall.
          if (gateEnabled && !fileGenuine.get(field)) {
            g = { source: "string_heuristic", confidence: "low" };
          }
          add(acc, {
            filePath: file.path,
            lineStart: lineNo,
            lineEnd: lineNo,
            symbol: field,
            functionName: index.functions.find(
              (f) => f.filePath === file.path && lineNo >= f.lineStart && lineNo <= f.lineEnd,
            )?.name,
            evidence: line.trim(),
            source: g.source,
            surfaceId: surface.id,
            confidence: g.confidence,
          });
        }
        // A path literal inside a doc/line comment documents an endpoint but is
        // not a code edit site; it anchors provenance elsewhere, not here.
        const lineIsComment = /^\s*(?:\/\/|\*|\/\*|#)/.test(line);
        for (const hint of pathHints) {
          if (lineIsComment) continue;
          if (!hint || hint.length < 4) continue;
          if (!pathInLine(line, hint)) continue;
          if (!line.includes("/v") && !line.includes("http")) continue;
          const g = gate(file.path, "syntactic", confFromSource("syntactic", true));
          add(acc, {
            filePath: file.path,
            lineStart: lineNo,
            lineEnd: lineNo,
            symbol: surface.path ?? hint,
            evidence: line.trim(),
            source: g.source,
            surfaceId: surface.id,
            confidence: g.confidence,
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

  // 4) Import expansion — files importing packages that look like the provider.
  // Match import specifiers against *meaningful* fragments of the change's
  // search tokens. Splitting a path token like "/v1/charges" on "/" yields a
  // leading empty segment; matching an import against "" made every file with
  // any import "touch vendor". Extract non-empty fragments (length >= 3) from
  // every token so the match is real.
  const importFragments = [
    ...new Set(
      surfaces
        .flatMap((s) => s.searchTokens)
        .flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/))
        .filter((frag) => frag.length >= 3),
    ),
  ];
  for (const file of index.files) {
    const touchesVendor = file.imports.some((i) => {
      const spec = i.toLowerCase();
      return importFragments.some((frag) => spec.includes(frag));
    });
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
