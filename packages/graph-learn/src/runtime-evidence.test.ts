import { describe, expect, it } from "vitest";
import {
  getNode,
  ingestRepositoryEvidence,
  openGraphLearnMemory,
  runGraphQuery,
  type RepositoryEvidence,
} from "./index.js";

const snapshot = {
  tenantId: "tenant-a",
  repositoryId: "payments-api",
  snapshotId: "snapshot-17",
  exactCommit: "0123456789abcdef0123456789abcdef01234567",
  capturedAt: "2026-08-02T06:00:00.000Z",
} as const;

describe("repository runtime evidence", () => {
  it("binds collector payloads to exact runtime and deployment evidence", () => {
    const db = openGraphLearnMemory();
    try {
      const evidence: RepositoryEvidence[] = [
        { type: "runtime_trace" as const, id: "trace-prod-1", observedAt: "2026-08-02T06:01:00.000Z", operation: "POST /charges", status: "ok" as const },
        { type: "deployment" as const, id: "deploy-prod-1", observedAt: "2026-08-02T06:02:00.000Z", environment: "production", deploymentId: "fly-42", artifactSha256: "a".repeat(64), status: "succeeded" as const },
        { type: "collector" as const, id: "collector-trace-1", observedAt: "2026-08-02T06:03:00.000Z", collectorId: "otel-prod", collectorVersion: "1.2.3", bindingKind: "runtime_trace" as const, boundEvidenceId: "trace-prod-1", payloadSha256: "b".repeat(64) },
        { type: "collector" as const, id: "collector-deploy-1", observedAt: "2026-08-02T06:04:00.000Z", collectorId: "fly-events", collectorVersion: "2026.08", bindingKind: "deployment" as const, boundEvidenceId: "deploy-prod-1", payloadSha256: "c".repeat(64) },
      ];
      expect(ingestRepositoryEvidence(db, { ...snapshot, evidence })).toEqual({ inserted: 4, snapshotId: "snapshot-17" });
      const query = runGraphQuery(db, { op: "repository_evidence", repositoryId: "payments-api", snapshotId: "snapshot-17", evidenceTypes: ["deployment", "collector"] }, { tenantId: "tenant-a" });
      expect(query.rows).toHaveLength(3);
      expect(query.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "deployment", deploymentId: "fly-42", artifactSha256: "a".repeat(64) }),
        expect.objectContaining({ type: "collector", boundEvidenceId: "trace-prod-1", payloadSha256: "b".repeat(64) }),
      ]));
      const traceCollector = evidence[2]!;
      if (traceCollector.type !== "collector") throw new Error("test_fixture_invalid");
      expect(() => ingestRepositoryEvidence(db, { ...snapshot, snapshotId: "missing-binding", evidence: [{ ...traceCollector, boundEvidenceId: "not-supplied" }] })).toThrow("collector_target_missing");
      expect(() => ingestRepositoryEvidence(db, { ...snapshot, snapshotId: "wrong-binding", evidence: [evidence[0]!, { ...traceCollector, bindingKind: "deployment" }] })).toThrow("collector_target_mismatch");
    } finally { db.raw.close(); }
  });

  it("preserves typed timestamped evidence and exposes a bounded tenant query", () => {
    const db = openGraphLearnMemory();
    try {
      const result = ingestRepositoryEvidence(db, {
        ...snapshot,
        evidence: [
          {
            type: "runtime_trace",
            id: "trace-42",
            observedAt: "2026-08-02T06:01:00.000Z",
            operation: "POST /charges",
            status: "ok",
            durationMs: 18,
          },
          {
            type: "test_coverage",
            id: "coverage-unit",
            observedAt: "2026-08-02T06:02:00.000Z",
            suite: "unit",
            linesPercent: 91.5,
            branchesPercent: 84.25,
            reportPath: "coverage/coverage-summary.json",
          },
          {
            type: "codeowners",
            id: "codeowners-root",
            observedAt: "2026-08-02T06:03:00.000Z",
            codeownersPath: ".github/CODEOWNERS",
            owners: ["@payments-team"],
            matchedPaths: ["src/payments.ts"],
          },
          {
            type: "ci",
            id: "ci-9001",
            observedAt: "2026-08-02T06:04:00.000Z",
            provider: "github_actions",
            workflow: "CI",
            job: "test",
            conclusion: "success",
            runId: "9001",
          },
        ],
      });

      expect(result).toEqual({ inserted: 4, snapshotId: "snapshot-17" });
      expect(getNode(db, "repository-snapshot:tenant-a:snapshot-17")).toMatchObject({
        kind: "RepositorySnapshot",
        repo_id: "tenant-a:payments-api",
        meta: { tenant_id: "tenant-a" },
        props: {
          repository_id: "payments-api",
          snapshot_id: "snapshot-17",
          exact_commit: snapshot.exactCommit,
          captured_at: snapshot.capturedAt,
        },
      });

      const query = runGraphQuery(
        db,
        {
          op: "repository_evidence",
          repositoryId: "payments-api",
          snapshotId: "snapshot-17",
          limit: 3,
        },
        { tenantId: "tenant-a" },
      );
      expect(query.rows).toHaveLength(3);
      expect(query.summary).toContain("3 of 4");
      expect(query.rows?.map((row) => row.type)).toEqual([
        "runtime_trace",
        "test_coverage",
        "codeowners",
      ]);
      expect(query.edges).toHaveLength(3);
      expect(query.nodes.every((node) => node.repo_id === "tenant-a:payments-api")).toBe(true);
      expect(query.rows?.[1]).toMatchObject({
        type: "test_coverage",
        observedAt: "2026-08-02T06:02:00.000Z",
        linesPercent: 91.5,
        branchesPercent: 84.25,
        exactCommit: snapshot.exactCommit,
      });
    } finally {
      db.raw.close();
    }
  });

  it("fails closed without tenant scope and never returns another tenant's evidence", () => {
    const db = openGraphLearnMemory();
    try {
      for (const tenantId of ["tenant-a", "tenant-b"]) {
        ingestRepositoryEvidence(db, {
          ...snapshot,
          tenantId,
          evidence: [
            {
              type: "ci",
              id: `ci-${tenantId}`,
              observedAt: "2026-08-02T06:04:00.000Z",
              provider: "github_actions",
              workflow: "CI",
              job: "test",
              conclusion: "success",
              runId: tenantId,
            },
          ],
        });
      }

      const unscoped = runGraphQuery(db, {
        op: "repository_evidence",
        repositoryId: "payments-api",
        snapshotId: "snapshot-17",
      });
      expect(unscoped.nodes).toEqual([]);
      expect(unscoped.summary).toBe("tenant scope required");

      const scoped = runGraphQuery(
        db,
        {
          op: "repository_evidence",
          repositoryId: "payments-api",
          snapshotId: "snapshot-17",
        },
        { tenantId: "tenant-a" },
      );
      expect(scoped.rows).toHaveLength(1);
      expect(JSON.stringify(scoped)).not.toContain("tenant-b");
    } finally {
      db.raw.close();
    }
  });

  it("rejects invalid timestamps, coverage, and duplicate evidence identities", () => {
    const db = openGraphLearnMemory();
    try {
      expect(() =>
        ingestRepositoryEvidence(db, {
          ...snapshot,
          capturedAt: "not-a-timestamp",
          evidence: [],
        }),
      ).toThrow("repository_evidence_captured_at_invalid");

      expect(() =>
        ingestRepositoryEvidence(db, {
          ...snapshot,
          evidence: [
            {
              type: "test_coverage",
              id: "bad-coverage",
              observedAt: "2026-08-02T06:02:00.000Z",
              suite: "unit",
              linesPercent: 101,
              branchesPercent: 80,
              reportPath: "coverage.json",
            },
          ],
        }),
      ).toThrow("repository_evidence_coverage_invalid");

      expect(() =>
        ingestRepositoryEvidence(db, {
          ...snapshot,
          evidence: [
            {
              type: "ci",
              id: "same",
              observedAt: "2026-08-02T06:04:00.000Z",
              provider: "github_actions",
              workflow: "CI",
              job: "test",
              conclusion: "success",
              runId: "1",
            },
            {
              type: "ci",
              id: "same",
              observedAt: "2026-08-02T06:05:00.000Z",
              provider: "github_actions",
              workflow: "CI",
              job: "build",
              conclusion: "success",
              runId: "2",
            },
          ],
        }),
      ).toThrow("repository_evidence_duplicate");

      const accepted = {
        ...snapshot,
        evidence: [{
          type: "runtime_trace" as const,
          id: "immutable-trace",
          observedAt: "2026-08-02T06:06:00.000Z",
          operation: "POST /charges",
          status: "ok" as const,
          durationMs: 20,
        }],
      };
      expect(ingestRepositoryEvidence(db, accepted).inserted).toBe(1);
      expect(ingestRepositoryEvidence(db, accepted).inserted).toBe(1);
      expect(() =>
        ingestRepositoryEvidence(db, {
          ...accepted,
          evidence: [{ ...accepted.evidence[0], durationMs: 999 }],
        }),
      ).toThrow("repository_evidence_identity_conflict");
    } finally {
      db.raw.close();
    }
  });
});
