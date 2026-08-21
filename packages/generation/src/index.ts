import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { graphPathDisplay } from "@mendpoint/shared";
import type {
  Confidence,
  GraphPath,
  ImpactFinding,
  ImpactReport,
  MigrationDraft,
  StructuralDiff,
} from "@mendpoint/shared";
import { migrateFromFixHint } from "@mendpoint/egraph";
import { WARDEN_PR_FOOTER } from "@mendpoint/branding";

/** GitHub rejects pull-request bodies longer than this many characters. */
const MAX_PR_BODY_CHARS = 65_536;
/** Cap on how many edit-site paths we enumerate before summarising the rest. */
const MAX_LISTED_FILES = 200;

/**
 * Final safety net: even after per-list caps, truncate the assembled body to
 * GitHub's hard limit and state, in words, that it was shortened — a silently
 * clipped body is worse than an explicit notice.
 */
function capBody(body: string): string {
  if (body.length <= MAX_PR_BODY_CHARS) return body;
  const notice = `\n\n_This PR body was truncated to stay under GitHub's ${MAX_PR_BODY_CHARS.toLocaleString("en-US")}-character limit; some detail above was omitted._`;
  return body.slice(0, MAX_PR_BODY_CHARS - notice.length) + notice;
}


export type GenerateInput = {
  providerName: string;
  providerSlug: string;
  change: StructuralDiff;
  findings: ImpactFinding[];
  repoRoot: string;
  docsUrl?: string;
  mode?: "migrate" | "adopt";
  /** Structured impact brief from hybrid analysis (preferred). */
  impactReport?: ImpactReport;
};

/**
 * One-line "why this file is affected" for a PR reviewer (FET-016): the
 * provider->code import chain, provider anchor first. Compact by design — the
 * reviewer wants the reachability evidence, not a graph dump. A bounded path
 * (cycle / hop cap) is labelled so a truncated chain never reads as the whole
 * story; only a zero-hop path that actually terminates at an anchor is direct
 * provider usage.
 */
function formatGraphPath(p: GraphPath): string {
  const d = graphPathDisplay(p);
  if (d.kind === "direct") {
    return `path: \`${d.node}\` (direct provider usage)`;
  }
  const suffix =
    d.bound === "cycle"
      ? " _(truncated at an import cycle)_"
      : d.bound === "no_anchor"
        ? " _(incomplete: no provider anchor reached)_"
        : d.bound === "max_hops"
          ? ` _(truncated at the ${d.hops}-hop limit)_`
          : "";
  return `path: ${d.nodes.join(" → ")}${suffix}`;
}

function overallConfidence(findings: ImpactFinding[]): Confidence {
  if (findings.length === 0) return "low";
  if (findings.some((f) => f.confidence === "low")) return "low";
  if (findings.every((f) => f.confidence === "high")) return "high";
  return "medium";
}

function applyRenames(text: string, change: StructuralDiff): string {
  let out = text;
  for (const e of change.entries) {
    if (e.op === "request_field_renamed" && e.fromField && e.toField) {
      const re = new RegExp(`\\b${escapeReg(e.fromField)}\\b`, "g");
      out = out.replace(re, e.toField);
      // JS/TS object shorthand and string keys
      out = out.replace(
        new RegExp(`(['"\`])${escapeReg(e.fromField)}\\1\\s*:`, "g"),
        `$1${e.toField}$1:`,
      );
      // Python kwargs
      out = out.replace(
        new RegExp(`\\b${escapeReg(e.fromField)}\\s*=`, "g"),
        `${e.toField}=`,
      );
    }
  }
  return out;
}

