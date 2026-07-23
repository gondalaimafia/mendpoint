import {
  createDb,
  getConsumer,
  getConsumerRepo,
  getProviderBySlug,
  listMonitoredForProvider,
  listVersionsForProvider,
  getPoliciesMap,
  getPr,
  insertSuppressedPattern,
  isPatternSuppressed,
  recordAudit,
  insertApiChange,
  insertImpactFinding,
  insertMigrationPr,
  updateMigrationPrStatus,
  type AppDb,
} from "@mendpoint/db";

import { normalizeChange } from "@mendpoint/change-intel";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import { generateMigration } from "@mendpoint/generation";
import { createGitHubDelivery, type GitHubDelivery } from "@mendpoint/github";
import { evaluatePolicy, type PolicyConfig } from "@mendpoint/policy";
import {
  applyBrandPack,
  getBrandPack,
  getBrandPackForProvider,
} from "@mendpoint/branding";
import { runRepairSession } from "@mendpoint/repair";
import {
  newId,
  nowIso,
  type ImpactReport,
  type StructuralDiff,
} from "@mendpoint/shared";


export type PipelineInput = {
  providerSlug: string;
  fromVersionLabel?: string;
  toVersionLabel?: string;
  consumerIds?: string[];
  db?: AppDb;
  github?: GitHubDelivery;
  persistIndex?: boolean;
  /** First-party brand pack id, or true to auto-pick by provider */
  brandPackId?: string | true;
  /** Provider rollout severity override */
  severity?: "required" | "recommended" | "optional";
  /** Force notification-only (no PR) for this run */
  notificationsOnly?: boolean;
  /** migrate | adopt — default from change risk */
  mode?: "migrate" | "adopt";
  /**
   * Run agentic repair on consumer repo after draft edits (before/alongside PR).
   * Env: AGENTIC_REPAIR=1 also enables.
   */
  agenticRepair?: boolean;
  repairVerifyCommands?: string[];
};

export type PipelineReport = {
  changeId: string;
  risk: string;
  summary: string;
  diff: StructuralDiff;
  surfaces: number;
  consumers: Array<{
    consumerId: string;
    name: string;
    findings: number;
    candidates: number;
    confirmed: number;
    overallConfidence?: string;
    prId?: string;
    prStatus?: string;
    prUrl?: string;
    impactReport?: ImpactReport;
    repair?: {
      sessionId: string;
      ok: boolean;
      attempts: number;
      edits: number;
    };
  }>;
};

/**
 * Core product loop aligned to impact architecture:
 * Change Normalizer → Index → Candidates → Expand → Confirm → Generate PR
 */
