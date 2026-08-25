import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  type TransformerMissionArtifactRegistration,
  type TransformerPilotExecutionStore,
} from "@mendpoint/transformer";
import type {
  TransformerCheckpointArtifactBackend,
} from "@mendpoint/worker/transformer-checkpoint-artifacts";
import {
  drainRegaugeMissionArtifactOutbox,
  type RegaugeMissionArtifactRuntime,
} from "./regauge-mission-artifact-outbox.js";

const roots: string[] = [];
const databases: AppDb[] = [];
const observedAt = "2026-08-25T12:00:00.000Z";

afterEach(() => {
  while (databases.length) databases.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
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
  const backend: TransformerCheckpointArtifactBackend = Object.freeze({
    async createOnly(storageKey, bytes) {
      if (values.has(storageKey)) return "exists";
      values.set(storageKey, new Uint8Array(bytes));
      return "created";
    },
    async read(storageKey) {
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
  return { root, db, registration, values, runtime, marks };
}

function fakeStore(
  registration: TransformerMissionArtifactRegistration,
  completed: string[],
): TransformerPilotExecutionStore {
  return {
    listMissionArtifactAdoptionCandidates: () => [],
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
});

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