/** Apply fix hints from findings across files (coordinated multi-file). */
function applyFixHints(
  text: string,
  findings: ImpactFinding[],
  filePath: string,
): string {
  let out = text;
  for (const f of findings) {
    if (f.filePath !== filePath && !filePath.endsWith(f.filePath)) continue;
    if (!f.fixHint) continue;
    // Patterns like: rename X to Y / replace `a` with `b`
    const m =
      f.fixHint.match(/rename\s+[`']?(\w+)[`']?\s+to\s+[`']?(\w+)[`']?/i) ??
      f.fixHint.match(/replace\s+[`'](\w+)[`']\s+with\s+[`'](\w+)[`']/i);
    if (m) {
      out = out.replace(new RegExp(`\\b${escapeReg(m[1]!)}\\b`, "g"), m[2]!);
    }
  }
  return out;
}

function applyAdoptionHints(
  text: string,
  change: StructuralDiff,
  filePath: string,
): string {
  // For new_capability: add a short comment near matching imports/usages
  const adds = change.entries.filter(
    (e) => e.op === "path_added" || e.op === "method_added" || e.op === "response_field_added",
  );
  if (!adds.length) return text;
  const isPy = filePath.endsWith(".py");
  const comment = isPy ? "#" : "//";
  const banner = `${comment} mendpoint: consider adopting: ${adds
    .map((a) => a.path ?? a.field ?? a.op)
    .slice(0, 3)
    .join(", ")}`;
  if (text.includes("mendpoint: consider adopting")) return text;
  return `${banner}\n${text}`;
}

function annotateRemovals(text: string, change: StructuralDiff, filePath: string): string {
  const removedPaths = change.entries
    .filter((e) => e.op === "path_removed" || e.op === "method_removed")
    .map((e) => e.path)
    .filter(Boolean) as string[];
  if (!removedPaths.length) return text;

  const lines = text.split(/\r?\n/);
  const isPy = filePath.endsWith(".py");
  const comment = isPy ? "# " : "// ";
  const out: string[] = [];
  for (const line of lines) {
    const hit = removedPaths.some((p) => {
      const hint = p.replace(/\{[^}]+\}/g, "");
      return line.includes(hint) || line.includes(p);
    });
    if (hit) {
      out.push(
        `${comment}FIXME(mendpoint): endpoint removed in provider change — ${removedPaths.join(", ")}`,
      );
    }
    out.push(line);
  }
  return out.join("\n");
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type DiffOp = { type: "eq" | "del" | "ins"; line: string };

/**
 * Myers O(ND) shortest-edit-script trace. Fast when the edit distance is small
 * (the common case: a handful of renamed lines inside a large file), so a
 * one-token change in a 2,000-line file explores only a few diagonals.
 */
function shortestEditTrace(a: string[], b: string[]): Map<number, number>[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= n && y >= m) return trace;
    }
  }
  return trace;
}

/** Backtrack the Myers trace into an ordered edit script over lines. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const trace = shortestEditTrace(a, b);
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "eq", line: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: "ins", line: b[y - 1]! });
      } else {
        ops.push({ type: "del", line: a[x - 1]! });
      }
      x = prevX;
      y = prevY;
    }
  }
  ops.reverse();
  return ops;
}

const DIFF_CONTEXT = 3;

type PositionedOp = DiffOp & { aIdx: number; bIdx: number };

/**
 * Emit a valid unified diff with correctly-numbered `@@` hunk headers and
 * `DIFF_CONTEXT` lines of surrounding context. Changes closer than 2×context
 * apart are merged into a single hunk (standard behaviour), so the output is
 * what `git apply` accepts — not a full-file rewrite.
 */
export function unifiedDiff(path: string, original: string, updated: string): string {
  if (original === updated) return "";
  const a = original.split(/\r?\n/);
  const b = updated.split(/\r?\n/);
  const ops = diffLines(a, b);

  // Annotate each op with its 0-based line index in a and/or b.
  const positioned: PositionedOp[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op.type === "eq") {
      positioned.push({ ...op, aIdx: ai, bIdx: bi });
      ai += 1;
      bi += 1;
    } else if (op.type === "del") {
      positioned.push({ ...op, aIdx: ai, bIdx: -1 });
      ai += 1;
    } else {
      positioned.push({ ...op, aIdx: -1, bIdx: bi });
      bi += 1;
    }
  }

  const changed = positioned
    .map((op, idx) => (op.type === "eq" ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (!changed.length) return "";

  // Group changed ops into hunks, merging runs within 2×context of each other.
  const groups: Array<[number, number]> = [];
  let start = changed[0]!;
  let end = changed[0]!;
  for (let i = 1; i < changed.length; i++) {
    const c = changed[i]!;
    if (c - end - 1 > DIFF_CONTEXT * 2) {
      groups.push([start, end]);
      start = c;
    }
    end = c;
  }
  groups.push([start, end]);

  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [gStart, gEnd] of groups) {
    const hunkStart = Math.max(0, gStart - DIFF_CONTEXT);
    const hunkEnd = Math.min(positioned.length - 1, gEnd + DIFF_CONTEXT);
    const slice = positioned.slice(hunkStart, hunkEnd + 1);

    let aLines = 0;
    let bLines = 0;
    let aStart = 0;
    let bStart = 0;
    const body: string[] = [];
    for (const op of slice) {
      if (op.type === "eq") {
        if (aLines === 0) aStart = op.aIdx + 1;
        if (bLines === 0) bStart = op.bIdx + 1;
        aLines += 1;
        bLines += 1;
        body.push(` ${op.line}`);
      } else if (op.type === "del") {
        if (aLines === 0) aStart = op.aIdx + 1;
        aLines += 1;
        body.push(`-${op.line}`);
      } else {
        if (bLines === 0) bStart = op.bIdx + 1;
        bLines += 1;
        body.push(`+${op.line}`);
      }
    }
    // A hunk with zero lines on a side anchors at the preceding line (count 0).
    if (aLines === 0) aStart = hunkStart > 0 ? (positioned[hunkStart - 1]?.aIdx ?? -1) + 1 : 0;
    if (bLines === 0) bStart = hunkStart > 0 ? (positioned[hunkStart - 1]?.bIdx ?? -1) + 1 : 0;

    out.push(`@@ -${aStart},${aLines} +${bStart},${bLines} @@`);
    out.push(...body);
  }
  return out.join("\n");
}

