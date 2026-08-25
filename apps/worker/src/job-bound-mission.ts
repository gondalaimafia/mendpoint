/**
 * Resolve a job payload's claimed Mission id for best-effort writers (trajectory,
 * MCU). The three inputs are kept DISTINCT so a rejected claim is never silently
 * collapsed into "no mission":
 *   - none:     the payload named no mission. A NULL binding is legitimate.
 *   - bound:    the payload named a mission that resolves for THIS tenant.
 *   - rejected: the payload named a mission that does not resolve for this tenant
 *               (missing row, or another tenant's mission). The caller must NOT
 *               bind it; it records the rejected claim in provenance instead of
 *               writing a dangling / cross-tenant FK.
 * The inherited-context compiler keeps its own fail-closed throw when the flag is
 * on; this resolver governs only the best-effort forensic binding.
 */
import { getMission, type AppDb } from "@mendpoint/db";

export type BoundMissionResolution =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "bound"; missionId: string }>
  | Readonly<{ kind: "rejected"; claimedMissionId: string }>;

export function resolveBoundMission(
  db: AppDb,
  tenantId: string,
  payloadMissionId: unknown,
): BoundMissionResolution {
  if (typeof payloadMissionId !== "string" || !payloadMissionId.trim()) {
    return { kind: "none" };
  }
  const missionId = getMission(db, tenantId, payloadMissionId)?.id;
  if (!missionId) return { kind: "rejected", claimedMissionId: payloadMissionId };
  return { kind: "bound", missionId };
}
