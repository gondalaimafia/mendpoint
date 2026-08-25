/**
 * Resolve a job payload's claimed Mission id for best-effort writers (trajectory,
 * MCU). A missing row is NOT a fabricated mission: return undefined so the
 * caller omits the FK rather than writing a dangling id. The inherited-context
 * compiler keeps its own fail-closed throw when the flag is on.
 */
import { getMission, type AppDb } from "@mendpoint/db";

export function boundMissionIdFromPayload(
  db: AppDb,
  tenantId: string,
  payloadMissionId: unknown,
): string | undefined {
  if (typeof payloadMissionId !== "string" || !payloadMissionId.trim()) return undefined;
  return getMission(db, tenantId, payloadMissionId)?.id;
}
