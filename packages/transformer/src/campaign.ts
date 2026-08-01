import { newId, nowIso } from "@mendpoint/shared";
import { addStep, emptyPlan, type AgentPlan } from "@mendpoint/orchestrator";
import type {
  BsgEdge,
  BsgNode,
  BehavioralSpecGraph,
  MigrationCampaign,
  MigrationDagNode,
} from "./types.js";

const MAX_CAMPAIGN_NODES = 500;
const MAX_BSG_NODES = 2_000;
const MAX_BSG_EDGES = 4_000;
const MAX_TEXT_LENGTH = 200;

export class CampaignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignValidationError";
  }
}

function requiredText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CampaignValidationError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CampaignValidationError(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function boundedArray(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new CampaignValidationError(`${field} must be an array`);
  if (value.length > max) {
    throw new CampaignValidationError(`${field} must contain ${max} entries or fewer`);
  }
  return value;
}

function validateBsg(value: unknown): BehavioralSpecGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CampaignValidationError("bsg must be an object");
  }
  const graph = value as Record<string, unknown>;
  const nodes = boundedArray(graph.nodes, "bsg.nodes", MAX_BSG_NODES).map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CampaignValidationError(`bsg.nodes[${index}] must be an object`);
    }
    const node = entry as Record<string, unknown>;
    const kind = node.kind;
    if (!(["precondition", "postcondition", "invariant", "behavior"] as unknown[]).includes(kind)) {
      throw new CampaignValidationError(`bsg.nodes[${index}].kind is invalid`);
    }
    const sourceRefs = node.sourceRefs === undefined
      ? undefined
      : boundedArray(node.sourceRefs, `bsg.nodes[${index}].sourceRefs`, 100).map(
          (sourceRef, refIndex) => requiredText(sourceRef, `bsg.nodes[${index}].sourceRefs[${refIndex}]`),
        );
    return {
      id: requiredText(node.id, `bsg.nodes[${index}].id`),
      kind: kind as BsgNode["kind"],
      label: requiredText(node.label, `bsg.nodes[${index}].label`),
      spec: requiredText(node.spec, `bsg.nodes[${index}].spec`, 10_000),
      ...(sourceRefs ? { sourceRefs } : {}),
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) {
    throw new CampaignValidationError("bsg.nodes contains duplicate ids");
  }
  const edges = boundedArray(graph.edges, "bsg.edges", MAX_BSG_EDGES).map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CampaignValidationError(`bsg.edges[${index}] must be an object`);
    }
    const edge = entry as Record<string, unknown>;
    const kind = edge.kind;
    if (!(["implies", "orders", "refines"] as unknown[]).includes(kind)) {
      throw new CampaignValidationError(`bsg.edges[${index}].kind is invalid`);
    }
    const from = requiredText(edge.from, `bsg.edges[${index}].from`);
    const to = requiredText(edge.to, `bsg.edges[${index}].to`);
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new CampaignValidationError(`bsg.edges[${index}] references an unknown node`);
    }
    return {
      id: requiredText(edge.id, `bsg.edges[${index}].id`),
      from,
      to,
      kind: kind as BsgEdge["kind"],
    };
  });
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
    throw new CampaignValidationError("bsg.edges contains duplicate ids");
  }
  return {
    id: requiredText(graph.id, "bsg.id"),
    title: requiredText(graph.title, "bsg.title"),
    sourceSystem: requiredText(graph.sourceSystem, "bsg.sourceSystem"),
    targetSystem: requiredText(graph.targetSystem, "bsg.targetSystem"),
    nodes,
    edges,
  };
}

export type CampaignInput = {
  name: string;
  sourceSystem: string;
  targetStack: string;
  dag: Omit<MigrationDagNode, "status">[];
  bsg?: BehavioralSpecGraph;
};

export function validateCampaignInput(input: unknown): CampaignInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CampaignValidationError("campaign body must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (!Array.isArray(candidate.dag) || candidate.dag.length === 0) {
    throw new CampaignValidationError("dag must contain at least one node");
  }
  if (candidate.dag.length > MAX_CAMPAIGN_NODES) {
    throw new CampaignValidationError(`dag must contain ${MAX_CAMPAIGN_NODES} nodes or fewer`);
  }
  const dag = candidate.dag.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CampaignValidationError(`dag[${index}] must be an object`);
    }
    const node = value as Record<string, unknown>;
    if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) {
      throw new CampaignValidationError(`dag[${index}].dependsOn must be an array`);
    }
    const dependsOn = (node.dependsOn ?? []).map((dependency, dependencyIndex) =>
      requiredText(dependency, `dag[${index}].dependsOn[${dependencyIndex}]`),
    );
    if (dependsOn.length > MAX_CAMPAIGN_NODES) {
      throw new CampaignValidationError(
        `dag[${index}].dependsOn must contain ${MAX_CAMPAIGN_NODES} entries or fewer`,
      );
    }
    return {
      id: requiredText(node.id, `dag[${index}].id`),
      title: requiredText(node.title, `dag[${index}].title`),
      repoKey: requiredText(node.repoKey, `dag[${index}].repoKey`),
      dependsOn,
    };
  });
  return {
    name: requiredText(candidate.name, "name"),
    sourceSystem: requiredText(candidate.sourceSystem, "sourceSystem"),
    targetStack: requiredText(candidate.targetStack, "targetStack"),
    dag,
    ...(candidate.bsg !== undefined ? { bsg: validateBsg(candidate.bsg) } : {}),
  };
}

export function emptyBsg(partial: {
  title: string;
  sourceSystem: string;
  targetSystem: string;
}): BehavioralSpecGraph {
  return {
    id: newId(),
    title: partial.title,
    sourceSystem: partial.sourceSystem,
    targetSystem: partial.targetSystem,
    nodes: [],
    edges: [],
  };
}

