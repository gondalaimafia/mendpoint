import {
  authorizeTransformerDelivery,
  type TransformerGateDecision,
} from "@mendpoint/ops";
import { resolveRenamedEnv } from "@mendpoint/shared";

export type TransformerDeliveryAuthorizationInput = Readonly<{
  tenantId: string;
  environment: string;
  productionDeliveryApprovalRefs?: readonly string[];
}>;

/**
 * Required precondition for Transformer source control delivery. A successful
 * decision authorizes only the named boundary. It never approves, merges, or
 * deploys a change.
 */
export function assertTransformerDeliveryAuthorized(
  input: TransformerDeliveryAuthorizationInput,
  rawConfig = resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_GATE"),
): TransformerGateDecision {
  const decision = authorizeTransformerDelivery(input, rawConfig);
  if (!decision.allowed) {
    throw new Error(`transformer_delivery_denied:${decision.reasons.join(",")}`);
  }
  return decision;
}
