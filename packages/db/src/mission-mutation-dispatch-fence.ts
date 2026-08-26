import type { AppDb } from "./index.js";

/**
 * Mission/blocker writers call this while holding BEGIN IMMEDIATE. An authorized
 * but not-yet-dispatched mutation is revoked so the control-plane write wins.
 * Dispatching or uncertain means the remote side effect may exist; fail closed
 * until exact reconciliation settles it.
 */
export function revokePendingMissionMutationDispatches(
  db: AppDb,
  tenantId: string,
  missionId: string,
  observedAt: string,
): void {
  const active = db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
    WHERE tenant_id = ? AND mission_id = ? AND state IN ('dispatching','uncertain') LIMIT 1`).get(
    tenantId, missionId,
  ) as { state: string } | undefined;
  if (active) throw new Error("mission_mutation_dispatch_in_flight");
  db.raw.prepare(`UPDATE mission_mutation_dispatches
    SET state = 'revoked', revoked_at = ?, updated_at = ?
    WHERE tenant_id = ? AND mission_id = ? AND state = 'authorized'`).run(
    observedAt, observedAt, tenantId, missionId,
  );
}
