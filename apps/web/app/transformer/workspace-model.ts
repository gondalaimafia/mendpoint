export type CampaignState =
  | "draft"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

type Revisioned = {
  id: string;
  state: string;
  revision: number;
  createdAt: string;
};

export type TransformerCampaignView = {
  campaign: Revisioned & {
    state: CampaignState;
    name: string;
    sourceSystem: string;
    targetSystem: string;
    blueprintId: string;
    bsgId: string;
  };
  blueprint: Revisioned & {
    objective: string;
    content: Record<string, unknown>;
    policy: {
      ownerIds: string[];
      risks: Array<{
        id: string;
        statement: string;
        severity: "low" | "medium" | "high" | "critical";
        ownerId: string;
        evidenceRefs: string[];
      }>;
      unknowns: Array<{
        id: string;
        question: string;
        ownerId: string;
        evidenceRefs: string[];
      }>;
      verification: { commands: string[] };
      rollback: { strategy: "inverse_operations"; verificationCommands: string[] };
      approval: { required: true; reviewerIds: string[] };
      recipe: { id: string; version: string; digest: string };
    };
  };
  bsg: Revisioned & {
    nodes: Array<{ id: string; kind: string; spec: string; sourceRefs: string[] }>;
    edges: Array<{ id: string; from: string; to: string; kind: string }>;
  };
};

export type TransformerEventView = {
  sequence: number;
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  evidenceRefs: readonly string[];
  createdAt: string;
};

export type DependencyWave = { index: number; nodeIds: string[] };

export type TransformerMetrics = {
  campaignCompletionPercent: number;
  waveCompletionPercent: number;
  acceptancePercent: number | null;
  timeToFirstAcceptedPrMinutes: number | null;
  openExceptions: number;
  verificationPercent: number | null;
  rollbackRequests: number;
  legacyReductionPercent: number | null;
  reviewerMinutesDelta: number | null;
  costUsd: number | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

function latestByEntity(events: readonly TransformerEventView[]): Map<string, TransformerEventView> {
  const latest = new Map<string, TransformerEventView>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    latest.set(`${event.entityType}:${event.entityId}`, event);
  }
  return latest;
}

