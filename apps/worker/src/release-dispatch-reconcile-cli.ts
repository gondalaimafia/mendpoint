import {
  reconcileReleaseDispatchFailure,
  type ReleaseDispatchReconciliationAction,
  type ReleaseIngestionStore,
} from "@mendpoint/catalog";
import { getPrincipal, type AppDb } from "@mendpoint/db";
import { tryAcquireMutationLease } from "@mendpoint/ops";
import { parseReleaseDispatchConsumersFromEnv } from "./release-dispatch-drainer.js";

const FLAGS = Object.freeze([
  "--tenant",
  "--dispatch",
  "--action",
  "--evidence-sha256",
  "--expected-lease-generation",
  "--expected-failed-at",
  "--expected-failure-code",
  "--idempotency-key",
  "--actor-principal-id",
]);

export const RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ENV =
  "MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID" as const;

function assertActiveReconciliationPrincipal(input: Readonly<{
  db: AppDb;
  tenantId: string;
  actorPrincipalId: string;
  observedAt: string;
}>): void {
  const principal = getPrincipal(input.db, input.tenantId, input.actorPrincipalId);
  const observedAt = Date.parse(input.observedAt);
  const createdAt = principal ? Date.parse(principal.created_at) : Number.NaN;
  const revokedAt = principal?.revoked_at ? Date.parse(principal.revoked_at) : null;
  const expiresAt = principal?.expires_at ? Date.parse(principal.expires_at) : null;
  const identityValid = principal?.kind === "human" ||
    principal?.kind === "service" && principal.subject === "release-dispatch-reconciliation";
  const privilegedHuman = principal?.kind !== "human" || Boolean(input.db.raw.prepare(
    `SELECT 1 FROM tenant_memberships
     WHERE tenant_id = ? AND subject = ? AND status = 'active'
       AND role IN ('owner', 'admin')
     LIMIT 1`,
  ).get(input.tenantId, principal.subject));
  if (
    !principal || !identityValid || !privilegedHuman || !Number.isFinite(observedAt) ||
    !Number.isFinite(createdAt) || createdAt > observedAt ||
    (revokedAt !== null && (!Number.isFinite(revokedAt) || revokedAt <= observedAt)) ||
    (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= observedAt))
  ) throw new Error("release_dispatch_reconciliation_authority_invalid");
}

function assertReachableReconciliationEvidence(input: Readonly<{
  db: AppDb;
  tenantId: string;
  dispatchId: string;
  evidenceSha256: string;
  observedAt: string;
}>): void {
  const row = input.db.raw.prepare(
    `SELECT e.created_at
     FROM evidence_records e
     JOIN artifact_manifests a
       ON a.id = e.artifact_id AND a.tenant_id = e.tenant_id
     WHERE e.tenant_id = ?
       AND e.subject_type = 'release_dispatch_reconciliation'
       AND e.subject_id = ?
       AND e.verdict = 'passed'
       AND a.sha256 = ?
     LIMIT 1`,
  ).get(input.tenantId, input.dispatchId, input.evidenceSha256) as
    { created_at: string } | undefined;
  const createdAt = Date.parse(row?.created_at ?? "");
  const observedAt = Date.parse(input.observedAt);
  if (!row || !Number.isFinite(createdAt) || !Number.isFinite(observedAt) || createdAt > observedAt) {
    throw new Error("release_dispatch_reconciliation_evidence_unreachable");
  }
}

function parseExactFlags(argv: readonly string[]): Readonly<Record<string, string>> {
  if (argv.length !== FLAGS.length * 2) {
    throw new Error("release_dispatch_reconciliation_arguments_invalid");
  }
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !FLAGS.includes(flag) || parsed[flag] !== undefined || !value?.trim()) {
      throw new Error("release_dispatch_reconciliation_arguments_invalid");
    }
    parsed[flag] = value;
  }
  if (FLAGS.some((flag) => parsed[flag] === undefined)) {
    throw new Error("release_dispatch_reconciliation_arguments_invalid");
  }
  return Object.freeze(parsed);
}

export function runReleaseDispatchReconciliationCommand(input: Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  db: AppDb;
  store: ReleaseIngestionStore;
  mutationFenceRoot: string;
  write?: (value: string) => void;
}>): Readonly<{ reconciliationId: string; dispatchId: string; action: ReleaseDispatchReconciliationAction }> {
  const flags = parseExactFlags(input.argv);
  const tenantId = flags["--tenant"]!;
  const action = flags["--action"];
  if (action !== "acknowledge" && action !== "requeue") {
    throw new Error("release_dispatch_reconciliation_action_invalid");
  }
  const generationText = flags["--expected-lease-generation"]!;
  if (!/^[1-9]\d*$/.test(generationText)) {
    throw new Error("release_dispatch_reconciliation_lease_generation_invalid");
  }
  const expectedLeaseGeneration = Number(generationText);
  if (!Number.isSafeInteger(expectedLeaseGeneration)) {
    throw new Error("release_dispatch_reconciliation_lease_generation_invalid");
  }
  const consumers = parseReleaseDispatchConsumersFromEnv(input.env)
    .filter((consumer) => consumer.tenantId === tenantId);
  if (consumers.length !== 1) {
    throw new Error("release_dispatch_reconciliation_consumer_binding_required");
  }
  const consumer = consumers[0]!;
  const actorPrincipalId = flags["--actor-principal-id"]!;
  if (
    actorPrincipalId === consumer.actorPrincipalId ||
    input.env[RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ENV]?.trim() !== actorPrincipalId
  ) throw new Error("release_dispatch_reconciliation_authority_binding_required");
  const mutationLease = tryAcquireMutationLease(input.mutationFenceRoot);
  if (!mutationLease) {
    throw new Error("release_dispatch_reconciliation_mutation_fence_unavailable");
  }
  let result: ReturnType<typeof reconcileReleaseDispatchFailure>;
  try {
    input.db.raw.exec("BEGIN IMMEDIATE");
    input.store.raw.exec("BEGIN IMMEDIATE");
    const observedAt = input.store.trustedNow();
    assertActiveReconciliationPrincipal({
      db: input.db,
      tenantId,
      actorPrincipalId,
      observedAt,
    });
    assertReachableReconciliationEvidence({
      db: input.db,
      tenantId,
      dispatchId: flags["--dispatch"]!,
      evidenceSha256: flags["--evidence-sha256"]!,
      observedAt,
    });
    result = reconcileReleaseDispatchFailure(input.store, {
      tenantId,
      dispatchId: flags["--dispatch"]!,
      action,
      actorPrincipalId,
      evidenceSha256: flags["--evidence-sha256"]!,
      expectedLeaseGeneration,
      expectedFailedAt: flags["--expected-failed-at"]!,
      expectedFailureCode: flags["--expected-failure-code"]!,
      idempotencyKey: flags["--idempotency-key"]!,
    });
    assertActiveReconciliationPrincipal({
      db: input.db,
      tenantId,
      actorPrincipalId,
      observedAt: input.store.trustedNow(),
    });
    input.store.raw.exec("COMMIT");
    input.db.raw.exec("COMMIT");
  } catch (error) {
    if (input.store.raw.isTransaction) input.store.raw.exec("ROLLBACK");
    if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    throw error;
  } finally {
    mutationLease.release();
  }
  const output = Object.freeze({
    reconciliationId: result.reconciliation.id,
    dispatchId: result.dispatch.id,
    action: result.reconciliation.action,
  });
  input.write?.(JSON.stringify(output));
  return output;
}
