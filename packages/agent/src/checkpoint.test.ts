import { describe, expect, it } from "vitest";
import {
  createWardenCheckpointEnvelope,
  verifyWardenCheckpointEnvelope,
  type WardenCheckpointBinding,
  type WardenCheckpointPayload,
} from "./checkpoint.js";

const key = Buffer.from("11".repeat(32), "hex");

const binding: WardenCheckpointBinding = Object.freeze({
  schemaVersion: 1,
  tenantId: "tenant-a",
  jobId: "job-a",
  attemptId: "attempt-a",
  repositoryId: "repo-42",
  snapshotId: "snapshot-a",
  revision: "a".repeat(40),
  sourceManifestSha256: `sha256:${"b".repeat(64)}`,
  allowedPathsDigest: `sha256:${"c".repeat(64)}`,
  verificationProfileDigest: `sha256:${"d".repeat(64)}`,
  modelPolicyDigest: `sha256:${"e".repeat(64)}`,
});

const payload: WardenCheckpointPayload = Object.freeze({
  schemaVersion: 1,
  binding,
  generation: 3,
  writerLeaseGeneration: 7,
  workspaceName: "attempt-a-2f8c4d",
  workspaceDigest: `sha256:${"f".repeat(64)}`,
  phase: "agent_running",
  nextStep: 18,
  steps: Object.freeze([
    Object.freeze({
      step: 17,
      tool: "replace_in_file",
      ok: true,
      summary: "replaced client.ts",
      plannerSource: "model",
      callDigest: `sha256:${"1".repeat(64)}`,
      resultDigest: `sha256:${"2".repeat(64)}`,
    }),
  ]),
  sourceEvidence: Object.freeze([
    Object.freeze({
      path: "src/client.ts",
      digest: `sha256:${"3".repeat(64)}`,
      bytes: 1200,
      totalChars: 1200,
      ranges: Object.freeze([Object.freeze({ start: 0, end: 1200 })]),
      fullyObserved: true,
    }),
  ]),
  observedDirectories: Object.freeze(["src"]),
  searchDigests: Object.freeze([`sha256:${"4".repeat(64)}`]),
  changedFiles: Object.freeze([
    Object.freeze({ path: "src/client.ts", digest: `sha256:${"5".repeat(64)}` }),
  ]),
  actionFingerprints: Object.freeze([
    Object.freeze({
      callDigest: `sha256:${"6".repeat(64)}`,
      resultDigest: `sha256:${"7".repeat(64)}`,
      mutationCount: 1,
    }),
  ]),
  counters: Object.freeze({
    mutationCount: 1,
    toolCalls: 18,
    verifierCalls: 2,
    modelCalls: 9,
    modelSuccessfulCalls: 9,
    modelFailedCalls: 0,
    promptTokens: 900,
    completionTokens: 300,
    totalTokens: 1200,
    costUsd: 0.24,
    observedBytes: 1200,
    searchBytes: 800,
    changedBytes: 90,
    groundedMutations: 1,
    blockedMutations: 0,
  }),
  previousEnvelopeDigest: `sha256:${"8".repeat(64)}`,
  createdAt: "2026-08-10T18:00:00.000Z",
});

describe("Warden checkpoint envelope", () => {
  it("authenticates bounded checkpoint metadata and verifies the exact execution binding", () => {
    const envelope = createWardenCheckpointEnvelope(payload, key);

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.algorithm).toBe("HMAC-SHA256");
    expect(envelope.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.authenticationTag).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(envelope)).not.toContain("source code");
    expect(verifyWardenCheckpointEnvelope(
      envelope,
      key,
      binding,
      payload.writerLeaseGeneration,
    )).toEqual(payload);
  });

  it("rejects payload, tag, key, and execution-binding tampering", () => {
    const envelope = createWardenCheckpointEnvelope(payload, key);

    expect(() => verifyWardenCheckpointEnvelope(
      { ...envelope, payload: { ...payload, nextStep: 19 } },
      key,
      binding,
      payload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_payload_digest_mismatch");
    expect(() => verifyWardenCheckpointEnvelope(
      { ...envelope, authenticationTag: `hmac-sha256:${"0".repeat(64)}` },
      key,
      binding,
      payload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_authentication_failed");
    expect(() => verifyWardenCheckpointEnvelope(
      envelope,
      Buffer.alloc(32, 7),
      binding,
      payload.writerLeaseGeneration,
    ))
      .toThrow("warden_checkpoint_authentication_failed");
    expect(() => verifyWardenCheckpointEnvelope(
      envelope,
      key,
      { ...binding, tenantId: "tenant-b" },
      payload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_binding_mismatch");
    expect(() => verifyWardenCheckpointEnvelope(
      envelope,
      key,
      binding,
      payload.writerLeaseGeneration + 1,
    )).toThrow("warden_checkpoint_lease_mismatch");
  });

  it("rejects unbounded or source-bearing metadata before it can be signed", () => {
    expect(() => createWardenCheckpointEnvelope(
      {
        ...payload,
        steps: [{
          ...payload.steps[0]!,
          summary: "x".repeat(501),
        }],
      },
      key,
    )).toThrow("warden_checkpoint_step_invalid");

    expect(() => createWardenCheckpointEnvelope(
      {
        ...payload,
        sourceEvidence: [{
          ...payload.sourceEvidence[0]!,
          content: "private source code",
        }] as unknown as WardenCheckpointPayload["sourceEvidence"],
      },
      key,
    )).toThrow("warden_checkpoint_source_evidence_invalid");
  });
});