export function dependencyWaves(bsg: TransformerCampaignView["bsg"]): DependencyWave[] {
  const nodeIds = [...new Set(bsg.nodes.map((node) => node.id))].sort();
  const known = new Set(nodeIds);
  const predecessors = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  for (const edge of bsg.edges) {
    if (known.has(edge.from) && known.has(edge.to)) predecessors.get(edge.to)?.add(edge.from);
  }

  const remaining = new Set(nodeIds);
  const completed = new Set<string>();
  const waves: DependencyWave[] = [];
  while (remaining.size > 0) {
    let ready = [...remaining]
      .filter((id) => [...(predecessors.get(id) ?? [])].every((dependency) => completed.has(dependency)))
      .sort();
    if (ready.length === 0) throw new Error("transformer_dependency_cycle");
    waves.push({ index: waves.length + 1, nodeIds: ready });
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return waves;
}

export function campaignAction(
  state: CampaignState,
  action: "pause" | "retry" | "rollback",
): { allowed: boolean; nextState: CampaignState | null } {
  if (action === "pause") return { allowed: state === "running", nextState: state === "running" ? "paused" : null };
  if (action === "retry") return { allowed: state === "paused", nextState: state === "paused" ? "running" : null };
  const allowed = state === "draft" || state === "ready" || state === "running" || state === "paused";
  return { allowed, nextState: allowed ? "cancelled" : null };
}

export function deriveTransformerWorkspace(
  view: TransformerCampaignView,
  events: readonly TransformerEventView[],
) {
  const latest = latestByEntity(events);
  const waves = dependencyWaves(view.bsg);
  const completedNodeIds = new Set(
    view.bsg.nodes
      .filter((node) => latest.get(`unit:${node.id}`)?.payload.state === "completed")
      .map((node) => node.id),
  );
  const completedWaves = waves.filter((wave) =>
    wave.nodeIds.every((nodeId) => completedNodeIds.has(nodeId)),
  ).length;

  const prApprovalIds = new Set(
    events
      .filter((event) => event.entityType === "approval" && event.payload.subjectType === "pr")
      .map((event) => event.entityId),
  );
  const approvals = [...latest.entries()]
    .filter(([key, event]) =>
      key.startsWith("approval:") &&
      (prApprovalIds.has(event.entityId) || event.payload.subjectType === "pr"),
    )
    .map(([, event]) => event);
  const decidedApprovals = approvals.filter((event) =>
    event.payload.state === "approved" || event.payload.state === "rejected",
  );
  const acceptedApprovals = decidedApprovals.filter((event) => event.payload.state === "approved");
  const firstAcceptedAt = acceptedApprovals
    .map((event) => Date.parse(event.createdAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const campaignStartedAt = Date.parse(view.campaign.createdAt);

  const exceptions = [...latest.entries()]
    .filter(([key]) => key.startsWith("exception:"))
    .map(([, event]) => event);
  const openExceptions = exceptions.filter((event) =>
    event.payload.state === "open" || event.payload.state === "acknowledged",
  ).length;

  const attempts = [...latest.entries()]
    .filter(([key]) => key.startsWith("attempt:"))
    .map(([, event]) => event)
    .filter((event) => event.payload.state === "succeeded" || event.payload.state === "failed");
  const verifiedAttempts = attempts.filter((event) => event.payload.state === "succeeded");

  const rollbackRequests = events.filter((event) =>
    event.type.includes("rollback") || event.evidenceRefs.includes("operator:rollback-request"),
  ).length;
  const legacyBefore = finiteNumber(view.blueprint.content.legacyNodesBefore);
  const legacyAfter = finiteNumber(view.blueprint.content.legacyNodesAfter);
  const reviewerBaseline = finiteNumber(view.blueprint.content.reviewerMinutesBaseline);
  const reviewerCurrent = finiteNumber(view.blueprint.content.reviewerMinutesCurrent);
  const costs = events
    .map((event) => finiteNumber(event.payload.costUsd))
    .filter((value): value is number => value !== null);

  const metrics: TransformerMetrics = {
    campaignCompletionPercent: percent(completedNodeIds.size, view.bsg.nodes.length),
    waveCompletionPercent: percent(completedWaves, waves.length),
    acceptancePercent: decidedApprovals.length
      ? percent(acceptedApprovals.length, decidedApprovals.length)
      : null,
    timeToFirstAcceptedPrMinutes:
      firstAcceptedAt !== undefined && Number.isFinite(campaignStartedAt)
        ? Math.max(0, Math.round((firstAcceptedAt - campaignStartedAt) / 60_000))
        : null,
    openExceptions,
    verificationPercent: attempts.length ? percent(verifiedAttempts.length, attempts.length) : null,
    rollbackRequests,
    legacyReductionPercent:
      legacyBefore !== null && legacyAfter !== null && legacyBefore > 0
        ? percent(legacyBefore - legacyAfter, legacyBefore)
        : null,
    reviewerMinutesDelta:
      reviewerBaseline !== null && reviewerCurrent !== null
        ? reviewerCurrent - reviewerBaseline
        : null,
    costUsd: costs.length ? Number(costs.reduce((total, cost) => total + cost, 0).toFixed(2)) : null,
  };

  return {
    waves,
    nodeStates: new Map(
      view.bsg.nodes.map((node) => [
        node.id,
        String(latest.get(`unit:${node.id}`)?.payload.state ?? "planned"),
      ]),
    ),
    progress: {
      completedNodes: completedNodeIds.size,
      totalNodes: view.bsg.nodes.length,
      completedWaves,
      totalWaves: waves.length,
    },
    metrics,
    exceptions,
  };
}
