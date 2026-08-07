import {
  listPendingAdaptiveRegenerations,
  markAdaptiveRegenerationBlocked,
  type AppDb,
} from "@mendpoint/db";
import type { TransformerPilotExecutionStore } from "@mendpoint/transformer";

export const TRANSFORMER_REGENERATION_AUTHORIZATION_REQUIRED =
  "external_processing_authorization_required";

export type TransformerAdaptiveRegenerationStore = Pick<
  TransformerPilotExecutionStore,
  "control"
>;

export type TransformerAdaptiveRegenerationResult = Readonly<{
  considered: number;
  blocked: number;
  scheduled: number;
  failed: number;
  errors: readonly string[];
}>;

/**
 * Preserve durable, human-attributed regeneration requests until the customer
 * explicitly authorizes sending feedback to the configured model. This path
 * performs no pilot mutation and no external call.
 */
export function processTransformerAdaptiveRegenerations(
  db: AppDb,
  store: TransformerAdaptiveRegenerationStore,
  input: Readonly<{
    tenantId?: string;
    limit?: number;
    observedAt: string;
  }>,
): TransformerAdaptiveRegenerationResult {
  const requests = listPendingAdaptiveRegenerations(
    db,
    input.tenantId,
    input.limit ?? 25,
  );
  let blocked = 0;
  let scheduled = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const request of requests) {
    try {
      markAdaptiveRegenerationBlocked(db, {
        tenantId: request.tenantId,
        id: request.id,
        reason: TRANSFORMER_REGENERATION_AUTHORIZATION_REQUIRED,
        observedAt: input.observedAt,
      });
      blocked += 1;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const code = /^[A-Za-z0-9][A-Za-z0-9._,:-]{0,499}$/.test(raw)
        ? raw
        : "transformer_adaptive_regeneration_internal_error";
      errors.push(code);
      failed += 1;
    }
  }
  return Object.freeze({
    considered: requests.length,
    blocked,
    scheduled,
    failed,
    errors: Object.freeze(errors),
  });
}
