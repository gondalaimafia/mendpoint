import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CandidateReviewEvidence } from "@mendpoint/shared";
import {
  createDb,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  listAudit,
  recordTrajectory,
  type AgentRunRow,
  type AppDb,
  type Trajectory,
  type WardenCandidateDeliveryRecord,
} from "@mendpoint/db";
import { GOVERNED_LEARNING_PURPOSE } from "./governed-learning-producer.js";
import {
  admitWardenGovernedLearningEvent,
  classifyGraphContextDelivery,
  deriveWardenVerificationAuthority,
} from "./warden-learning-producer.js";

type AssessmentSource = "planner" | "verifier" | "unavailable";

function review(
  assessmentSource: AssessmentSource,
  commands: ReadonlyArray<{ ok: boolean; exitCode: number }> = [{ ok: true, exitCode: 0 }],
): CandidateReviewEvidence {
  return {
    schemaVersion: 1,
    summary: "The exact candidate passed every configured check.",
    verification: {
      summary: "The target and regression checks passed.",
      commands: commands.map((command, index) => ({
        command: `check-${index}`,
        ok: command.ok as true,
        exitCode: command.exitCode as 0,
        outputSha256: `sha256:${"e".repeat(64)}`,
      })),
    },
    edits: [{
      path: "src/client.ts",
      rationale: "This source change repairs the bounded SDK call.",
      category: "api_repair",
      risk: "medium",
      confidence: 1,
      assessmentSource,
      verification: {
        summary: "The target and regression checks passed.",
        commandOutputSha256: [`sha256:${"e".repeat(64)}`],
      },
    }],
  } as CandidateReviewEvidence;
}

describe("Warden verification authority is derived from what actually ran", () => {
  it("marks a planner self-assessed edit as soft even when deterministic commands passed", () => {
    // A model that graded its own edit is a soft signal; the passing commands do
    // not launder it into a deterministic label.
    expect(deriveWardenVerificationAuthority(review("planner"))).toEqual({
      signalClass: "soft",
      producedBy: "model_verifier",
      producerModelId: null,
    });
  });

  it("marks an independently verified edit as hard when deterministic commands passed", () => {
    expect(deriveWardenVerificationAuthority(review("verifier"))).toEqual({
      signalClass: "hard",
      producedBy: "sandbox_command",
      producerModelId: null,
    });
  });

  it("fails closed to soft for an unavailable assessment", () => {
    expect(deriveWardenVerificationAuthority(review("unavailable")).signalClass).toBe("soft");
  });

  it("fails closed to soft when no command actually passed", () => {
    // Independently assessed, but the deterministic command did not pass: no hard
    // verdict exists.
    expect(deriveWardenVerificationAuthority(review("verifier", [{ ok: false, exitCode: 1 }])).signalClass)
      .toBe("soft");
  });
});

// --- Graph-context attribution (spec 17.4.2) -------------------------------
//
// A missed relationship MUST NOT be blamed on the model until Mendpoint has
// confirmed the relationship "was supplied to the model". The event stores that
// as references.graphContextArtifactId, which is null on the Fettler path because
// the agent has no graph tool and no run supplies graph context. These tests
// prove the null is now interpretable: "no graph context in a recorded run"
// (recorded_absent) is distinguishable from "we captured nothing" (unrecorded).

const T = "2026-08-01T00:00:00.000Z";
const OBSERVED = "2026-08-01T10:00:00.000Z";
const NOW = "2026-08-01T12:00:00.000Z";
const TENANT = "tenant-graphctx";
const HUMAN = "human-graphctx";
const RUN_ID = "run-graphctx-1";
const ENV = Object.freeze({ MENDPOINT_REGAUGE_LEARNING_ENABLED: "1" }) as NodeJS.ProcessEnv;

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-graphctx-"));
  dirs.push(dir);
  const db = createDb(join(dir, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: TENANT, slug: TENANT, name: TENANT, createdAt: T });
  insertPrincipal(db, {
    id: HUMAN,
    tenantId: TENANT,
    kind: "human",
    subject: "reviewer",
    displayName: "Reviewer",
    createdAt: T,
  });
  grantLearningConsent(db, {
    id: "consent-governed",
    tenantId: TENANT,
    consentVersion: 1,
    purpose: GOVERNED_LEARNING_PURPOSE,
    residencyRegion: "us-east",
    authorizedByPrincipalId: HUMAN,
    effectiveAt: T,
    expiresAt: "2026-12-01T00:00:00.000Z",
    reason: "Authorized governed learning",
    idempotencyKey: "grant-governed",
    createdAt: T,
  });
  return db;
}

function delivery(tenantId = TENANT, runId = RUN_ID): WardenCandidateDeliveryRecord {
  return {
    id: `delivery-${runId}`,
    tenantId,
    runId,
    jobId: `job-${runId}`,
    status: "delivered",
    repositoryId: "warden-repo-0",
    snapshotId: "snap-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    sealedPath: "sealed/candidate.json",
    sealedSha256: "d".repeat(64),
    requesterPrincipalId: HUMAN,
    rationale: "Approved in Warden review.",
    intentDigest: null,
    branchName: "fettler/repair",
    baseRevision: "a".repeat(40),
    commitSha: "e".repeat(40),
    draftPr: true,
    draftPrNumber: 7,
    draftPrUrl: "https://example.invalid/pr/7",
    errorCode: null,
    errorMessage: null,
    requestedAt: OBSERVED,
    intentBoundAt: null,
    deliveredAt: OBSERVED,
    failedAt: null,
    lastErrorAt: null,
    outcome: "merged",
    outcomeAt: NOW,
    outcomeSource: "github",
    updatedAt: NOW,
  } as WardenCandidateDeliveryRecord;
}

