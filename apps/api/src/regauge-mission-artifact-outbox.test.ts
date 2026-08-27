import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { REGAUGE_MISSION_EVIDENCE_MAX_BYTES } from "@mendpoint/shared";
import {
  createDb,
  createMission,
  insertPrincipal,
  linkRegaugeCampaignToMission,
  listMissionArtifacts,
  type AppDb,
} from "@mendpoint/db";
import {
  createTransformerMissionEvidenceArtifact,
  TransformerPilotExecutionStore,
  type TransformerMissionArtifactAdoptionCandidate,
  type TransformerMissionArtifactRegistration,
  type TransformerMissionArtifactRegistrationBinding,
} from "@mendpoint/transformer";
import type {
  TransformerCheckpointArtifactBackend,
} from "@mendpoint/worker/transformer-checkpoint-artifacts";
import {
  drainRegaugeMissionArtifactOutbox,
  type RegaugeMissionArtifactRuntime,
} from "./regauge-mission-artifact-outbox.js";
import { createTransformerAttemptCoordinatorRoutes } from "./transformer-attempt-coordinator.js";
import type { ApiEnv } from "./auth.js";

const roots: string[] = [];
const databases: AppDb[] = [];
const observedAt = "2026-08-25T12:00:00.000Z";
const gate = JSON.stringify({
  schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
  tenantAllowlist: ["tenant-a"],
  environmentAllowlist: ["test"],
  grants: [{
    tenantId: "tenant-a",
    environment: "test",
    boundaries: ["api_control_plane", "worker_action", "delivery", "ui"],
    acceptanceEvidenceRefs: ["acceptance:regauge:test"],
    productionDeliveryApprovalRefs: ["approval:regauge:test"],
  }],
});

