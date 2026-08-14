import {
  authorizeTransformerWorkerAction,
  type TransformerGateDecision,
} from "@mendpoint/ops";
import { resolveRenamedEnv } from "@mendpoint/shared";

export type TransformerWorkerAuthorizationInput = Readonly<{
  tenantId: string;
  environment: string;
}>;

/**
 * Required precondition for any future Transformer worker action. This module
 * does not execute an action and leaves the worker default denied.
 */
export function assertTransformerWorkerActionAuthorized(
  input: TransformerWorkerAuthorizationInput,
  rawConfig = resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_GATE"),
): TransformerGateDecision {
  const decision = authorizeTransformerWorkerAction(input, rawConfig);
  if (!decision.allowed) {
    throw new Error(`transformer_worker_action_denied:${decision.reasons.join(",")}`);
  }
  return decision;
}
