import { createHash } from "node:crypto";
import type {
  WardenCheckpointBinding,
  WardenCheckpointEnvelope,
  WardenCheckpointJournal,
  WardenCheckpointJournalRecord,
  WardenSealedRuntimeState,
} from "@mendpoint/agent";
import type { AppDb, JobRow } from "@mendpoint/db";

const DEFAULT_MAX_HEAD_BYTES = 8 * 1024 * 1024;
const DIGEST = /^(?:sha256|hmac-sha256):[a-f0-9]{64}$/;

type StoredCheckpointHead = Readonly<{
  schemaVersion: 1;
  kind: "warden_checkpoint_head";
  bindingDigest: string;
  envelope: WardenCheckpointEnvelope;
  sealedRuntimeState: WardenSealedRuntimeState;
}>;

export type CreateWardenCheckpointJobJournalInput = Readonly<{
  db: AppDb;
  tenantId: string;
  jobId: string;
  workerId: string;
  leaseGeneration: number;
  now?: () => string;
  maxHeadBytes?: number;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function bindingDigest(binding: WardenCheckpointBinding): string {
  return sha256(canonical(binding));
}

function exactKeys(value: object, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(code);
  }
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function assertBinding(
  value: unknown,
  expected: WardenCheckpointBinding,
): asserts value is WardenCheckpointBinding {
  const binding = objectValue(value, "warden_checkpoint_binding_invalid");
  exactKeys(binding, [
    "schemaVersion",
    "tenantId",
    "jobId",
    "attemptId",
    "repositoryId",
    "snapshotId",
    "revision",
    "sourceManifestSha256",
    "allowedPathsDigest",
    "verificationProfileDigest",
    "modelPolicyDigest",
  ], "warden_checkpoint_binding_invalid");
  if (binding.schemaVersion !== 1 || canonical(binding) !== canonical(expected)) {
    throw new Error("warden_checkpoint_binding_mismatch");
  }
}

function validateEnvelope(
  value: unknown,
  expectedBinding: WardenCheckpointBinding,
  expectedLeaseGeneration: number,
  allowPriorLease: boolean,
): WardenCheckpointEnvelope {
  const envelope = objectValue(value, "warden_checkpoint_head_invalid");
  exactKeys(envelope, [
    "schemaVersion",
    "algorithm",
    "payload",
    "payloadDigest",
    "authenticationTag",
  ], "warden_checkpoint_head_invalid");
  const payload = objectValue(envelope.payload, "warden_checkpoint_head_invalid");
  assertBinding(payload.binding, expectedBinding);
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== "HMAC-SHA256" ||
      typeof envelope.payloadDigest !== "string" || !DIGEST.test(envelope.payloadDigest) ||
      typeof envelope.authenticationTag !== "string" || !envelope.authenticationTag ||
      payload.schemaVersion !== 1 || !Number.isSafeInteger(payload.generation) ||
      (payload.generation as number) < 1 ||
      !Number.isSafeInteger(payload.writerLeaseGeneration) ||
      (payload.writerLeaseGeneration as number) < 1 ||
      (allowPriorLease
        ? (payload.writerLeaseGeneration as number) > expectedLeaseGeneration
        : payload.writerLeaseGeneration !== expectedLeaseGeneration)) {
    throw new Error("warden_checkpoint_head_invalid");
  }
  return envelope as unknown as WardenCheckpointEnvelope;
}

