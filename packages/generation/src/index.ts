import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Confidence,
  ImpactFinding,
  ImpactReport,
  MigrationDraft,
  StructuralDiff,
} from "@mendpoint/shared";
import { migrateFromFixHint } from "@mendpoint/egraph";
import { WARDEN_PR_FOOTER } from "@mendpoint/branding";


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

function unifiedDiff(path: string, original: string, updated: string): string {
  if (original === updated) return "";
  const a = original.split(/\r?\n/);
  const b = updated.split(/\r?\n/);
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`];
  // Simple full-file hunk for MVP clarity
  for (const line of a) lines.push(`-${line}`);
  for (const line of b) lines.push(`+${line}`);
  return lines.join("\n");
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
  const confidence = report?.overallConfidence ?? overallConfidence(findings);
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

  const body = [
    `## ${providerName} API ${mode === "adopt" ? "feature adoption" : "migration"}`,
    "",
    `**Risk:** \`${risk}\`  `,
    `**Confidence:** \`${confidence}\`  `,
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
    ...(files.length ? files.map((f) => `- \`${f}\``) : ["- _(no high-confidence call sites)_"]),
    "",
    "### Evidence",
    ...findings.slice(0, 20).map(
      (f) =>
        `- \`${f.filePath}:${f.lineStart}\` **${f.symbol}** (${f.confidence}${f.impactType ? `, ${f.impactType}` : ""}) — \`${f.evidence.slice(0, 100)}\`${f.fixHint ? `\n  - fix: ${f.fixHint}` : ""}`,
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


  return {
    title,
    body,
    branchName,
    patch: patches.join("\n\n"),
    risk,
    confidence,
    fileEdits,
  };
}
