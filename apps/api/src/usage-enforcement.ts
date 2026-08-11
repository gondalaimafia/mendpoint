import {
  estimateRunMcuMicros,
  getUsageSummary,
  reserveRunUsage,
  type AppDb,
  type UsageSummary,
} from "@mendpoint/db";

/**
 * Run-admission quota enforcement for the API.
 *
 * Default-OFF: gated on MENDPOINT_USAGE_ENFORCEMENT === "1". When the flag is unset
 * or "0" the run path is byte-for-byte unchanged (no reserve, no 402). When the flag
 * is on, a run reserves its deterministic MCU estimate before work is admitted; a
 * tenant over quota (or with no plan provisioned) is rejected with HTTP 402.
 *
 * The reserve/settle/release ledger wrappers live in @mendpoint/db so the worker can
 * settle/release the same reservation on completion without depending on this package.
 */

export const USAGE_ENFORCEMENT_FLAG = "MENDPOINT_USAGE_ENFORCEMENT";

export function usageEnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[USAGE_ENFORCEMENT_FLAG] === "1";
}

export type RunUsageRejection = "usage_quota_exceeded" | "usage_entitlement_required";

export type RunUsageAdmission =
  | Readonly<{ enforced: false }>
  | Readonly<{ enforced: true; admitted: true; reservationId: string; reservedMcuMicros: number }>
  | Readonly<{
      enforced: true;
      admitted: false;
      status: 402;
      body: Readonly<{ error: RunUsageRejection; summary: UsageSummary }>;
    }>;

/**
 * Reserve a run's MCU ceiling at admission. Returns { enforced: false } when the flag
 * is off (caller proceeds unchanged). On quota/entitlement failure returns a ready-to
 * -serve 402 decision carrying the current usage summary. Any other ledger error (e.g.
 * a malformed reservation) is re-thrown for the caller's error boundary to map.
 */
export function admitRunUsage(
  db: AppDb,
  input: {
    tenantId: string;
    runId: string;
    mcuMicros: number;
    reason: string;
    campaignId?: string | null;
    actorPrincipalId?: string | null;
    createdAt: string;
    env?: NodeJS.ProcessEnv;
  },
): RunUsageAdmission {
  if (!usageEnforcementEnabled(input.env)) return Object.freeze({ enforced: false });
  try {
    const entry = reserveRunUsage(db, {
      tenantId: input.tenantId,
      runId: input.runId,
      mcuMicros: input.mcuMicros,
      reason: input.reason,
      campaignId: input.campaignId ?? null,
      actorPrincipalId: input.actorPrincipalId ?? null,
      createdAt: input.createdAt,
    });
    return Object.freeze({
      enforced: true,
      admitted: true,
      reservationId: entry.id,
      reservedMcuMicros: entry.reservedMcuMicrosDelta,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "usage_quota_exceeded" || code === "usage_entitlement_required") {
      return Object.freeze({
        enforced: true,
        admitted: false,
        status: 402,
        body: Object.freeze({
          error: code,
          summary: getUsageSummary(db, input.tenantId, input.createdAt),
        }),
      });
    }
    throw error;
  }
}

export { estimateRunMcuMicros };
