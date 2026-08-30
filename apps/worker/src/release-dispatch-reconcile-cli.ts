import {
  reconcileReleaseDispatchFailure,
  type ReleaseDispatchReconciliationAction,
  type ReleaseIngestionStore,
} from "@mendpoint/catalog";
import type { AppDb } from "@mendpoint/db";
import { parseReleaseDispatchConsumersFromEnv } from "./release-dispatch-drainer.js";
import {
  assertActiveReleaseDispatchPrincipal,
  ensureReleaseDispatchPrincipal,
} from "./release-dispatch-domain-event-sink.js";

const FLAGS = Object.freeze([
  "--tenant",
  "--dispatch",
  "--action",
  "--evidence-sha256",
  "--expected-lease-generation",
  "--expected-failed-at",
  "--expected-failure-code",
  "--idempotency-key",
]);

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
  ensureReleaseDispatchPrincipal({
    db: input.db,
    tenantId,
    actorPrincipalId: consumer.actorPrincipalId,
    observedAt: input.store.trustedNow(),
  });
  input.db.raw.exec("BEGIN IMMEDIATE");
  let result: ReturnType<typeof reconcileReleaseDispatchFailure>;
  try {
    const observedAt = input.store.trustedNow();
    assertActiveReleaseDispatchPrincipal({
      db: input.db,
      tenantId,
      actorPrincipalId: consumer.actorPrincipalId,
      observedAt,
    });
    result = reconcileReleaseDispatchFailure(input.store, {
      tenantId,
      dispatchId: flags["--dispatch"]!,
      action,
      actorPrincipalId: consumer.actorPrincipalId,
      evidenceSha256: flags["--evidence-sha256"]!,
      expectedLeaseGeneration,
      expectedFailedAt: flags["--expected-failed-at"]!,
      expectedFailureCode: flags["--expected-failure-code"]!,
      idempotencyKey: flags["--idempotency-key"]!,
    });
    assertActiveReleaseDispatchPrincipal({
      db: input.db,
      tenantId,
      actorPrincipalId: consumer.actorPrincipalId,
      observedAt,
    });
    input.db.raw.exec("COMMIT");
  } catch (error) {
    if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    throw error;
  }
  const output = Object.freeze({
    reconciliationId: result.reconciliation.id,
    dispatchId: result.dispatch.id,
    action: result.reconciliation.action,
  });
  input.write?.(JSON.stringify(output));
  return output;
}