function validateSealedRuntimeState(
  value: unknown,
  envelope: WardenCheckpointEnvelope,
): WardenSealedRuntimeState {
  const sealed = objectValue(value, "warden_checkpoint_head_invalid");
  exactKeys(sealed, [
    "schemaVersion",
    "algorithm",
    "runtimeSchemaVersion",
    "codec",
    "keyId",
    "checkpointPayloadDigest",
    "runtimeStateCommitment",
    "plaintextBytes",
    "nonce",
    "ciphertext",
    "authenticationTag",
  ], "warden_checkpoint_head_invalid");
  if (sealed.schemaVersion !== 1 || sealed.algorithm !== "AES-256-GCM" ||
      sealed.runtimeSchemaVersion !== 1 || sealed.codec !== "opaque-bytes-v1" ||
      typeof sealed.keyId !== "string" || !DIGEST.test(sealed.keyId) ||
      sealed.checkpointPayloadDigest !== envelope.payloadDigest ||
      sealed.runtimeStateCommitment !== envelope.payload.runtimeStateCommitment ||
      !Number.isSafeInteger(sealed.plaintextBytes) || (sealed.plaintextBytes as number) < 0 ||
      typeof sealed.nonce !== "string" || !sealed.nonce ||
      typeof sealed.ciphertext !== "string" || !sealed.ciphertext ||
      typeof sealed.authenticationTag !== "string" || !sealed.authenticationTag) {
    throw new Error("warden_checkpoint_head_invalid");
  }
  return sealed as unknown as WardenSealedRuntimeState;
}

