import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  getAdaptiveRegenerationByCandidate,
  recordAdaptiveCandidate,
  requestAdaptiveCandidateRegeneration,
  type AppDb,
} from "@mendpoint/db";
import { processTransformerAdaptiveRegenerations } from "./transformer-adaptive-regeneration.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(): { db: AppDb; candidateId: string } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-regeneration-"));
  dirs.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  const candidate = recordAdaptiveCandidate(db, {
    tenantId: "tenant-a",
    campaignId: "campaign-a",
    unitId: "unit-a",
    attemptId: "attempt-a",
    repositoryId: "repository-a",
    snapshotId: "snapshot-a",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    divergedFromDigest: `sha256:${"b".repeat(64)}`,
    candidateDigest: `sha256:${"c".repeat(64)}`,
    failingCommandId: "verify",
    sealedPath: join(root, "candidate.json"),
    sealedSha256: `sha256:${"d".repeat(64)}`,
    changedPaths: ["package.json"],
    expiresAt: "2026-08-07T00:00:00.000Z",
    now: "2026-08-06T00:00:00.000Z",
  });
  requestAdaptiveCandidateRegeneration(db, {
    tenantId: "tenant-a",
    id: candidate.id,
    reviewerPrincipalId: "human:reviewer-a",
    rationale: "Preserve behavior and revise the migration approach.",
    now: "2026-08-06T00:10:00.000Z",
  });
  return { db, candidateId: candidate.id };
}

describe("Transformer adaptive regeneration reconciliation", () => {
  it("keeps customer feedback recoverably blocked before any pilot mutation", () => {
    const { db, candidateId } = fixture();
    const control = vi.fn(() => ({ revision: 2 }));
    const first = processTransformerAdaptiveRegenerations(db, { control } as never, {
      observedAt: "2026-08-06T00:11:00.000Z",
    });
    const afterFirst = getAdaptiveRegenerationByCandidate(db, "tenant-a", candidateId)!;
    const second = processTransformerAdaptiveRegenerations(db, { control } as never, {
      observedAt: "2026-08-06T00:12:00.000Z",
    });

    expect(first).toEqual({ considered: 1, blocked: 1, scheduled: 0, failed: 0, errors: [] });
    expect(second).toEqual({ considered: 1, blocked: 1, scheduled: 0, failed: 0, errors: [] });
    expect(control).not.toHaveBeenCalled();
    expect(getAdaptiveRegenerationByCandidate(db, "tenant-a", candidateId)).toMatchObject({
      status: "pending",
      attemptCount: 0,
      lastErrorCode: "external_processing_authorization_required",
      updatedAt: afterFirst.updatedAt,
    });
  });

  it("does not invoke a pilot store that would throw", () => {
    const { db, candidateId } = fixture();
    const control = vi.fn(() => { throw new Error("pilot mutation must not run"); });
    const result = processTransformerAdaptiveRegenerations(db, {
      control,
    } as never, { observedAt: "2026-08-06T00:11:00.000Z" });

    expect(result).toEqual({
      considered: 1,
      blocked: 1,
      scheduled: 0,
      failed: 0,
      errors: [],
    });
    expect(control).not.toHaveBeenCalled();
    expect(getAdaptiveRegenerationByCandidate(db, "tenant-a", candidateId)).toMatchObject({
      status: "pending",
      attemptCount: 0,
      lastErrorCode: "external_processing_authorization_required",
    });
  });
});