/** Topological order of DAG nodes (Kahn). Rejects malformed campaign graphs. */
export function orderDag(nodes: MigrationDagNode[]): MigrationDagNode[] {
  if (!nodes.length) throw new CampaignValidationError("Migration DAG must contain at least one node");
  const byId = new Map<string, MigrationDagNode>();
  for (const node of nodes) {
    if (!node.id.trim()) throw new CampaignValidationError("Migration DAG node id is required");
    if (!node.repoKey.trim()) {
      throw new CampaignValidationError(`Migration DAG node ${node.id} requires a repoKey`);
    }
    if (byId.has(node.id)) {
      throw new CampaignValidationError(`Migration DAG has duplicate node id: ${node.id}`);
    }
    byId.set(node.id, node);
  }
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const dependents = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const n of nodes) {
    const uniqueDependencies = new Set(n.dependsOn);
    if (uniqueDependencies.size !== n.dependsOn.length) {
      throw new CampaignValidationError(`Migration DAG node ${n.id} contains duplicate dependencies`);
    }
    for (const dependencyId of uniqueDependencies) {
      if (dependencyId === n.id) {
        throw new CampaignValidationError(`Migration DAG node ${n.id} cannot depend on itself`);
      }
      if (!byId.has(dependencyId)) {
        throw new CampaignValidationError(
          `Migration DAG node ${n.id} has unknown dependency: ${dependencyId}`,
        );
      }
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
      dependents.get(dependencyId)!.push(n.id);
    }
  }
  const q = nodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b));
  const out: MigrationDagNode[] = [];
  while (q.length) {
    const id = q.shift()!;
    const n = byId.get(id)!;
    out.push(n);
    for (const dependentId of dependents.get(id)!.sort((a, b) => a.localeCompare(b))) {
      const next = (indeg.get(dependentId) ?? 1) - 1;
      indeg.set(dependentId, next);
      if (next === 0) {
        q.push(dependentId);
        q.sort((a, b) => a.localeCompare(b));
      }
    }
  }
  if (out.length !== nodes.length) {
    const blocked = nodes
      .filter((node) => !out.some((ordered) => ordered.id === node.id))
      .map((node) => node.id)
      .sort();
    throw new CampaignValidationError(`Migration DAG has a cycle involving: ${blocked.join(", ")}`);
  }
  return out;
}

export function createCampaign(rawInput: CampaignInput | unknown): MigrationCampaign {
  const input = validateCampaignInput(rawInput);
  const dag = input.dag.map((d) => ({ ...d, status: "pending" as const }));
  orderDag(dag);
  const bsg =
    input.bsg ??
    emptyBsg({
      title: `${input.name} BSG`,
      sourceSystem: input.sourceSystem,
      targetSystem: input.targetStack,
    });
  return {
    id: newId(),
    name: input.name,
    sourceSystem: input.sourceSystem,
    targetStack: input.targetStack,
    bsg,
    dag,
    createdAt: nowIso(),
  };
}

/** Plan-of-record for a campaign: one step per DAG node in topo order. */
export function planFromCampaign(campaign: MigrationCampaign): AgentPlan {
  const ordered = orderDag(campaign.dag);
  let plan = emptyPlan({
    kind: "bsg_campaign",
    title: `Transformer campaign: ${campaign.name}`,
    goal: `Migrate ${campaign.sourceSystem} → ${campaign.targetStack} with behavioral parity`,
    agent: "transformer",
    metadata: {
      campaignId: campaign.id,
      planOfRecord: "bsg_dag",
      bsgId: campaign.bsg.id,
    },
  });
  plan = addStep(plan, {
    title: "Lock Behavioral Specification Graph",
    action: "bsg.lock",
    successCriteria: [
      "BSG pre/post/invariants recorded",
      "No migration PR without BSG ref",
    ],
  });
  for (const n of ordered) {
    plan = addStep(plan, {
      title: n.title,
      action: "dag.pr_unit",
      ref: n.id,
      successCriteria: [
        `Repo unit: ${n.repoKey}`,
        "Differential traces pass or waived",
        "PR-per-DAG-node opened (human review)",
      ],
      notes: n.dependsOn.length
        ? `dependsOn: ${n.dependsOn.join(", ")}`
        : undefined,
    });
  }
  plan = addStep(plan, {
    title: "Campaign fidelity critic vs BSG",
    action: "critic.bsg_fidelity",
    successCriteria: ["Read-only critic report attached", "Blocking gaps escalated to domain expert"],
  });
  return plan;
}

function canonicalValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Infinity) return "number:Infinity";
    if (value === -Infinity) return "number:-Infinity";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${value}`;
  }
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error(`unsupported output value: ${typeof value}`);
  }
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("cyclic output cannot be compared");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return `array:[${value.map((item) => canonicalValue(item, seen)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("unsupported output object type");
      }
      return `object:{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item, seen)}`)
        .join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }
  throw new Error("unsupported output value");
}

/** Protocol-neutral structural comparison for deterministic JSON-like traces. */
export function diffOutputs(
  legacyOutput: unknown,
  targetOutput: unknown,
  traceId = "trace",
) {
  let equal = false;
  let comparisonError: string | undefined;
  try {
    equal = canonicalValue(legacyOutput) === canonicalValue(targetOutput);
  } catch (error) {
    comparisonError = error instanceof Error ? error.message : String(error);
  }
  return {
    traceId,
    legacyOutput,
    targetOutput,
    equal,
    diffSummary: comparisonError
      ? `outputs could not be compared: ${comparisonError}`
      : equal
        ? "outputs match"
        : "outputs differ",
    ...(comparisonError ? { comparisonError } : {}),
  };
}
