import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getAdaptiveCandidate,
  promoteAdaptiveCandidate,
  recordAdaptiveCandidate,
  reviewAdaptiveCandidate,
  type AppDb,
} from "@mendpoint/db";
import { recipeFilesDigest, sealAdaptiveCandidate } from "@mendpoint/transformer";
import { maintainTransformerAdaptiveArtifactsOnce } from "./cli.js";

const roots: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-maintenance-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { recursive: true });
  const db = createDb(join(root, "worker.sqlite"));
  dbs.push(db);
  return { db, dataRoot, env: { MENDPOINT_DATA_DIR: dataRoot } as NodeJS.ProcessEnv };
}

function reviewFor(files: Record<string, string>) {
  return {
    schemaVersion: 1 as const,
    edits: Object.entries(files).map(([path, content]) => ({
      path,
      changeType: "add" as const,
      beforeContent: null,
      beforeDigest: `sha256:${createHash("sha256").update("").digest("hex")}`,
      beforeMode: null,
      afterDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      afterMode: "100644" as const,
      semanticCategory: "behavior" as const,
      rationale: "Add the verified adaptive candidate file.",
      risk: "low" as const,
      confidence: 95,
    })),
    verification: {
      passed: true as const,
      commandId: "verify-tests",
      summary: "The objective verification passed on the sealed candidate.",
      outputDigest: `sha256:${createHash("sha256").update("passed").digest("hex")}`,
    },
    overallRisk: "low" as const,
    confidence: 95,
  };
}

function seedCandidate(
  db: AppDb,
  env: NodeJS.ProcessEnv,
  unitId: string,
  expiresAt: string,
  maxArtifacts?: number,
) {
  const files = { [`src/${unitId}.ts`]: `export const ${unitId.replaceAll("-", "_")} = true;\n` };
  const candidateDigest = recipeFilesDigest(files);
  const seal = sealAdaptiveCandidate({
    tenantId: "tenant-maintenance",
    campaignId: "campaign-maintenance",
    unitId,
    attemptId: `attempt-${unitId}`,
    repositoryId: "repository-maintenance",
    snapshotId: "snapshot-maintenance",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    divergedFromDigest: `sha256:${"b".repeat(64)}`,
    candidateDigest,
    failingCommandId: "verify-tests",
    changedPaths: Object.keys(files),
    files,
    fileModes: Object.freeze(Object.fromEntries(
      Object.keys(files).map((path) => [path, "100644" as const]),
    )),
    review: reviewFor(files),
    quota: maxArtifacts === undefined ? undefined : { maxArtifacts },
    env,
  });
  const record = recordAdaptiveCandidate(db, {
    tenantId: "tenant-maintenance",
    campaignId: "campaign-maintenance",
    unitId,
    attemptId: `attempt-${unitId}`,
    repositoryId: "repository-maintenance",
    snapshotId: "snapshot-maintenance",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    divergedFromDigest: `sha256:${"b".repeat(64)}`,
    candidateDigest,
    failingCommandId: "verify-tests",
    sealedPath: seal.path,
    sealedSha256: seal.sha256,
    changedPaths: Object.keys(files),
    expiresAt,
    now: "2026-08-06T00:00:00.000Z",
  });
  return { record, seal };
}

