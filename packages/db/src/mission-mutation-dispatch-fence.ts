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

function authorityTaskId(encoded: string): string | null {
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new Error("mission_mutation_dispatch_authority_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("taskId" in value)) {
    throw new Error("mission_mutation_dispatch_authority_invalid");
  }
  const taskId = (value as { taskId?: unknown }).taskId;
  if (taskId === null) return null;
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("mission_mutation_dispatch_authority_invalid");
  }
  return taskId;
}

/** Fence only the exact task authority, keeping sibling tasks independent. */
export function revokePendingMissionTaskMutationDispatches(
  db: AppDb,
  tenantId: string,
  missionId: string,
  taskId: string | null,
  observedAt: string,
): void {
  const rows = db.raw.prepare(`SELECT id, authority_json, state FROM mission_mutation_dispatches
    WHERE tenant_id = ? AND mission_id = ? AND state IN ('authorized','dispatching','uncertain')`).all(
    tenantId, missionId,
  ) as Array<{ id: string; authority_json: string; state: string }>;
  const matching = rows.filter((row) => authorityTaskId(row.authority_json) === taskId);
  if (matching.some((row) => row.state === "dispatching" || row.state === "uncertain")) {
    throw new Error("mission_mutation_dispatch_in_flight");
  }
  for (const row of matching) {
    db.raw.prepare(`UPDATE mission_mutation_dispatches
      SET state = 'revoked', revoked_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND state = 'authorized'`).run(
      observedAt, observedAt, row.id, tenantId,
    );
  }
}