afterEach(() => {
  while (databases.length) databases.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(options: Readonly<{ mission?: boolean }> = {}) {
  const root = mkdtempSync(join(tmpdir(), "regauge-mission-outbox-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  databases.push(db);
  db.raw.prepare(`
    INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES (?, ?, ?, 'team', 'active', 10, ?)
  `).run("tenant-a", "tenant-a", "Tenant A", observedAt);
  insertPrincipal(db, {
    id: "owner-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "owner@example.test",
    displayName: "Owner",
    createdAt: observedAt,
  });
  insertPrincipal(db, {
    id: "regauge-service-a",
    tenantId: "tenant-a",
    kind: "service",
    subject: "service:regauge-production-bootstrap",
    displayName: "ReGauge production service",
    createdAt: observedAt,
  });
  if (options.mission !== false) {
    createMission(db, {
      id: "mission-a",
      tenantId: "tenant-a",
      product: "regauge",
      triggerKind: "migration_objective",
      objective: "Modernize repository A",
      ownerPrincipalId: "owner-a",
      eventId: "mission-a-created",
      idempotencyKey: "mission-a-created",
      correlationId: "campaign-a",
      createdAt: observedAt,
    });
    linkRegaugeCampaignToMission(db, {
      tenantId: "tenant-a",
      missionId: "mission-a",
      regaugeCampaignId: "campaign-a",
      actorPrincipalId: "owner-a",
      eventId: "mission-a-linked",
      idempotencyKey: "mission-a-linked",
      correlationId: "campaign-a",
      createdAt: observedAt,
    });
  }
  const candidateContent = '{"kind":"candidate"}';
  const executionContent = '{"kind":"execution"}\n';
  const candidateDigest = sha256(Buffer.from(candidateContent));
  const executionDigest = sha256(Buffer.from(executionContent));
  const candidateArtifactId = `tcman_${candidateDigest.slice(7)}`;
  const executionArtifactId = `tre_execution_${createHash("sha256").update("execution-a").digest("hex")}`;
  const key = new Uint8Array(32).fill(9);
  const episodeId = "tfepisode_shared_artifact_test";
  const candidateArtifact = createTransformerMissionEvidenceArtifact({
    tenantId: "tenant-a", episodeId, artifactId: candidateArtifactId,
  }, Buffer.from(candidateContent), key);
  const executionArtifact = createTransformerMissionEvidenceArtifact({
    tenantId: "tenant-a", episodeId, artifactId: executionArtifactId,
  }, Buffer.from(executionContent), key);
  const registration: TransformerMissionArtifactRegistration = Object.freeze({
    schemaVersion: 2,
    registrationId: "regauge-artifacts-a",
    tenantId: "tenant-a",
    campaignId: "campaign-a",
    campaignRevision: 4,
    unitId: "unit-a",
    observedAt,
    episodeId,
    attemptId: "tfattempt_shared_artifact_test",
    sourceSnapshotId: "snapshot-a",
    candidateArtifactId,
    candidateManifestDigest: candidateDigest,
    candidateManifestArtifact: candidateArtifact.artifact,
    executionArtifactId,
    executionEvidenceDigest: executionDigest,
    executionEvidenceArtifact: executionArtifact.artifact,
    executionSchemaVersion: 3,
  });
  const values = new Map<string, Uint8Array>([
    [candidateArtifact.artifact.storageKey, candidateArtifact.bytes],
    [executionArtifact.artifact.storageKey, executionArtifact.bytes],
  ]);
  const marks: string[] = [];
  const reads: string[] = [];
  const backend: TransformerCheckpointArtifactBackend = Object.freeze({
    async createOnly(storageKey, bytes) {
      if (values.has(storageKey)) return "exists";
      values.set(storageKey, new Uint8Array(bytes));
      return "created";
    },
    async read(storageKey) {
      reads.push(storageKey);
      const value = values.get(storageKey);
      return value ? new Uint8Array(value) : null;
    },
    async mark(storageKey, state) { marks.push(`${storageKey}:${state}`); },
  });
  const runtime: RegaugeMissionArtifactRuntime = Object.freeze({
    backend,
    encryptionKey: key,
    legacyDataRoot: root,
  });
  return { root, db, registration, values, runtime, marks, reads };
}

function fakeStore(
  registration: TransformerMissionArtifactRegistration,
  completed: string[],
): TransformerPilotExecutionStore {
  return {
    listMissionArtifactAdoptionCandidates: () => [],
    completeMissionArtifactAdoption: () => { throw new Error("must_not_skip_adoption"); },
    adoptMissionArtifactRegistration: () => { throw new Error("must_not_adopt"); },
    listPendingMissionArtifactRegistrations: () => [registration],
    completeMissionArtifactRegistration: (value: TransformerMissionArtifactRegistration) => {
      completed.push(value.registrationId);
    },
  } as unknown as TransformerPilotExecutionStore;
}

describe("ReGauge coordinator Mission artifact outbox", () => {
  it("rehydrates shared authenticated artifacts after the worker filesystem is destroyed", async () => {
    const { root, db, registration, runtime } = fixture();
    const destroyedWorkerRoot = mkdtempSync(join(root, "worker-"));
    rmSync(destroyedWorkerRoot, { recursive: true, force: true });
    const completed: string[] = [];
    await expect(drainRegaugeMissionArtifactOutbox({
      db,
      store: fakeStore(registration, completed),
      tenantId: "tenant-a",
      runtime,
    })).resolves.toEqual({ registered: 1, skipped: 0 });
    expect(completed).toEqual([registration.registrationId]);
    expect(listMissionArtifacts(db, "tenant-a", "mission-a")).toHaveLength(2);
  });

  it("fails closed on ciphertext tampering and does not acknowledge the outbox", async () => {
    const { db, registration, values, runtime } = fixture();
    const bytes = values.get(registration.candidateManifestArtifact.storageKey)!;
    bytes[0] = bytes[0]! ^ 0xff;
    const completed: string[] = [];
    await expect(drainRegaugeMissionArtifactOutbox({
      db,
      store: fakeStore(registration, completed),
      tenantId: "tenant-a",
      runtime,
    })).rejects.toThrow("transformer_attempt_checkpoint_artifact_mismatch");
    expect(completed).toEqual([]);
    expect(listMissionArtifacts(db, "tenant-a", "mission-a")).toEqual([]);
  });

  it("durably skips an unbound shared registration before reading missing artifacts", async () => {
    const { db, registration, values, runtime, reads } = fixture({ mission: false });
    values.clear();
    const completed: string[] = [];
    await expect(drainRegaugeMissionArtifactOutbox({
      db,
      store: fakeStore(registration, completed),
      tenantId: "tenant-a",
      runtime,
    })).resolves.toEqual({ registered: 0, skipped: 1 });
    expect(completed).toEqual([registration.registrationId]);
    expect(reads).toEqual([]);
  });

  it("durably skips an unbound legacy candidate before reading its deleted filesystem evidence", async () => {
    const { db, runtime, reads, marks } = fixture({ mission: false });
    const candidate: TransformerMissionArtifactAdoptionCandidate = Object.freeze({
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      campaignRevision: 4,
      unitId: "unit-a",
      terminalEventSequence: 8,
      terminalEventType: "attempt.completed_with_checkpoint",
      observedAt,
      episodeId: "tfepisode_legacy_unbound",
      attemptId: "tfattempt_legacy_unbound",
      sourceSnapshotId: "snapshot-a",
      candidateArtifactId: `tcman_${"a".repeat(64)}`,
      executionArtifactId: `tre_execution_${"b".repeat(64)}`,
    });
    const completed: TransformerMissionArtifactAdoptionCandidate[] = [];
    const store = {
      listMissionArtifactAdoptionCandidates: () => [candidate],
      completeMissionArtifactAdoption: (value: TransformerMissionArtifactAdoptionCandidate) => {
        completed.push(value);
      },
      adoptMissionArtifactRegistration: () => { throw new Error("must_not_adopt"); },
      listPendingMissionArtifactRegistrations: () => [],
      completeMissionArtifactRegistration: () => { throw new Error("must_not_complete_registration"); },
    } as unknown as TransformerPilotExecutionStore;
    await expect(drainRegaugeMissionArtifactOutbox({
      db,
      store,
      tenantId: "tenant-a",
      runtime,
    })).resolves.toEqual({ registered: 0, skipped: 1 });
    expect(completed).toEqual([candidate]);
    expect(reads).toEqual([]);
    expect(marks).toEqual([]);
  });

  it("rejects oversized legacy evidence before publishing it to shared storage", async () => {
    const { root, db, runtime, marks } = fixture();
    const candidate: TransformerMissionArtifactAdoptionCandidate = Object.freeze({
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      campaignRevision: 4,
      unitId: "unit-a",
      terminalEventSequence: 8,
      terminalEventType: "attempt.completed_with_checkpoint",
      observedAt,
      episodeId: "tfepisode_legacy_oversized",
      attemptId: "tfattempt_legacy_oversized",
      sourceSnapshotId: "snapshot-a",
      candidateArtifactId: `tcman_${"a".repeat(64)}`,
      executionArtifactId: `tre_execution_${"b".repeat(64)}`,
    });
    const scope = [
      segment("tenant", candidate.tenantId),
      segment("campaign", candidate.campaignId),
      segment("unit", candidate.unitId),
      segment("attempt", candidate.attemptId),
    ];
    const candidateDirectory = join(root, "transformer-candidates", ...scope);
    const executionDirectory = join(root, "transformer-evidence", ...scope);
    mkdirSync(candidateDirectory, { recursive: true });
    mkdirSync(executionDirectory, { recursive: true });
    const oversizedCandidate = join(candidateDirectory, "manifest.json");
    writeFileSync(oversizedCandidate, "x");
    truncateSync(oversizedCandidate, REGAUGE_MISSION_EVIDENCE_MAX_BYTES + 1);
    writeFileSync(join(executionDirectory, `${candidate.executionArtifactId}.json`), "{}\n");
    const store = {
      listMissionArtifactAdoptionCandidates: () => [candidate],
      completeMissionArtifactAdoption: () => { throw new Error("must_not_skip_adoption"); },
      adoptMissionArtifactRegistration: () => { throw new Error("must_not_adopt"); },
      listPendingMissionArtifactRegistrations: () => [],
      completeMissionArtifactRegistration: () => { throw new Error("must_not_complete_registration"); },
    } as unknown as TransformerPilotExecutionStore;

    await expect(drainRegaugeMissionArtifactOutbox({
      db,
      store,
      tenantId: "tenant-a",
      runtime,
    })).rejects.toThrow("regauge_mission_artifact_legacy_size_invalid");
    expect(marks).toEqual([]);
  });

  it("repairs shared reference markers after legacy adoption commits before the marker write", async () => {
    const { root, db, runtime, marks } = fixture();
    const executionArtifactId = `tre_execution_${"b".repeat(64)}`;
    const executionContent = JSON.stringify({
      schemaVersion: 3,
      kind: "transformer.recipe.execution",
      evidenceId: executionArtifactId,
      fence: {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        attemptId: "tfattempt_legacy_repair",
      },
    });
    const executionDigest = sha256(Buffer.from(executionContent));
    const candidateContent = JSON.stringify({
      schemaVersion: 1,
      kind: "transformer.candidate",
      scope: {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        attemptId: "tfattempt_legacy_repair",
      },
      source: { snapshotId: "snapshot-a" },
      executionEvidence: { id: executionArtifactId, digest: executionDigest },
      historicalPadding: "x".repeat(8 * 1024 * 1024),
    });
    const candidateArtifactId = `tcman_${sha256(Buffer.from(candidateContent)).slice(7)}`;
    const candidate: TransformerMissionArtifactAdoptionCandidate = Object.freeze({
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      campaignRevision: 4,
      unitId: "unit-a",
      terminalEventSequence: 8,
      terminalEventType: "attempt.completed_with_checkpoint",
      observedAt,
      episodeId: "tfepisode_legacy_repair",
      attemptId: "tfattempt_legacy_repair",
      sourceSnapshotId: "snapshot-a",
      candidateArtifactId,
      executionArtifactId,
    });
    const scope = [
      segment("tenant", candidate.tenantId),
      segment("campaign", candidate.campaignId),
      segment("unit", candidate.unitId),
      segment("attempt", candidate.attemptId),
    ];
    const candidateDirectory = join(root, "transformer-candidates", ...scope);
    const executionDirectory = join(root, "transformer-evidence", ...scope);
    mkdirSync(candidateDirectory, { recursive: true });
    mkdirSync(executionDirectory, { recursive: true });
    writeFileSync(join(candidateDirectory, "manifest.json"), candidateContent);
    writeFileSync(join(executionDirectory, `${executionArtifactId}.json`), executionContent);
    let adopted: TransformerMissionArtifactRegistration | undefined;
    let acknowledged = false;
    let failFirstReference = true;
    const backend = {
      ...runtime.backend,
      async mark(storageKey: string, state: "pending" | "referenced" | "unreferenced") {
        marks.push(`${storageKey}:${state}`);
        if (state === "referenced" && failFirstReference) {
          failFirstReference = false;
          throw new Error("injected_reference_marker_failure");
        }
      },
    } satisfies TransformerCheckpointArtifactBackend;
    const store = new TransformerPilotExecutionStore();
    Object.assign(store, {
      listMissionArtifactAdoptionCandidates: () => adopted ? [] : [candidate],
      completeMissionArtifactAdoption: () => { throw new Error("must_not_skip_adoption"); },
      adoptMissionArtifactRegistration: (input: Readonly<{
        registration: TransformerMissionArtifactRegistrationBinding;
      }>) => {
        adopted = Object.freeze({
          ...input.registration,
          registrationId: "legacy-repair-registration",
          tenantId: candidate.tenantId,
          campaignId: candidate.campaignId,
          campaignRevision: candidate.campaignRevision,
          unitId: candidate.unitId,
          observedAt: candidate.observedAt,
        });
        return adopted;
      },
      listPendingMissionArtifactRegistrations: () => adopted && !acknowledged ? [adopted] : [],
      completeMissionArtifactRegistration: () => { acknowledged = true; },
      getCampaign: () => ({ campaignId: "campaign-a", state: "running" }),
    });

    await expect(drainRegaugeMissionArtifactOutbox({
      db,
      store,
      tenantId: "tenant-a",
      runtime: { ...runtime, backend },
    })).rejects.toThrow("injected_reference_marker_failure");
    expect(adopted).toBeDefined();
    expect(acknowledged).toBe(false);

    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "request-legacy-recovery-ready");
      c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store,
      gateConfig: gate,
      drainPendingMissionArtifacts: async () => {
        await drainRegaugeMissionArtifactOutbox({
          db,
          store,
          tenantId: "tenant-a",
          runtime: { ...runtime, backend },
        });
      },
      loadExactSource: () => { throw new Error("must_not_load"); },
    }));
    const response = await app.request("/v1/regauge/attempt-coordinator/readyz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-a", campaignId: "campaign-a" }),
    });
    expect(response.status).toBe(200);
    expect(acknowledged).toBe(true);
    expect(marks.filter((value) => value.endsWith(":referenced"))).toHaveLength(4);
    store.close();
  });

  it("keeps coordinator readiness healthy when an unbound registration is tampered", async () => {
    const { db, registration, values, runtime, reads } = fixture({ mission: false });
    const bytes = values.get(registration.candidateManifestArtifact.storageKey)!;
    bytes[0] = bytes[0]! ^ 0xff;
    const completed: string[] = [];
    const store = new TransformerPilotExecutionStore();
    Object.assign(store, fakeStore(registration, completed), {
      getCampaign: () => ({ campaignId: "campaign-a", state: "running" }),
    });
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "request-unbound-ready");
      c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store,
      gateConfig: gate,
      drainPendingMissionArtifacts: async () => {
        await drainRegaugeMissionArtifactOutbox({
          db,
          store,
          tenantId: "tenant-a",
          runtime,
        });
      },
      loadExactSource: () => { throw new Error("must_not_load"); },
    }));
    const response = await app.request("/v1/regauge/attempt-coordinator/readyz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-a", campaignId: "campaign-a" }),
    });
    expect(response.status).toBe(200);
    expect(completed).toEqual([registration.registrationId]);
    expect(reads).toEqual([]);
    store.close();
  });
});

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function segment(label: string, value: string): string {
  return `${label}-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}