export async function runChangePipeline(input: PipelineInput): Promise<PipelineReport> {
  const db = input.db ?? createDb();
  const github = input.github ?? createGitHubDelivery();

  const provider = getProviderBySlug(db, input.providerSlug);
  if (!provider) throw new Error(`Unknown provider: ${input.providerSlug}`);

  const versions = listVersionsForProvider(db, provider.id);
  if (versions.length < 2) {
    throw new Error(`Provider ${input.providerSlug} needs at least 2 API versions`);
  }

  const from =
    (input.fromVersionLabel
      ? versions.find((v) => v.version_label === input.fromVersionLabel)
      : versions[versions.length - 2]) ?? versions[versions.length - 2];
  const to =
    (input.toVersionLabel
      ? versions.find((v) => v.version_label === input.toVersionLabel)
      : versions[versions.length - 1]) ?? versions[versions.length - 1];

  const oldSpec = JSON.parse(from.openapi_json);
  const newSpec = JSON.parse(to.openapi_json);

  // Stage 0–1: Structured Change Normalizer → Impactable Surfaces
  const { diff, surfaces } = normalizeChange(oldSpec, newSpec, {
    providerSlug: provider.slug,
    providerNotes: to.changelog_md ?? undefined,
  });

  const changeId = newId();
  const severity =
    input.severity ??
    (diff.risk === "breaking" ? "required" : diff.risk === "new_capability" ? "optional" : "recommended");

  insertApiChange(db, {
    id: changeId,
    providerId: provider.id,
    fromVersionId: from.id,
    toVersionId: to.id,
    risk: diff.risk,
    summary: diff.summary,
    severity,
    diffJson: JSON.stringify({ ...diff, surfaces, severity }),
    createdAt: nowIso(),
  });

  recordAudit(db, {
    actor: "pipeline",
    action: "change.normalized",
    resourceType: "api_change",
    resourceId: changeId,
    metadata: {
      risk: diff.risk,
      summary: diff.summary,
      surfaceCount: surfaces.length,
    },
  });

  let monitored = listMonitoredForProvider(db, provider.id);
  if (input.consumerIds?.length) {
    monitored = monitored.filter((m) => input.consumerIds!.includes(m.consumer_id));
  }

  const report: PipelineReport = {
    changeId,
    risk: diff.risk,
    summary: diff.summary,
    diff,
    surfaces: surfaces.length,
    consumers: [],
  };

  for (const mon of monitored) {
    const consumer = getConsumer(db, mon.consumer_id);
    const repo = getConsumerRepo(db, mon.consumer_id);
    if (!consumer || !repo) continue;

    // Stages 2–6: Index → Candidates → Expand → Confirm → ImpactReport
    const impactReport = await analyzeImpact(repo.local_path, surfaces, {
      persistIndex: input.persistIndex ?? true,
    });

    const rawFindings = reportToFindings(impactReport);
    // Phase C: feedback learning — drop suppressed patterns (closed PRs taught us)
    const findings = rawFindings.filter((f) => {
      const keys = [f.symbol, f.filePath, f.fixHint ?? "", ...(f.relatedOps ?? [])];
      return !keys.some((k) =>
        k
          ? isPatternSuppressed(db, k, {
              consumerId: consumer.id,
              providerSlug: provider.slug,
            })
          : false,
      );
    });
    const suppressedCount = rawFindings.length - findings.length;
    for (const f of findings) {
      insertImpactFinding(db, {
        id: newId(),
        changeId,
        consumerId: consumer.id,
        filePath: f.filePath,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        symbol: f.symbol,
        confidence: f.confidence,
        evidenceJson: JSON.stringify(f),
      });
    }


    recordAudit(db, {
      actor: "pipeline",
      action: "impact.analyzed",
      resourceType: "consumer",
      resourceId: consumer.id,
      metadata: {
        changeId,
        findings: findings.length,
        suppressedByLearning: suppressedCount,
        candidates: impactReport.candidateCount,
        confirmed: impactReport.confirmedCount,
        lowNotifications: impactReport.lowConfidenceNotifications.length,
        overallConfidence: impactReport.overallConfidence,
      },
    });


    const hasActionable = findings.length > 0 && impactReport.overallConfidence !== "low";
    const mode =
      input.mode ??
      (diff.risk === "new_capability" || severity === "optional" ? "adopt" : "migrate");
    let draft = generateMigration({
      providerName: provider.name,
      providerSlug: provider.slug,
      change: diff,
      findings,
      repoRoot: repo.local_path,
      impactReport,
      mode,
    });

    // Phase E: first-party branded packaging (optional)
    const brandPack =
      input.brandPackId === true
        ? getBrandPackForProvider(provider.slug)
        : typeof input.brandPackId === "string"
          ? getBrandPack(input.brandPackId)
          : process.env.BRAND_PACK === "auto"
            ? getBrandPackForProvider(provider.slug)
            : process.env.BRAND_PACK
              ? getBrandPack(process.env.BRAND_PACK)
              : undefined;
    let brandLabels: string[] = [];
    if (brandPack) {
      const branded = applyBrandPack(brandPack, { title: draft.title, body: draft.body });
      draft = { ...draft, title: branded.title, body: branded.body };
      brandLabels = branded.labels;
    }

    // Phase B: policy engine — never auto-merge; denylist paths; auth labels
    const policyMap = getPoliciesMap(db, consumer.id);
    const policyOverrides: Partial<PolicyConfig> = {};
    if (policyMap.auto_merge_low_risk === true) policyOverrides.autoMergeLowRisk = true;
    if (Array.isArray(policyMap.never_touch_paths)) {
      policyOverrides.neverTouchPaths = policyMap.never_touch_paths as string[];
    }
    if (policyMap.notifications_only === true || input.notificationsOnly === true) {
      policyOverrides.notificationsOnly = true;
    }
    // Optional severity: never force PR for optional without findings of medium+
    if (severity === "optional" && impactReport.overallConfidence === "low") {
      policyOverrides.notificationsOnly = true;
    }

    const decision = evaluatePolicy(draft, findings, {
      policy: policyOverrides,
      risk: draft.risk,
    });

    const allLabels = [...new Set([...decision.labels, ...brandLabels])];

    recordAudit(db, {
      actor: "pipeline",
      action: "policy.evaluated",
      resourceType: "consumer",
      resourceId: consumer.id,
      metadata: {
        allowPr: decision.allowPr,
        allowAutoMerge: decision.allowAutoMerge,
        blockedFiles: decision.blockedFiles,
        labels: allLabels,
        brandPackId: brandPack?.id ?? null,
        reasons: decision.reasons,
      },
    });

    // Enforce: never claim auto-merge in PR body
    const prBody = [
      draft.body,
      "",
      "### Policy",
      `- **Severity:** ${severity}`,
      `- **Auto-merge:** ${decision.allowAutoMerge ? "eligible" : "disabled (default)"}`,
      ...decision.reasons.map((r) => `- ${r}`),
      decision.blockedFiles.length
        ? `- **Blocked paths:** ${decision.blockedFiles.join(", ")}`
        : "",
      `- **Labels:** ${allLabels.join(", ")}`,
      brandPack ? `- **Brand pack:** ${brandPack.displayName}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let status: string = hasActionable && decision.allowPr ? "open" : "low_confidence";
    let prUrl: string | undefined;
    let prNumber: number | undefined;
    let prBodyFinal = prBody;

    // Build rename map from structural diff for agentic repair
    const renameMap: Record<string, string> = {};
    for (const e of diff.entries) {
      if (e.op === "request_field_renamed" && e.fromField && e.toField) {
        renameMap[e.fromField] = e.toField;
      }
    }

    let repairMeta: { sessionId: string; ok: boolean; attempts: number; edits: number } | undefined;
    const wantRepair =
      input.agenticRepair === true ||
      process.env.AGENTIC_REPAIR === "1" ||
      process.env.AGENTIC_REPAIR === "true";

    if (
      wantRepair &&
      !policyOverrides.notificationsOnly &&
      decision.allowedEdits.length > 0
    ) {
      // Write draft edits to working tree first so repair sees post-migration state
      const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
      const { dirname, join } = await import("node:path");
      for (const ed of decision.allowedEdits) {
        const abs = join(repo.local_path, ed.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, ed.updated, "utf8");
      }
      try {
        const repair = await runRepairSession({
          repoRoot: repo.local_path,
          renameMap,
          maxAttempts: Number(process.env.AGENTIC_REPAIR_ATTEMPTS ?? 3),
          verifyCommands: input.repairVerifyCommands ?? [],
          useLlm: process.env.LLM_REPAIR === "1",
        });
        repairMeta = {
          sessionId: repair.sessionId,
          ok: repair.ok,
          attempts: repair.attempts,
          edits: repair.edits.length,
        };
        // Refresh allowed edits from disk after repair
        for (const ed of decision.allowedEdits) {
          const abs = join(repo.local_path, ed.path);
          try {
            ed.updated = readFileSync(abs, "utf8");
          } catch {
            /* keep */
          }
        }
        for (const re of repair.edits) {
          if (!decision.allowedEdits.some((e) => e.path === re.filePath)) {
            decision.allowedEdits.push({
              path: re.filePath,
              original: re.original,
              updated: re.updated,
            });
          }
        }
        prBodyFinal = [prBody, "", repair.reportMarkdown].join("\n");
        recordAudit(db, {
          actor: "repair",
          action: repair.ok ? "repair.ok" : "repair.failed",
          resourceType: "consumer",
          resourceId: consumer.id,
          metadata: repairMeta,
        });
      } catch (e) {
        recordAudit(db, {
          actor: "repair",
          action: "repair.error",
          resourceType: "consumer",
          resourceId: consumer.id,
          metadata: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    if (
      hasActionable &&
      decision.allowPr &&
      decision.allowedEdits.length > 0 &&
      !policyOverrides.notificationsOnly
    ) {
      await github.createBranch(
        consumer.github_owner,
        consumer.github_repo,
        draft.branchName,
      );
      await github.commitFiles(
        consumer.github_owner,
        consumer.github_repo,
        draft.branchName,
        draft.title,
        decision.allowedEdits.map((e) => ({ path: e.path, content: e.updated })),
      );
      const pr = await github.openPullRequest(
        consumer.github_owner,
        consumer.github_repo,
        draft.branchName,
        draft.title,
        prBodyFinal,
        repo.default_branch,
      );
      prUrl = pr.url;
      prNumber = pr.number;
      status = "open";
    } else if (policyOverrides.notificationsOnly) {
      status = "notification_only";
      recordAudit(db, {
        actor: "pipeline",
        action: "pipeline.notification_only",
        resourceType: "consumer",
        resourceId: consumer.id,
        metadata: { changeId, findings: findings.length, severity },
      });
    } else if (!decision.allowPr || !hasActionable) {
      status = "low_confidence";
    }


    const prId = newId();
    insertMigrationPr(db, {
      id: prId,
      changeId,
      consumerId: consumer.id,
      title: draft.title,
      body: prBodyFinal,
      branchName: draft.branchName,
      status,
      risk: draft.risk,
      patchUnified: draft.patch,
      githubPrNumber: prNumber ?? null,
      githubPrUrl: prUrl ?? null,
      createdAt: nowIso(),
      resolvedAt: null,
    });

    recordAudit(db, {
      actor: "pipeline",
      action:
        status === "low_confidence"
          ? "pr.low_confidence"
          : status === "notification_only"
            ? "pr.notification_only"
            : "pr.opened",
      resourceType: "migration_pr",
      resourceId: prId,
      metadata: {
        prUrl,
        findings: findings.length,
        strategy: impactReport.strategySummary,
        repair: repairMeta ?? null,
      },
    });

    report.consumers.push({
      consumerId: consumer.id,
      name: consumer.name,
      findings: findings.length,
      candidates: impactReport.candidateCount,
      confirmed: impactReport.confirmedCount,
      overallConfidence: impactReport.overallConfidence,
      prId,
      prStatus: status,
      prUrl,
      impactReport,
      repair: repairMeta,
    });
  }

  return report;
}

export async function applyPrFeedback(
  db: AppDb,
  prId: string,
  outcome: "merged" | "closed" | "modified",
) {
  const status = outcome === "modified" ? "open" : outcome;
  const resolvedAt = outcome === "merged" || outcome === "closed" ? nowIso() : null;
  updateMigrationPrStatus(db, prId, status, resolvedAt);
  recordAudit(db, {
    actor: "consumer",
    action: `pr.feedback.${outcome}`,
    resourceType: "migration_pr",
    resourceId: prId,
  });

  // Phase C learning: closed PRs suppress similar symbols for this consumer
  if (outcome === "closed") {
    const pr = getPr(db, prId);
    if (pr) {
      const patterns = extractPatternsFromPrBody(pr.body);
      for (const pattern of patterns) {
        insertSuppressedPattern(db, {
          id: newId(),
          consumerId: pr.consumer_id,
          pattern,
          reason: "closed_pr_feedback",
          sourcePrId: prId,
          createdAt: nowIso(),
        });
      }
      recordAudit(db, {
        actor: "learning",
        action: "patterns.suppressed",
        resourceType: "migration_pr",
        resourceId: prId,
        metadata: { patterns, count: patterns.length },
      });
    }
  }
}

/** Pull symbol-like tokens from PR evidence lines for suppression. */
export function extractPatternsFromPrBody(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\*\*([^*]+)\*\*/g)) {
    const t = m[1]!.trim();
    if (t.length >= 3 && t.length < 80 && !/risk|confidence|agent/i.test(t)) {
      out.add(t);
    }
  }
  for (const m of body.matchAll(/`([^`]{3,60})`/g)) {
    const t = m[1]!;
    if (/amount_|max_tokens|starting_after|X-API|\/v\d+|charges\.|customers\./i.test(t)) {
      out.add(t);
    }
  }
  return [...out].slice(0, 20);
}

