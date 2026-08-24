import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  createDb,
  createWardenCampaign,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  listWardenCampaignTargets,
  planWardenRollout,
  transitionWardenCampaign,
  type AppDb,
} from "@mendpoint/db";
import { ingestRepositoryEvidence, openGraphLearnMemory, type GraphLearnDb } from "@mendpoint/graph-learn";
import type { UnifiedSourceArtifact } from "@mendpoint/change-intel";
import { executeWardenCampaignTarget, type WardenCampaignExecutionDependencies } from "@mendpoint/pipeline";
import { fieldRenameRecipeDependencies } from "./warden-campaign-recipe.js";

const opened: Array<{ db: AppDb; graph: GraphLearnDb; dir: string }> = [];
const createdAt = "2026-08-02T14:00:00.000Z";
const resolvedSha = "a".repeat(40);
const manifestSha256 = "b".repeat(64);
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.raw.close();
    item.graph.raw.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-recipe-e2e-"));
  const snapshotRoot = join(dir, "snapshot");
  mkdirSync(join(snapshotRoot, "src"), { recursive: true });
  writeFileSync(join(snapshotRoot, "check.mjs"), "process.exit(0);\n", "utf8");
  // Real source the recipe will find and rewrite (amount_cents -> amount).
  writeFileSync(join(snapshotRoot, "src", "payments.ts"),
    "export function createCharge(amount_cents: number) {\n  return { amount_cents };\n}\n", "utf8");
  const db = createDb(join(dir, "warden.sqlite"));
  const graph = openGraphLearnMemory();
  opened.push({ db, graph, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`).run(createdAt);
  for (const [id, kind, subject, name] of [
    ["owner", "human", "owner@example.com", "Owner"],
    ["reviewer", "human", "reviewer@example.com", "Reviewer"],
    ["worker", "service", "warden-worker", "Warden worker"],
  ] as const) {
    insertPrincipal(db, { id, tenantId: "tenant-a", kind, subject, displayName: name, createdAt });
  }
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('connection', 'tenant-a', 'local_git', 'vault://connection', 'account', 'Local', ?, ?)`).run(createdAt, createdAt);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment,
     retention_days, status, created_at, updated_at)
    VALUES ('repo-a', 'tenant-a', 'connection', 'repo-a', 'acme', 'payments', 'main', 'main', 'test',
     30, 'ready', ?, ?)`).run(createdAt, createdAt);
  insertRepositorySnapshot(db, { id: "snapshot-a", tenantId: "tenant-a", repositoryId: "repo-a",
    requestedRef: "main", resolvedSha, manifestSha256, storagePath: snapshotRoot, createdAt,
    expiresAt: "2026-08-03T14:00:00.000Z" });
  insertRepositorySnapshotPolicy(db, { id: "snapshot-policy", tenantId: "tenant-a", snapshotId: "snapshot-a",
    codeowners: { "src/**": ["@payments"] }, ciFiles: [".github/workflows/ci.yml"],
    verificationCommands: ["node check.mjs"], protectedBranch: { name: "main" }, createdAt });
  createWardenCampaign(db, { id: "campaign-a", tenantId: "tenant-a", name: "Payments update",
    ownerPrincipalId: "owner", concurrencyLimit: 1, completionPolicy: "all", eventId: "campaign-created",
    idempotencyKey: "campaign-created", correlationId: "campaign-a", createdAt });
  addWardenCampaignTarget(db, { id: "target-a", tenantId: "tenant-a", campaignId: "campaign-a",
    repositoryId: "repo-a", snapshotId: "snapshot-a", ownerPrincipalId: "owner", maxAttempts: 2,
    eventId: "target-created", idempotencyKey: "target-created", correlationId: "campaign-a", createdAt });
  const decision = planWardenRollout(db, { id: "rollout-a", tenantId: "tenant-a", campaignId: "campaign-a",
    expectedCampaignRevision: 1,
    profiles: [{ targetId: "target-a", risk: "medium", environment: "test", verificationConfidence: 0.99,
      canaryEligible: true, ownerGroup: "payments", ownerMaxParallel: 1,
      maintenanceWindow: { start: "2026-08-02T13:00:00.000Z", end: "2026-08-02T16:00:00.000Z" } }],
    canaryTargetId: "target-a", maxCohortSize: 1,
    stopConditions: { pauseFailureRate: 0.1, abortFailureRate: 0.25, minimumVerificationConfidence: 0.9,
      abortOnCriticalFailure: true },
    actorPrincipalId: "owner", eventId: "rollout-created", idempotencyKey: "rollout-created",
    correlationId: "campaign-a", createdAt });
  transitionWardenCampaign(db, { tenantId: "tenant-a", campaignId: "campaign-a", expectedRevision: 1,
    to: "running", actorPrincipalId: "owner", eventId: "campaign-running", idempotencyKey: "campaign-running",
    correlationId: "campaign-a", createdAt });
  ingestRepositoryEvidence(graph, { tenantId: "tenant-a", repositoryId: "repo-a", snapshotId: "snapshot-a",
    exactCommit: resolvedSha, capturedAt: createdAt,
    evidence: [
      { type: "codeowners", id: "owners-1", observedAt: createdAt, codeownersPath: ".github/CODEOWNERS",
        owners: ["@payments"], matchedPaths: ["src/payments.ts"] },
      { type: "ci", id: "ci-1", observedAt: createdAt, provider: "github_actions",
        workflow: "CI", job: "test", conclusion: "success", runId: "100" },
      { type: "runtime_trace", id: "runtime-1", observedAt: createdAt,
        operation: "POST /charges", status: "ok", durationMs: 17 },
    ] });
  return { db, graph, dir, snapshotRoot, decision };
}

function source(): UnifiedSourceArtifact {
  const content = JSON.stringify({ provider: "provider", version: "2026-08" });
  return {
    id: "source-release-1", tenantId: "tenant-a", sourceKind: "release",
    sourceUri: "https://provider.example/releases/2026-08", providerSlug: "provider",
    sourceRevision: "2026-08", contentSha256: digest(content), contentType: "application/json", content,
    observedAt: createdAt, capturedAt: createdAt, capturedBy: "worker:catalog",
    taxonomyVersion: "2026-08-02",
    taxonomySignals: [{ kind: "field", subject: "charge.amount_cents", before: "amount_cents",
      after: "amount", breaking: true, evidenceLocation: "release.body:12" }],
    createdAt,
  };
}

describe("field-rename recipe end to end through the campaign executor", () => {
  it("plans and applies the rename, verifies, and lands a review package with typed edits", async () => {
    const value = fixture();
    const dependencies: WardenCampaignExecutionDependencies = {
      ...fieldRenameRecipeDependencies({
        deriveRename: () => ({ from: "amount_cents", to: "amount" }),
        graphDb: value.graph,
      }),
      // Deterministic passing verify (baseline + post-edit) — the sandbox path is
      // exercised in its own suite; here we prove the recipe's plan/apply flow.
      verify: async (input) => input.commands.map((command) => ({
        command, status: "passed" as const, failureFingerprints: [],
        outputSha256: digest(`${command}:passed`), durationMs: 1, sandboxBackend: "fly_machines" as const,
      })),
    };

    const result = await executeWardenCampaignTarget({
      db: value.db, tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a",
      rolloutDecisionId: "rollout-a", source: source(), actorPrincipalId: "worker", runId: "run-a", createdAt,
      rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
      dependencies,
    });

    expect(result).toMatchObject({ tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a", stage: "review" });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({ stage: "review" });

    const reviewPackage = value.db.raw.prepare("SELECT content_text FROM artifact_manifests WHERE id = ?")
      .get(result.packageArtifactId) as { content_text: string };
    const parsed = JSON.parse(reviewPackage.content_text) as { typedEdits: Array<{ kind: string; targetPath: string; targetSymbol: string }> };
    expect(parsed.typedEdits).toContainEqual(expect.objectContaining({
      kind: "typed_recipe", targetPath: "src/payments.ts", targetSymbol: "amount_cents",
    }));
    // The snapshot on disk is untouched; the rename lived only in the candidate copy.
    expect(readFileSync(join(value.snapshotRoot, "src", "payments.ts"), "utf8")).toContain("amount_cents");
  });
});
