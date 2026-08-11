/**
 * Cross-tenant denial matrix (evidence artifact for Wave 3a tenancy hardening).
 *
 * For each customer-artifact resource class this asserts that tenant A can NEVER read or
 * mutate tenant B's row by id: the tenant-scoped accessor returns nothing / no change,
 * never B's data. It also pins the fail-open closure — a blank tenant now throws
 * `tenant_scope_required` instead of silently dropping the filter — while the explicit
 * `undefined` global/system read path still works. Finally it pins the shared-catalog
 * contract for `api_changes` / getChange.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertTenantScope,
  createApiKey,
  createDb,
  enqueueJob,
  exportAuditJson,
  getAgentRun,
  getChange,
  getConsumer,
  getJob,
  getPr,
  getRepairSession,
  insertAgentRun,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertImpactFinding,
  insertMigrationPr,
  insertProvider,
  insertRepairSession,
  listApiKeys,
  listAudit,
  listFindingsForChange,
  listPrs,
  listRoutingLedgerForRun,
  recordAudit,
  recordRoutingDecision,
  revokeApiKey,
  type AppDb,
} from "./index.js";

const NOW = "2026-08-02T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

type Seed = {
  changeId: string;
  consumerId: string;
  prId: string;
  agentRunId: string;
  repairId: string;
  jobId: string;
  apiKeyId: string;
  runId: string;
};

function seed(db: AppDb, s: string, tenantId: string): Seed {
  const providerId = `provider-${s}`;
  const fromVersionId = `version-${s}-1`;
  const toVersionId = `version-${s}-2`;
  const changeId = `change-${s}`;
  const consumerId = `consumer-${s}`;
  const prId = `pr-${s}`;
  insertProvider(db, { id: providerId, slug: `provider-${s}`, name: `Provider ${s}`, createdAt: NOW });
  insertApiVersion(db, {
    id: fromVersionId,
    providerId,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: s, version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: toVersionId,
    providerId,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: s, version: "2" } }),
    publishedAt: NOW,
  });
  insertApiChange(db, {
    id: changeId,
    providerId,
    fromVersionId,
    toVersionId,
    risk: "breaking",
    summary: `Change ${s}`,
    diffJson: "[]",
    createdAt: NOW,
  });
  insertConsumer(db, {
    id: consumerId,
    name: `Consumer ${s}`,
    githubOwner: "customer",
    githubRepo: `repo-${s}`,
    tenantId,
    createdAt: NOW,
  });
  insertImpactFinding(db, {
    id: `finding-${s}`,
    changeId,
    consumerId,
    filePath: "src/app.ts",
    lineStart: 1,
    lineEnd: 2,
    symbol: "callProvider",
    confidence: "high",
    evidenceJson: JSON.stringify({ secret: `evidence-${tenantId}` }),
  });
  insertMigrationPr(db, {
    id: prId,
    changeId,
    consumerId,
    title: `Migration ${s}`,
    body: "Candidate ready.",
    branchName: `mendpoint/${s}`,
    status: "draft",
    risk: "breaking",
    patchUnified: "",
    createdAt: NOW,
  });
  const agentRunId = `agent-run-${s}`;
  insertAgentRun(db, {
    id: agentRunId,
    tenantId,
    goal: `goal-${s}`,
    repoPath: `/repo/${s}`,
    status: "done",
    ok: true,
    steps: 3,
    createdAt: NOW,
  });
  const repairId = `repair-${s}`;
  insertRepairSession(db, {
    id: repairId,
    tenantId,
    consumerId,
    repoPath: `/repo/${s}`,
    status: "done",
    attempts: 1,
    editsCount: 2,
    ok: true,
    createdAt: NOW,
  });
  const jobId = `job-${s}`;
  enqueueJob(db, { id: jobId, tenantId, type: "agent.run", payload: { s }, createdAt: NOW });
  const apiKeyId = `key-${s}`;
  createApiKey(db, { id: apiKeyId, name: `Key ${s}`, tenantId, createdAt: NOW });
  recordAudit(db, {
    id: `audit-${s}`,
    tenantId,
    actor: `actor-${s}`,
    action: "pr.opened",
    resourceType: "migration_pr",
    resourceId: prId,
  });
  const runId = `run-${s}`;
  recordRoutingDecision(db, {
    id: `routing-${s}`,
    tenantId,
    jobId,
    runId,
    taskKind: "migration",
    envelopeId: `envelope-${s}`,
    policySnapshotId: `policy-${s}`,
    taskSnapshotId: `task-${s}`,
    action: "route",
    eliminated: [],
    fallback: [],
    breaker: {},
    handoffRequired: false,
    decision: { picked: `executor-${s}` },
    createdAt: NOW,
  });
  return { changeId, consumerId, prId, agentRunId, repairId, jobId, apiKeyId, runId };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-cross-tenant-"));
  const db = createDb(join(directory, "denial.sqlite"));
  opened.push({ db, directory });
  const a = seed(db, "a", "tenant-a");
  const b = seed(db, "b", "tenant-b");
  return { db, a, b };
}

describe("cross-tenant denial matrix", () => {
  it("assertTenantScope closes the fail-open branch without breaking global reads", () => {
    expect(() => assertTenantScope("tenant-a")).not.toThrow();
    expect(() => assertTenantScope(undefined)).not.toThrow(); // explicit global/system read
    expect(() => assertTenantScope(null)).not.toThrow();
    expect(() => assertTenantScope("")).toThrow("tenant_scope_required");
    expect(() => assertTenantScope("   ")).toThrow("tenant_scope_required");
  });

  it("consumers: tenant A cannot read tenant B's consumer by id", () => {
    const { db, a, b } = fixture();
    expect(getConsumer(db, a.consumerId, "tenant-a")).toBeDefined();
    expect(getConsumer(db, b.consumerId, "tenant-a")).toBeUndefined();
    expect(() => getConsumer(db, b.consumerId, "")).toThrow("tenant_scope_required");
    // Explicit global/system read still resolves the row.
    expect(getConsumer(db, b.consumerId, undefined)).toBeDefined();
  });

  it("PRs: tenant A cannot read tenant B's migration PR by id", () => {
    const { db, a, b } = fixture();
    expect(getPr(db, a.prId, "tenant-a")).toBeDefined();
    expect(getPr(db, b.prId, "tenant-a")).toBeUndefined();
    expect(() => getPr(db, b.prId, "")).toThrow("tenant_scope_required");
    const scoped = listPrs(db, "tenant-a");
    expect(scoped.map((p) => p.id)).toContain(a.prId);
    expect(scoped.map((p) => p.id)).not.toContain(b.prId);
    expect(() => listPrs(db, "")).toThrow("tenant_scope_required");
  });

  it("impact findings/evidence: findings are read only within the owning tenant", () => {
    const { db, a, b } = fixture();
    const own = listFindingsForChange(db, a.changeId, "tenant-a");
    expect(own).toHaveLength(1);
    // B's change id, queried under A → no rows, and never B's evidence blob.
    const crossChange = listFindingsForChange(db, b.changeId, "tenant-a");
    expect(crossChange).toEqual([]);
    expect(JSON.stringify(crossChange)).not.toContain("evidence-tenant-b");
    expect(() => listFindingsForChange(db, b.changeId, "")).toThrow(
      "tenant_scope_required",
    );
  });

  it("agent runs: tenant A cannot read tenant B's agent run by id", () => {
    const { db, a, b } = fixture();
    expect(getAgentRun(db, a.agentRunId, "tenant-a")).toBeDefined();
    expect(getAgentRun(db, b.agentRunId, "tenant-a")).toBeUndefined();
    expect(() => getAgentRun(db, b.agentRunId, "")).toThrow("tenant_scope_required");
  });

  it("repair sessions/snapshots: tenant A cannot read tenant B's repair session by id", () => {
    const { db, a, b } = fixture();
    expect(getRepairSession(db, a.repairId, "tenant-a")).toBeDefined();
    expect(getRepairSession(db, b.repairId, "tenant-a")).toBeUndefined();
    expect(() => getRepairSession(db, b.repairId, "")).toThrow("tenant_scope_required");
  });

  it("jobs/usage: tenant A cannot read tenant B's job by id", () => {
    const { db, a, b } = fixture();
    expect(getJob(db, a.jobId, "tenant-a")).toBeDefined();
    expect(getJob(db, b.jobId, "tenant-a")).toBeUndefined();
    expect(() => getJob(db, b.jobId, "")).toThrow("tenant_scope_required");
  });

  it("audit/evidence log: exports and lists are scoped to the owning tenant", () => {
    const { db } = fixture();
    const auditA = listAudit(db, "tenant-a");
    expect(auditA.map((e) => e.id)).toContain("audit-a");
    expect(auditA.map((e) => e.id)).not.toContain("audit-b");
    const exportA = exportAuditJson(db, 5000, "tenant-a");
    expect(JSON.stringify(exportA)).not.toContain("actor-b");
    expect(() => listAudit(db, "")).toThrow("tenant_scope_required");
    expect(() => exportAuditJson(db, 5000, "")).toThrow("tenant_scope_required");
  });

  it("api keys: tenant A cannot list or revoke tenant B's keys", () => {
    const { db, a, b } = fixture();
    const keysA = listApiKeys(db, "tenant-a");
    expect(keysA.map((k) => k.id)).toContain(a.apiKeyId);
    expect(keysA.map((k) => k.id)).not.toContain(b.apiKeyId);
    // Revoking B's key under tenant A changes nothing (no cross-tenant mutation).
    expect(revokeApiKey(db, b.apiKeyId, NOW, "tenant-a")).toBe(false);
    expect(revokeApiKey(db, a.apiKeyId, NOW, "tenant-a")).toBe(true);
    expect(() => listApiKeys(db, "")).toThrow("tenant_scope_required");
    expect(() => revokeApiKey(db, b.apiKeyId, NOW, "")).toThrow("tenant_scope_required");
  });

  it("routing ledger: run history is read only within the owning tenant", () => {
    const { db, a, b } = fixture();
    expect(listRoutingLedgerForRun(db, a.runId, "tenant-a")).toHaveLength(1);
    // B's run id under A's tenant → no rows.
    expect(listRoutingLedgerForRun(db, b.runId, "tenant-a")).toEqual([]);
    // A's run id under B's tenant → no rows either.
    expect(listRoutingLedgerForRun(db, a.runId, "tenant-b")).toEqual([]);
  });

  it("shared-catalog contract: api_changes is intentionally tenant-agnostic, its findings are not", () => {
    const { db, a, b } = fixture();
    // The catalog change/diff is shared: the same row resolves regardless of the caller.
    const changeA = getChange(db, a.changeId);
    const changeB = getChange(db, b.changeId);
    expect(changeA).toBeDefined();
    expect(changeB).toBeDefined();
    // But tenant-private findings on a shared change are strictly scoped: tenant A sees only
    // its own findings for its change, and none of tenant B's.
    expect(listFindingsForChange(db, a.changeId, "tenant-a")).toHaveLength(1);
    expect(listFindingsForChange(db, a.changeId, "tenant-b")).toEqual([]);
  });
});
