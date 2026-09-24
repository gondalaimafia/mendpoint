/**
 * Run-admission quota enforcement for the API.
 *
 * The implementation now lives in @mendpoint/db (usage-run.ts) so the API and the
 * worker admit through one shared, tenant-scoped path (the worker re-admits a
 * delivery-only retry's full-pipeline fallback). This module re-exports it so the
 * API's existing call sites and tests are unchanged.
 *
 * Default-OFF: gated on MENDPOINT_USAGE_ENFORCEMENT === "1". When the flag is unset
 * or "0" the run path is byte-for-byte unchanged (no reserve, no 402).
 */
export {
  admitRunUsage,
  estimateRunMcuMicros,
  usageEnforcementEnabled,
  USAGE_ENFORCEMENT_FLAG,
  type RunUsageAdmission,
  type RunUsageRejection,
} from "@mendpoint/db";