function agentRun(runId = RUN_ID): AgentRunRow {
  return {
    id: runId,
    tenant_id: TENANT,
    job_id: `job-${runId}`,
    goal: "Repair the removed charges.create overload",
    repo_path: "/repo",
    status: "succeeded",
    ok: 1,
    steps: 3,
    files_changed_json: null,
    report_md: null,
    result_json: null,
    created_at: T,
    finished_at: OBSERVED,
  } as AgentRunRow;
}

function seedTrajectory(db: AppDb, opts: { tenantId?: string; runId?: string; contextRefs?: readonly unknown[] } = {}) {
  recordTrajectory(db, {
    id: `traj-${opts.runId ?? RUN_ID}-${opts.tenantId ?? TENANT}`,
    tenantId: opts.tenantId ?? TENANT,
    product: "fettler",
    taskKind: "warden.repair",
    taskSummary: "Repair the removed charges.create overload",
    runId: opts.runId ?? RUN_ID,
    ...(opts.contextRefs ? { contextRefs: opts.contextRefs } : {}),
    createdAt: T,
  });
}

function attribution(db: AppDb, tenantId = TENANT): Record<string, unknown> | undefined {
  const row = listAudit(db, tenantId).find((a) => a.action === "learning.graph_context_attribution");
  return row?.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined;
}

describe("classifyGraphContextDelivery separates the three states a null reference hides", () => {
  it("returns unrecorded when no trajectory was captured for the run", () => {
    expect(classifyGraphContextDelivery(undefined)).toBe("unrecorded");
  });

  it("returns recorded_absent when a trajectory exists and carries no graph-context ref", () => {
    const trajectory = { contextRefs: [] } as unknown as Trajectory;
    expect(classifyGraphContextDelivery(trajectory)).toBe("recorded_absent");
  });

  it("returns recorded_present when a trajectory carries a graph-context ref", () => {
    // The context-compiler failure mode: context reached the run but the event
    // field is still null. It cannot occur on the Fettler path today; the
    // classifier reports it honestly rather than reading it as absent.
    const trajectory = {
      contextRefs: [{ kind: "graph_context", artifactId: "sha256:deadbeef" }],
    } as unknown as Trajectory;
    expect(classifyGraphContextDelivery(trajectory)).toBe("recorded_present");
  });
});

describe("admitWardenGovernedLearningEvent records why graphContextArtifactId is null", () => {
  it("a run that supplied no graph context records recorded_absent, resolved to a real trajectory", () => {
    const db = setup();
    seedTrajectory(db); // the run WAS captured; it carries no graph context

    const result = admitWardenGovernedLearningEvent({
      db,
      delivery: delivery(),
      run: agentRun(),
      reviewEvidence: review("verifier"),
      now: NOW,
      env: ENV,
    });
    expect(result.admitted).toBe(true);

    const meta = attribution(db);
    expect(meta?.graphContextDelivery).toBe("recorded_absent");
    // The reference is threaded through: a resolvable trajectory id, not a
    // placeholder, and the event field itself stays null.
    expect(meta?.trajectoryId).toBe(`traj-${RUN_ID}-${TENANT}`);
    expect(meta?.graphContextArtifactId).toBeNull();
    expect(meta?.eventId).toBe(result.eventId);
  });

  it("a run whose trajectory was never captured records unrecorded, distinguishably", () => {
    const db = setup();
    // No trajectory seeded: the run's observation is missing, not empty.

    const result = admitWardenGovernedLearningEvent({
      db,
      delivery: delivery(),
      run: agentRun(),
      reviewEvidence: review("verifier"),
      now: NOW,
      env: ENV,
    });
    expect(result.admitted).toBe(true);

    const meta = attribution(db);
    expect(meta?.graphContextDelivery).toBe("unrecorded");
    // The third state: no trajectory to reference, so trajectoryId is null. A
    // reader must NOT attribute a missed relationship to the model from here.
    expect(meta?.trajectoryId).toBeNull();
    expect(meta?.graphContextArtifactId).toBeNull();
  });

  it("does not resolve another tenant's trajectory for the same run id", () => {
    const db = setup();
    // A DIFFERENT tenant recorded a trajectory under the SAME run id. It must not
    // leak into this tenant's attribution, which stays honestly unrecorded.
    insertTenant(db, { id: "other-tenant", slug: "other", name: "Other", createdAt: T });
    seedTrajectory(db, { tenantId: "other-tenant" });

    const result = admitWardenGovernedLearningEvent({
      db,
      delivery: delivery(),
      run: agentRun(),
      reviewEvidence: review("verifier"),
      now: NOW,
      env: ENV,
    });
    expect(result.admitted).toBe(true);

    const meta = attribution(db);
    expect(meta?.graphContextDelivery).toBe("unrecorded");
    expect(meta?.trajectoryId).toBeNull();
  });
});
