import type {
  TransformerPilotExecutionStore,
  TransformerPilotCampaign,
  TransformerAttemptLease,
} from "@mendpoint/transformer";
import { resolveRenamedEnv } from "@mendpoint/shared";
import { assertTransformerWorkerActionAuthorized } from "./transformer-authorization.js";

type ClaimInput = Parameters<TransformerPilotExecutionStore["claimNextAttempt"]>[0];
type ObservationInput = Parameters<TransformerPilotExecutionStore["reconcileWave"]>[0];

export type TransformerPilotWorkerPort = Readonly<{
  claimNextAttempt(input: ClaimInput): TransformerAttemptLease | null;
  reconcileWave(input: ObservationInput): TransformerPilotCampaign;
}>;

export type TransformerPilotWorkerScope = Readonly<{
  tenantId: string;
  environment: string;
}>;

/**
 * Worker admission is a coordinator claim, never a direct recipe execution.
 * The gate is checked here and again by the durable store.
 */
export function admitTransformerPilotAttempt(
  port: TransformerPilotWorkerPort,
  scope: TransformerPilotWorkerScope,
  input: Omit<ClaimInput, "gateConfig">,
  rawGateConfig = resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_GATE"),
): TransformerAttemptLease | null {
  if (scope.tenantId !== input.tenantId) throw new Error("transformer_worker_tenant_mismatch");
  assertTransformerWorkerActionAuthorized(scope, rawGateConfig);
  return port.claimNextAttempt({ ...input, gateConfig: rawGateConfig });
}

/**
 * Observations contain external SCM evidence only. This path cannot open,
 * merge, close, or deploy a pull request.
 */
export function observeTransformerPilotWave(
  port: TransformerPilotWorkerPort,
  scope: TransformerPilotWorkerScope,
  input: Omit<ObservationInput, "gateConfig">,
  rawGateConfig = resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_GATE"),
): TransformerPilotCampaign {
  if (scope.tenantId !== input.tenantId) throw new Error("transformer_worker_tenant_mismatch");
  assertTransformerWorkerActionAuthorized(scope, rawGateConfig);
  return port.reconcileWave({ ...input, gateConfig: rawGateConfig });
}
