import {
  TRANSFORMER_GATE_BOUNDARIES,
  TRANSFORMER_GATE_SCHEMA_VERSION,
  parseTransformerGateConfig,
  type TransformerGateBoundary,
  type TransformerGateConfig,
} from "./transformer-gate.js";

// ---------------------------------------------------------------------------
// Transformer bounded-pilot enablement (Stage T5).
//
// This module PREPARES the prove-then-enable flip; it never applies it. It
// produces a single valid TransformerGateConfig that grants exactly ONE named
// pilot tenant in ONE named environment, carrying the passing end-to-end canary
// as its acceptance evidence. Nothing here sets a production secret, changes the
// gate default (unset => denied), or weakens assessTransformerGate. The
// customer-warden profile stays Transformer-off and forbids any gate config;
// this generator is used only when a human deliberately applies the runbook in
// docs/TRANSFORMER_ENABLEMENT.md.
// ---------------------------------------------------------------------------

// Stable acceptance-evidence reference for the passing Transformer end-to-end
// canary (packages/eval/src/transformer-canary.ts). It binds a generated pilot
// grant to the canary corpus version whose report `passed` is the T5 go/no-go
// signal. The canary is SYNTHETIC (mock SCM, synthetic fixtures); a real
// customer-repository proof is a separate, still-pending step.
export const TRANSFORMER_CANARY_ACCEPTANCE_EVIDENCE_REF =
  "acceptance:transformer-canary:2026-08-11.v1" as const;

// Clearly-fake sample identifiers for documentation and tests. These are NOT a
// real customer; a real pilot is passed explicitly through the runbook.
export const PILOT_SAMPLE_TENANT_ID = "tenant-pilot-example" as const;
export const PILOT_SAMPLE_ENVIRONMENT = "production" as const;
export const PILOT_SAMPLE_DELIVERY_APPROVAL_REF =
  "approval:transformer-pilot-delivery:example" as const;

export type PilotTransformerEnablementOptions = Readonly<{
  // The single pilot tenant the generated grant enables. Never a real customer
  // id in checked-in code or the sample; supplied explicitly at flip time.
  tenantId: string;
  // The single environment the grant applies to (for example "staging" or
  // "production").
  environment: string;
  // Boundaries to grant. Defaults to all four Transformer boundaries.
  boundaries?: readonly TransformerGateBoundary[];
  // Acceptance evidence references. Defaults to the passing canary reference.
  acceptanceEvidenceRefs?: readonly string[];
  // External production-delivery approval references. Required only for a
  // delivery grant in the production environment.
  productionDeliveryApprovalRefs?: readonly string[];
}>;

/**
 * Produce a valid, frozen TransformerGateConfig that enables exactly one pilot
 * tenant in one environment for the requested boundaries, referencing the
 * passing canary as acceptance evidence. The result is validated and frozen
 * through the gate's own parser, so the generator can only ever emit a
 * configuration assessTransformerGate accepts. Invalid identifiers, duplicate
 * entries, or unknown boundaries surface as the gate's own error codes.
 */
export function generatePilotTransformerGateConfig(
  options: PilotTransformerEnablementOptions,
): TransformerGateConfig {
  const boundaries = options.boundaries ?? TRANSFORMER_GATE_BOUNDARIES;
  const acceptanceEvidenceRefs =
    options.acceptanceEvidenceRefs ?? [TRANSFORMER_CANARY_ACCEPTANCE_EVIDENCE_REF];
  const productionDeliveryApprovalRefs = options.productionDeliveryApprovalRefs ?? [];

  if (boundaries.length === 0) {
    throw new Error("transformer_enablement_boundaries_required");
  }
  if (acceptanceEvidenceRefs.length === 0) {
    throw new Error("transformer_enablement_acceptance_evidence_required");
  }
  // A delivery grant in production stays fail-closed unless it carries a
  // matching production-delivery approval reference. Refuse to emit a grant that
  // could never allow its own delivery boundary rather than emit a silently
  // dead grant.
  if (
    options.environment === "production" &&
    boundaries.includes("delivery") &&
    productionDeliveryApprovalRefs.length === 0
  ) {
    throw new Error("transformer_enablement_production_delivery_approval_required");
  }

  const config = {
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: [options.tenantId],
    environmentAllowlist: [options.environment],
    grants: [
      {
        tenantId: options.tenantId,
        environment: options.environment,
        boundaries: [...boundaries],
        acceptanceEvidenceRefs: [...acceptanceEvidenceRefs],
        productionDeliveryApprovalRefs: [...productionDeliveryApprovalRefs],
      },
    ],
  };

  return parseTransformerGateConfig(JSON.stringify(config));
}

/**
 * Serialize a pilot gate config to the exact JSON string a human sets as the
 * MENDPOINT_TRANSFORMER_GATE production secret. This does not set the secret; it
 * only renders the value the runbook instructs an operator to apply.
 */
export function serializePilotTransformerGateConfig(
  options: PilotTransformerEnablementOptions,
): string {
  return JSON.stringify(generatePilotTransformerGateConfig(options));
}

/**
 * A clearly-fake sample pilot config: the example tenant in production with all
 * four boundaries and a sample production-delivery approval reference. For
 * documentation and tests only; it never names a real customer.
 */
export function samplePilotTransformerGateConfig(): TransformerGateConfig {
  return generatePilotTransformerGateConfig({
    tenantId: PILOT_SAMPLE_TENANT_ID,
    environment: PILOT_SAMPLE_ENVIRONMENT,
    productionDeliveryApprovalRefs: [PILOT_SAMPLE_DELIVERY_APPROVAL_REF],
  });
}
