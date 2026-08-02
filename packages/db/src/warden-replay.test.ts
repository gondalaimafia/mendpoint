import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertArtifactManifest, insertPrincipal, type AppDb } from "./index.js";
import {
  appendWardenRunEvent,
  replayWardenRun,
  type WardenRunReplayEnvelope,
} from "./warden-replay.js";

const dbs: AppDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-warden-replay-"));
  dirs.push(dir);
  const db = createDb(join(dir, "replay.sqlite"));
  dbs.push(db);
  insertPrincipal(db, {
    id: "principal-warden",
    tenantId: "tenant-a",
    kind: "service",
    subject: "warden-worker",
    displayName: "Warden worker",
    createdAt: "2026-08-02T14:00:00.000Z",
  });
  insertArtifactManifest(db, {
    id: "artifact-input",
    tenantId: "tenant-a",
    kind: "repository-snapshot",
    schemaVersion: 1,
    sha256: sha("input"),
    mediaType: "application/json",
    sizeBytes: 5,
    storageRef: "artifact://tenant-a/input",
    createdAt: "2026-08-02T14:00:00.000Z",
  });
  return db;
}

function envelope(overrides: Partial<WardenRunReplayEnvelope> = {}): WardenRunReplayEnvelope {
  return {
    envelopeVersion: 1,
    eventId: "run-event-1",
    tenantId: "tenant-a",
    runId: "run-1",
    eventKind: "run_started",
    actorPrincipalId: "principal-warden",
    correlationId: "correlation-1",
    causationId: null,
    occurredAt: "2026-08-02T14:00:00.000Z",
    inputSha256: sha("input"),
    outputSha256: sha("started"),
    versions: [
      { kind: "tool", id: "warden", version: "1.4.0" },
      { kind: "policy", id: "delivery", version: "policy-5" },
    ],
    cost: { currency: "USD", amountMicros: 0, inputTokens: 0, outputTokens: 0, computeMs: 4 },
    artifacts: [{
      id: "artifact-input",
      kind: "repository-snapshot",
      sha256: sha("input"),
      storageRef: "artifact://tenant-a/input",
    }],
    deterministic: {
      eligible: true,
      replayKey: "recipe:warden:1.4.0",
      stateBeforeSha256: sha("empty"),
      stateAfterSha256: sha("started"),
    },
    metadata: { repositoryId: "repo-a", attempt: 1 },
    ...overrides,
  };
}

describe("Warden append only replay envelope", () => {
  it("records hashes, versions, costs, artifacts, correlation, causation, and stable replay evidence", () => {
    const db = setup();
    const first = appendWardenRunEvent(db, {
      tenantId: "tenant-a",
      actorPrincipalId: "principal-warden",
      idempotencyKey: "run-1:event-1",
      createdAt: "2026-08-02T14:00:00.000Z",
      envelope: envelope(),
    });
    expect(first.inserted).toBe(true);
    const secondEnvelope = envelope({
      eventId: "run-event-2",
      eventKind: "analysis_completed",
      causationId: "run-event-1",
      occurredAt: "2026-08-02T14:01:00.000Z",
      outputSha256: sha("analysis"),
      cost: { currency: "USD", amountMicros: 4_200, inputTokens: 120, outputTokens: 30, computeMs: 81 },
      deterministic: {
        eligible: true,
        replayKey: "recipe:warden:1.4.0",
        stateBeforeSha256: sha("started"),
        stateAfterSha256: sha("analysis"),
      },
    });
    appendWardenRunEvent(db, {
      tenantId: "tenant-a",
      actorPrincipalId: "principal-warden",
      idempotencyKey: "run-1:event-2",
      createdAt: "2026-08-02T14:01:00.000Z",
      envelope: secondEnvelope,
    });
    const replay = replayWardenRun(db, "tenant-a", "run-1");
    expect(replay).toMatchObject({
      eventCount: 2,
      eventIds: ["run-event-1", "run-event-2"],
      correlationId: "correlation-1",
      deterministicReplayEligible: true,
      cost: { currency: "USD", amountMicros: 4_200, inputTokens: 120, outputTokens: 30, computeMs: 85 },
      integrity: { ok: true, checkedTenantEvents: 2 },
    });
    expect(replay.replaySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(replayWardenRun(db, "tenant-a", "run-1", replay.replaySha256)).toEqual(replay);
    expect(replay.versions).toHaveLength(2);
    expect(replay.artifacts).toHaveLength(1);
  });

  it("replays an identical idempotency key once and rejects a changed envelope", () => {
    const db = setup();
    const input = {
      tenantId: "tenant-a",
      actorPrincipalId: "principal-warden",
      idempotencyKey: "run-1:event-1",
      createdAt: "2026-08-02T14:00:00.000Z",
      envelope: envelope(),
    };
    expect(appendWardenRunEvent(db, input).inserted).toBe(true);
    expect(appendWardenRunEvent(db, input).inserted).toBe(false);
    expect(() => appendWardenRunEvent(db, {
      ...input,
      envelope: envelope({ outputSha256: sha("changed") }),
    })).toThrow("domain_event_idempotency_conflict");
  });

  it("fails closed on stale causation, mismatched artifact bindings, and mutable history", () => {
    const db = setup();
    expect(() => appendWardenRunEvent(db, {
      tenantId: "tenant-a",
      actorPrincipalId: "principal-warden",
      idempotencyKey: "run-1:bad-artifact",
      createdAt: "2026-08-02T14:00:00.000Z",
      envelope: envelope({
        artifacts: [{
          id: "artifact-input",
          kind: "repository-snapshot",
          sha256: sha("wrong"),
          storageRef: "artifact://tenant-a/input",
        }],
      }),
    })).toThrow("warden_replay_artifact_binding_mismatch");
    appendWardenRunEvent(db, {
      tenantId: "tenant-a",
      actorPrincipalId: "principal-warden",
      idempotencyKey: "run-1:event-1",
      createdAt: "2026-08-02T14:00:00.000Z",
      envelope: envelope(),
    });
    expect(() => appendWardenRunEvent(db, {
      tenantId: "tenant-a",
      actorPrincipalId: "principal-warden",
      idempotencyKey: "run-1:event-stale-cause",
      createdAt: "2026-08-02T14:01:00.000Z",
      envelope: envelope({
        eventId: "run-event-stale-cause",
        eventKind: "analysis_completed",
        causationId: "missing-event",
        occurredAt: "2026-08-02T14:01:00.000Z",
      }),
    })).toThrow("warden_replay_causation_not_found");
    expect(() => db.raw.prepare(
      "UPDATE domain_events SET payload_json = '{}' WHERE id = 'run-event-1'",
    ).run()).toThrow(/append_only/);
    expect(() => replayWardenRun(db, "tenant-a", "run-1", sha("wrong")))
      .toThrow("warden_replay_expected_digest_mismatch");
  });
});
