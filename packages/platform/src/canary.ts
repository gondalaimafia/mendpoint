/**
 * Canary + rollback hooks (interfaces). Agents gate deploys; no silent production push.
 */
export type CanaryPolicy = {
  /** 0–100 traffic percentage */
  percent: number;
  /** Auto-rollback if error rate exceeds this (0–1) */
  maxErrorRate: number;
  /** Require human approval before canary */
  requireHumanApproval: boolean;
};

export const DEFAULT_CANARY: CanaryPolicy = {
  percent: 5,
  maxErrorRate: 0.02,
  requireHumanApproval: true,
};

export type CanaryDecision = {
  allowDeploy: boolean;
  action: "hold" | "canary" | "rollback" | "full";
  reasons: string[];
};

export function evaluateCanary(input: {
  policy?: Partial<CanaryPolicy>;
  humanApproved?: boolean;
  observedErrorRate?: number;
  previousAction?: CanaryDecision["action"];
}): CanaryDecision {
  const p = { ...DEFAULT_CANARY, ...input.policy };
  const reasons: string[] = [];

  if (p.requireHumanApproval && !input.humanApproved) {
    reasons.push("human approval required before canary (default)");
    return { allowDeploy: false, action: "hold", reasons };
  }

  if (
    input.observedErrorRate != null &&
    input.observedErrorRate > p.maxErrorRate
  ) {
    reasons.push(
      `error rate ${(input.observedErrorRate * 100).toFixed(2)}% > max ${(p.maxErrorRate * 100).toFixed(2)}% — rollback`,
    );
    return { allowDeploy: false, action: "rollback", reasons };
  }

  if (input.previousAction === "canary" && input.humanApproved) {
    reasons.push("canary healthy — eligible for full rollout after human confirm");
    return { allowDeploy: true, action: "full", reasons };
  }

  reasons.push(`canary at ${p.percent}% traffic`);
  return { allowDeploy: true, action: "canary", reasons };
}

/** Cross-PR rollback signal when a downstream DAG node fails fidelity. */
export type CrossPrRollback = {
  campaignId: string;
  failedNodeId: string;
  upstreamNodeIds: string[];
  reason: string;
};

export function planCrossPrRollback(
  campaignId: string,
  failedNodeId: string,
  dependsOnChain: string[],
  reason: string,
): CrossPrRollback {
  return {
    campaignId,
    failedNodeId,
    upstreamNodeIds: dependsOnChain,
    reason,
  };
}