export function generateMigration(input: GenerateInput): MigrationDraft {
  const {
    providerName,
    providerSlug,
    change,
    findings,
    repoRoot,
    docsUrl = `https://docs.example.com/${providerSlug}`,
  } = input;

  const files = [...new Set(findings.map((f) => f.filePath))];
  const fileEdits: MigrationDraft["fileEdits"] = [];
  const patches: string[] = [];

  const mode = input.mode ?? (change.risk === "new_capability" ? "adopt" : "migrate");

  for (const rel of files) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const original = readFileSync(abs, "utf8");
    let updated = applyRenames(original, change);
    updated = applyFixHints(updated, findings, rel);
    updated = annotateRemovals(updated, change, rel);
    if (mode === "adopt") {
      updated = applyAdoptionHints(updated, change, rel);
    }
    if (updated !== original) {
      fileEdits.push({ path: rel, original, updated });
      const d = unifiedDiff(rel, original, updated);
      if (d) patches.push(d);
    }
  }

  // Coordinated: also touch sibling files that share renamed symbols even if not in findings
  // (already multi-file via unique finding paths; ensure related test files get renames)
  for (const rel of files) {
    const testCandidates = [
      rel.replace(/\.ts$/, ".test.ts"),
      rel.replace(/\.ts$/, ".spec.ts"),
      rel.replace(/\.py$/, "_test.py"),
    ];
    for (const trel of testCandidates) {
      if (fileEdits.some((e) => e.path === trel)) continue;
      const abs = join(repoRoot, trel);
      if (!existsSync(abs)) continue;
      const original = readFileSync(abs, "utf8");
      let updated = applyRenames(original, change);
      updated = applyFixHints(updated, findings, trel);
      if (updated !== original) {
        fileEdits.push({ path: trel, original, updated });
        const d = unifiedDiff(trel, original, updated);
        if (d) patches.push(d);
      }
    }
  }

  const report = input.impactReport;
  // Display confidence keeps the honest "unknown" value from the report (an
  // empty result under incomplete coverage). The migration draft, however,
  // carries a three-value Confidence, so "unknown" floors to "low" there — an
  // uncertain result must never be packaged as anything stronger.
  const confidence = report?.overallConfidence ?? overallConfidence(findings);
  const draftConfidence: Confidence = confidence === "unknown" ? "low" : confidence;
  const coverage = report?.coverage;
  const risk = report?.overallRisk ?? change.risk;
  const short = change.summary.slice(0, 72);
  const verb = mode === "adopt" ? "adopt" : "migrate";
  const title = `mendpoint: ${verb} ${providerName} — ${risk}`;
  const branchName = `mendpoint/${providerSlug}-${Date.now().toString(36)}`;

  // E-graph migration exploration (localized) for PR evidence
  const egraphNotes: string[] = [];
  for (const f of findings.slice(0, 8)) {
    if (!f.fixHint) continue;
    const explored = migrateFromFixHint(f.fixHint);
    if (explored && explored.appliedRules.length) {
      egraphNotes.push(
        `- \`${f.symbol}\`: rules [${explored.appliedRules.join(", ")}] · extracted \`${explored.extracted}\``,
      );
    }
  }

  const fullBody = [
    `## ${providerName} API ${mode === "adopt" ? "feature adoption" : "migration"}`,
    "",
    `**Risk:** \`${risk}\`  `,
    `**Confidence:** \`${confidence}\`  `,
    coverage
      ? `**Coverage:** \`${coverage.basis}\`${coverage.reason ? ` — ${coverage.reason}` : ""}  `
      : "",
    `**Mode:** \`${mode}\`  `,
    `**Files edited:** **${fileEdits.length}**  `,
    `**Agent policy:** opens a PR only — never commits to protected branches.`,
    "",
    "### Summary",
    change.summary,
    "",
    report
      ? [
          "### Impact analysis",
          report.strategySummary,
          "",
          `- Candidates discovered: **${report.candidateCount}**`,
          `- Confirmed sites: **${report.confirmedCount}**`,
          `- Low-confidence notifications: **${report.lowConfidenceNotifications.length}**`,
          ...(report.coverage
            ? [
                `- Coverage: **${report.coverage.basis}**` +
                  (report.coverage.filesInspected !== undefined
                    ? ` — ${report.coverage.filesInspected} file(s) inspected` +
                      (report.coverage.languagesSupported && report.coverage.languagesPresent
                        ? `; languages present: ${report.coverage.languagesPresent.join(", ") || "none"}; supported: ${report.coverage.languagesSupported.join(", ")}`
                        : "")
                    : ""),
                ...(report.coverage.gaps.length
                  ? [
                      "",
                      "**Not verified (coverage gaps):**",
                      ...report.coverage.gaps.map(
                        (g) => `- \`${g.reason}\`: ${g.detail}`,
                      ),
                    ]
                  : report.coverage.basis === "analyzed"
                    ? ["", "_Full coverage: this is complete evidence, not merely an empty result._"]
                    : []),
              ]
            : []),
          "",
          "### Impactable surfaces (sample)",
          ...report.surfaces.slice(0, 8).map(
            (s) =>
              `- \`${s.canonicalId}\` (${s.severity}) — ${s.migrationStrategy}`,
          ),
          "",
        ].join("\n")
      : "",
    "### Provider docs",
    docsUrl,
    "",
    "### Confirmed edit sites",
    ...(files.length
      ? [
          ...files.slice(0, MAX_LISTED_FILES).map((f) => `- \`${f}\``),
          ...(files.length > MAX_LISTED_FILES
            ? [
                `- _…and **${files.length - MAX_LISTED_FILES}** more file(s) omitted to keep this PR body under GitHub's ${MAX_PR_BODY_CHARS.toLocaleString("en-US")}-character limit._`,
              ]
            : []),
        ]
      : ["- _(no high-confidence call sites)_"]),
    "",
    "### Evidence",
    ...findings.slice(0, 20).map(
      (f) =>
        `- \`${f.filePath}:${f.lineStart}\` **${f.symbol}** (${f.confidence}${f.impactType ? `, ${f.impactType}` : ""}) — \`${f.evidence.slice(0, 100)}\`${f.fixHint ? `\n  - fix: ${f.fixHint}` : ""}${f.graphPath ? `\n  - ${formatGraphPath(f.graphPath)}` : ""}`,
    ),
    "",
    "### What changed in the patch",
    "- Renamed request fields where structural rename was detected",
    "- Marked removed endpoint usages with `FIXME(mendpoint)` for human follow-up",
    "",
    ...(egraphNotes.length
      ? [
          "### E-graph migration exploration",
          "_Non-destructive equality saturation over localized API patterns (complements call-graph impact)._",
          ...egraphNotes,
          "",
        ]
      : []),
    "### Review checklist",

    "- [ ] CI green",
    "- [ ] Business logic still correct after field renames",
    "- [ ] Removed endpoints replaced with supported alternatives",
    "",
    WARDEN_PR_FOOTER,
    `_Change summary: ${short}_`,
  ]
    .filter((x) => x !== "")
    .join("\n");

  const body = capBody(fullBody);

  return {
    title,
    body,
    branchName,
    patch: patches.join("\n\n"),
    risk,
    confidence: draftConfidence,
    fileEdits,
  };
}