describe("Transformer adaptive artifact maintenance", () => {
  it("expires pending work, retries exact terminal cleanup, and preserves all other seals", () => {
    const { db, env } = fixture();
    const expired = seedCandidate(db, env, "expired-unit", "2026-08-06T00:30:00.000Z");
    const approved = seedCandidate(db, env, "approved-unit", "2026-08-06T00:30:00.000Z");
    reviewAdaptiveCandidate(db, {
      tenantId: "tenant-maintenance",
      id: approved.record.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer",
      now: "2026-08-06T00:15:00.000Z",
    });
    const orphan = sealAdaptiveCandidate({
      tenantId: "tenant-maintenance",
      campaignId: "campaign-maintenance",
      unitId: "orphan-unit",
      attemptId: "attempt-orphan-unit",
      repositoryId: "repository-maintenance",
      snapshotId: "snapshot-maintenance",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      divergedFromDigest: `sha256:${"b".repeat(64)}`,
      candidateDigest: recipeFilesDigest({ "src/orphan.ts": "export const orphan = true;\n" }),
      failingCommandId: "verify-tests",
      changedPaths: ["src/orphan.ts"],
      files: { "src/orphan.ts": "export const orphan = true;\n" },
      fileModes: { "src/orphan.ts": "100644" },
      review: reviewFor({ "src/orphan.ts": "export const orphan = true;\n" }),
      env,
    });
    utimesSync(orphan.path, new Date(0), new Date(0));

    expect(maintainTransformerAdaptiveArtifactsOnce(
      db,
      env,
      "2026-08-06T01:00:00.000Z",
    )).toEqual({ tenants: 1, expired: 1, cleaned: 1, cleanupPending: 0 });
    expect(getAdaptiveCandidate(db, "tenant-maintenance", expired.record.id)?.status)
      .toBe("expired");
    expect(existsSync(expired.seal.path)).toBe(false);
    expect(existsSync(orphan.path)).toBe(true);
    expect(getAdaptiveCandidate(db, "tenant-maintenance", approved.record.id)?.status)
      .toBe("approved");
    expect(existsSync(approved.seal.path)).toBe(true);
  });

  it("does not sweep an old seal while a concurrent candidate recorder can reference it", () => {
    const { db, env } = fixture();
    seedCandidate(db, env, "active-unit", "2026-08-07T00:00:00.000Z");
    const files = { "src/reused.ts": "export const reused = true;\n" };
    const candidateDigest = recipeFilesDigest(files);
    const seal = sealAdaptiveCandidate({
      tenantId: "tenant-maintenance",
      campaignId: "campaign-maintenance",
      unitId: "reused-unit",
      attemptId: "attempt-reused-unit",
      repositoryId: "repository-maintenance",
      snapshotId: "snapshot-maintenance",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      divergedFromDigest: `sha256:${"b".repeat(64)}`,
      candidateDigest,
      failingCommandId: "verify-tests",
      changedPaths: Object.keys(files),
      files,
      fileModes: Object.freeze(Object.fromEntries(
        Object.keys(files).map((path) => [path, "100644" as const]),
      )),
      review: reviewFor(files),
      env,
    });
    utimesSync(seal.path, new Date(0), new Date(0));

    expect(maintainTransformerAdaptiveArtifactsOnce(
      db,
      env,
      "2026-08-06T01:00:00.000Z",
    )).toEqual({ tenants: 1, expired: 0, cleaned: 0, cleanupPending: 0 });
    expect(existsSync(seal.path)).toBe(true);

    recordAdaptiveCandidate(db, {
      tenantId: "tenant-maintenance",
      campaignId: "campaign-maintenance",
      unitId: "reused-unit",
      attemptId: "attempt-reused-unit",
      repositoryId: "repository-maintenance",
      snapshotId: "snapshot-maintenance",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      divergedFromDigest: `sha256:${"b".repeat(64)}`,
      candidateDigest,
      failingCommandId: "verify-tests",
      sealedPath: seal.path,
      sealedSha256: seal.sha256,
      changedPaths: Object.keys(files),
      expiresAt: "2026-08-07T00:00:00.000Z",
      now: "2026-08-06T01:00:01.000Z",
    });

    expect(maintainTransformerAdaptiveArtifactsOnce(
      db,
      env,
      "2026-08-06T01:01:00.000Z",
    )).toEqual({ tenants: 1, expired: 0, cleaned: 0, cleanupPending: 0 });
    expect(existsSync(seal.path)).toBe(true);
  });

  it("releases quota from promoted evidence only after its retention deadline", () => {
    const { db, env } = fixture();
    const due = ["delivered-one", "delivered-two"].map((unitId) =>
      seedCandidate(db, env, unitId, "2026-08-06T00:30:00.000Z", 2));
    for (const value of due) {
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-maintenance",
        id: value.record.id,
        decision: "approve",
        reviewerPrincipalId: "human:reviewer",
        now: "2026-08-06T00:10:00.000Z",
      });
      promoteAdaptiveCandidate(db, {
        tenantId: "tenant-maintenance",
        id: value.record.id,
        now: "2026-08-06T00:20:00.000Z",
      });
    }
    expect(() => seedCandidate(
      db,
      env,
      "quota-blocked",
      "2026-08-07T00:00:00.000Z",
      2,
    )).toThrow("adaptive_candidate_quota_count_exceeded");

    expect(maintainTransformerAdaptiveArtifactsOnce(
      db,
      env,
      "2026-08-06T01:00:00.000Z",
    )).toEqual({ tenants: 1, expired: 0, cleaned: 2, cleanupPending: 0 });
    expect(due.every((value) => !existsSync(value.seal.path))).toBe(true);
    expect(maintainTransformerAdaptiveArtifactsOnce(
      db,
      env,
      "2026-08-06T01:01:00.000Z",
    )).toEqual({ tenants: 1, expired: 0, cleaned: 0, cleanupPending: 0 });
    expect(() => seedCandidate(
      db,
      env,
      "quota-released",
      "2026-08-07T00:00:00.000Z",
      2,
    )).not.toThrow();
  });

  it("preserves promoted evidence before its retention deadline", () => {
    const { db, env } = fixture();
    const retained = seedCandidate(
      db,
      env,
      "delivered-retained",
      "2026-08-07T00:00:00.000Z",
    );
    reviewAdaptiveCandidate(db, {
      tenantId: "tenant-maintenance",
      id: retained.record.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer",
      now: "2026-08-06T00:10:00.000Z",
    });
    promoteAdaptiveCandidate(db, {
      tenantId: "tenant-maintenance",
      id: retained.record.id,
      now: "2026-08-06T00:20:00.000Z",
    });

    expect(maintainTransformerAdaptiveArtifactsOnce(
      db,
      env,
      "2026-08-06T01:00:00.000Z",
    )).toEqual({ tenants: 1, expired: 0, cleaned: 0, cleanupPending: 0 });
    expect(existsSync(retained.seal.path)).toBe(true);
  });

  it("rejects an invalid maintenance timestamp", () => {
    const { db, env } = fixture();
    expect(() => maintainTransformerAdaptiveArtifactsOnce(db, env, "not-a-time"))
      .toThrow("transformer_adaptive_maintenance_timestamp_invalid");
  });
});
import { createHash } from "node:crypto";
