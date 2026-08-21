import {
  findActiveLearningConsent,
  listPendingAdaptiveRegenerations,
  markAdaptiveRegenerationBlocked,
  markAdaptiveRegenerationScheduled,
  recordAdaptiveRegenerationScheduleFailure,
  type AppDb,
} from "@mendpoint/db";
import type { TransformerPilotExecutionStore } from "@mendpoint/transformer";

/**
 * Persisted reason when no active consent authorizes sending reviewer
 * corrections for external processing. The request stays recoverably pending.
 */
export const TRANSFORMER_REGENERATION_AUTHORIZATION_REQUIRED =
  "external_processing_authorization_required";

/**
 * Persisted reason when the consent state could not be determined (the consent
 * store was unreadable). Fails closed exactly like the no-consent case, but is
 * kept a distinct value so "we could not tell" never collapses into the clean
 * "no consent granted" outcome.
 */
export const TRANSFORMER_REGENERATION_CONSENT_INDETERMINATE =
  "external_processing_consent_indeterminate";

/**
 * Purpose scoping the consent that authorizes sending human review corrections
 * to a ReGauge regeneration agent for external processing. A distinct free-text
 * purpose value (the column has no CHECK constraint, so this is a data value,
 * not a schema change); it never overloads a learning-corpus purpose. An
 * operator enables regeneration for a tenant by granting a learning consent for
 * exactly this purpose (see grantLearningConsent); revoking it blocks again on
 * the next reconciliation with no redeploy.
 */
export const TRANSFORMER_REGENERATION_CONSENT_PURPOSE =
  "regauge-adaptive-regeneration";

export type TransformerAdaptiveRegenerationStore = Pick<
  TransformerPilotExecutionStore,
  "control"
>;

export type TransformerAdaptiveRegenerationResult = Readonly<{
  considered: number;
  blocked: number;
  indeterminate: number;
  scheduled: number;
  failed: number;
  errors: readonly string[];
}>;

function safeCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return /^[A-Za-z0-9][A-Za-z0-9._,:-]{0,499}$/.test(raw)
    ? raw
    : "transformer_adaptive_regeneration_internal_error";
}

/**
 * Reconcile durable, human-attributed regeneration requests against tenant
 * consent. A request reaches a ReGauge agent (transitions to `scheduled`) only
 * when the tenant holds an active, unambiguous consent for
 * {@link TRANSFORMER_REGENERATION_CONSENT_PURPOSE}; otherwise it stays
 * recoverably pending. Consent is re-queried on every call, so a later
 * revocation blocks subsequent requests with no redeploy and no restart.
 *
 * Fails closed: absence of consent blocks, and an unreadable consent state also
 * blocks under a distinct reason. The four outcomes — blocked (no consent),
 * indeterminate (unreadable consent), scheduled, and failed (scheduling error)
 * — are each carried by their own counter and by a distinct persisted marker,
 * so no single field is asked to encode more than one state.
 *
 * The reviewer rationale carried on each request is untrusted data, never an
 * instruction: this path decides solely on consent and never reads the
 * rationale, so instruction-like reviewer text cannot authorize a request or
 * alter its outcome. The rationale is persisted verbatim as inert data.
 */
export function processTransformerAdaptiveRegenerations(
  db: AppDb,
  _store: TransformerAdaptiveRegenerationStore,
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
  let indeterminate = 0;
  let scheduled = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const request of requests) {
    let consent;
    try {
      consent = findActiveLearningConsent(db, {
        tenantId: request.tenantId,
        purpose: TRANSFORMER_REGENERATION_CONSENT_PURPOSE,
        at: input.observedAt,
      });
    } catch (error) {
      // The consent store could not be read. Fail closed: keep the request
      // recoverably pending under a reason distinct from a clean no-consent
      // block so an operator can tell "unreadable" from "not granted".
      try {
        markAdaptiveRegenerationBlocked(db, {
          tenantId: request.tenantId,
          id: request.id,
          reason: TRANSFORMER_REGENERATION_CONSENT_INDETERMINATE,
          observedAt: input.observedAt,
        });
        indeterminate += 1;
        errors.push(safeCode(error));
      } catch (blockError) {
        errors.push(safeCode(blockError));
        failed += 1;
      }
      continue;
    }
    if (!consent) {
      // No active consent (none granted, or ambiguous across residencies):
      // stay blocked. Never scheduled.
      try {
        markAdaptiveRegenerationBlocked(db, {
          tenantId: request.tenantId,
          id: request.id,
          reason: TRANSFORMER_REGENERATION_AUTHORIZATION_REQUIRED,
          observedAt: input.observedAt,
        });
        blocked += 1;
      } catch (error) {
        errors.push(safeCode(error));
        failed += 1;
      }
      continue;
    }
    // Active consent: authorize the request to reach a ReGauge agent.
    try {
      markAdaptiveRegenerationScheduled(db, {
        tenantId: request.tenantId,
        id: request.id,
        observedAt: input.observedAt,
      });
      scheduled += 1;
    } catch (error) {
      const code = safeCode(error);
      try {
        recordAdaptiveRegenerationScheduleFailure(db, {
          tenantId: request.tenantId,
          id: request.id,
          errorCode: code,
          observedAt: input.observedAt,
        });
      } catch {
        // Best effort: the failure is still reflected in the count and errors.
      }
      errors.push(code);
      failed += 1;
    }
  }
  return Object.freeze({
    considered: requests.length,
    blocked,
    indeterminate,
    scheduled,
    failed,
    errors: Object.freeze(errors),
  });
}