function parseStoredHead(
  raw: string,
  expectedBinding: WardenCheckpointBinding,
  expectedLeaseGeneration: number,
  maxHeadBytes: number,
): StoredCheckpointHead {
  if (Buffer.byteLength(raw, "utf8") > maxHeadBytes) {
    throw new Error("warden_checkpoint_storage_limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("warden_checkpoint_head_invalid");
  }
  const head = objectValue(parsed, "warden_checkpoint_head_invalid");
  exactKeys(head, [
    "schemaVersion",
    "kind",
    "bindingDigest",
    "envelope",
    "sealedRuntimeState",
  ], "warden_checkpoint_head_invalid");
  const digest = bindingDigest(expectedBinding);
  if (head.schemaVersion !== 1 || head.kind !== "warden_checkpoint_head" ||
      head.bindingDigest !== digest) {
    throw new Error("warden_checkpoint_binding_mismatch");
  }
  const envelope = validateEnvelope(
    head.envelope,
    expectedBinding,
    expectedLeaseGeneration,
    true,
  );
  const sealedRuntimeState = validateSealedRuntimeState(head.sealedRuntimeState, envelope);
  return Object.freeze({
    schemaVersion: 1,
    kind: "warden_checkpoint_head",
    bindingDigest: digest,
    envelope,
    sealedRuntimeState,
  });
}

function serializeHead(
  binding: WardenCheckpointBinding,
  envelope: WardenCheckpointEnvelope,
  sealedRuntimeState: WardenSealedRuntimeState,
  leaseGeneration: number,
  maxHeadBytes: number,
): string {
  const validatedEnvelope = validateEnvelope(envelope, binding, leaseGeneration, false);
  const validatedRuntime = validateSealedRuntimeState(sealedRuntimeState, validatedEnvelope);
  const raw = JSON.stringify({
    schemaVersion: 1,
    kind: "warden_checkpoint_head",
    bindingDigest: bindingDigest(binding),
    envelope: validatedEnvelope,
    sealedRuntimeState: validatedRuntime,
  } satisfies StoredCheckpointHead);
  if (Buffer.byteLength(raw, "utf8") > maxHeadBytes) {
    throw new Error("warden_checkpoint_storage_limit");
  }
  return raw;
}

function readJobAt(input: CreateWardenCheckpointJobJournalInput, observedAt: string): JobRow {
  const job = input.db.raw.prepare(
    `SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND type = 'agent.run'`,
  ).get(input.jobId, input.tenantId) as JobRow | undefined;
  if (!job || job.status !== "running" || job.lease_owner !== input.workerId ||
      job.lease_generation !== input.leaseGeneration || !job.lease_expires_at ||
      job.lease_expires_at <= observedAt) {
    throw new Error("warden_checkpoint_job_stale");
  }
  return job;
}

function authorityTime(input: CreateWardenCheckpointJobJournalInput): string {
  const value = (input.now ?? (() => new Date().toISOString()))();
  try {
    if (new Date(value).toISOString() !== value) {
      throw new Error("warden_checkpoint_clock_invalid");
    }
  } catch {
    throw new Error("warden_checkpoint_clock_invalid");
  }
  return value;
}

export function createWardenCheckpointJobJournal(
  input: CreateWardenCheckpointJobJournalInput,
): WardenCheckpointJournal {
  if (!input.tenantId || !input.jobId || !input.workerId ||
      !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1) {
    throw new Error("warden_checkpoint_scope_invalid");
  }
  const maxHeadBytes = input.maxHeadBytes ?? DEFAULT_MAX_HEAD_BYTES;
  if (!Number.isSafeInteger(maxHeadBytes) || maxHeadBytes < 1 ||
      maxHeadBytes > DEFAULT_MAX_HEAD_BYTES) {
    throw new Error("warden_checkpoint_storage_limit_invalid");
  }
  let lastAuthorityTime: string | null = null;

  function nextAuthorityTime(): string {
    const value = authorityTime(input);
    if (lastAuthorityTime !== null && value < lastAuthorityTime) {
      throw new Error("warden_checkpoint_clock_regressed");
    }
    lastAuthorityTime = value;
    return value;
  }

  function assertScope(binding: WardenCheckpointBinding): void {
    if (binding.tenantId !== input.tenantId || binding.jobId !== input.jobId) {
      throw new Error("warden_checkpoint_binding_mismatch");
    }
  }

  async function read(binding: WardenCheckpointBinding): Promise<WardenCheckpointJournalRecord> {
    assertScope(binding);
    const observedAt = nextAuthorityTime();
    const job = readJobAt(input, observedAt);
    if (job.result_json === null) {
      return Object.freeze({
        envelope: null,
        sealedRuntimeState: null,
        activeWriterLeaseGeneration: job.lease_generation,
      });
    }
    const head = parseStoredHead(
      job.result_json,
      binding,
      job.lease_generation,
      maxHeadBytes,
    );
    return Object.freeze({
      envelope: head.envelope,
      sealedRuntimeState: head.sealedRuntimeState,
      activeWriterLeaseGeneration: job.lease_generation,
    });
  }

  async function compareAndSwap(
    request: Parameters<WardenCheckpointJournal["compareAndSwap"]>[0],
  ): Promise<boolean> {
    assertScope(request.binding);
    if (request.expectedActiveWriterLeaseGeneration !== input.leaseGeneration) {
      throw new Error("warden_checkpoint_job_stale");
    }
    if (input.db.raw.isTransaction) {
      throw new Error("warden_checkpoint_transaction_unsupported");
    }
    const nextRaw = serializeHead(
      request.binding,
      request.nextEnvelope,
      request.nextSealedRuntimeState,
      input.leaseGeneration,
      maxHeadBytes,
    );
    input.db.raw.exec("BEGIN IMMEDIATE");
    try {
      const lockedAt = nextAuthorityTime();
      const job = readJobAt(input, lockedAt);
      let currentDigest: string | null = null;
      if (job.result_json !== null) {
        currentDigest = parseStoredHead(
          job.result_json,
          request.binding,
          job.lease_generation,
          maxHeadBytes,
        ).envelope.payloadDigest;
      }
      if (currentDigest !== request.expectedPayloadDigest) {
        input.db.raw.exec("COMMIT");
        return false;
      }
      const commitAt = nextAuthorityTime();
      readJobAt(input, commitAt);
      const updated = input.db.raw.prepare(
        `UPDATE jobs SET result_json = ?
         WHERE id = ? AND tenant_id = ? AND type = 'agent.run'
           AND status = 'running' AND lease_owner = ? AND lease_generation = ?
           AND lease_expires_at > ?
           AND ${job.result_json === null ? "result_json IS NULL" : "result_json = ?"}`,
      ).run(
        nextRaw,
        input.jobId,
        input.tenantId,
        input.workerId,
        input.leaseGeneration,
        commitAt,
        ...(job.result_json === null ? [] : [job.result_json]),
      );
      input.db.raw.exec("COMMIT");
      return Number(updated.changes) === 1;
    } catch (error) {
      if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
      throw error;
    }
  }

  return Object.freeze({ read, compareAndSwap });
}
