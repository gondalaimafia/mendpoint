import { createHash } from "node:crypto";
import type { BsgEdge, BsgNode, BsgNodeKind } from "./types.js";

const REVISION = /^[a-f0-9]{40}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/i;
const MAX_SOURCES = 500;
const MAX_NODES = 2_000;
const MAX_EDGES = 4_000;
const MAX_EVIDENCE_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

export type BsgEvidenceKind = "code" | "test" | "schema" | "trace" | "human";
export type BsgEvidenceState = "active" | "stale" | "deleted";

export type BsgEvidenceAssertion = {
  key: string;
  kind: BsgNodeKind;
  label: string;
  /** Predicate copied from a deterministic collector, never generated prose. */
  spec: string;
  locator: string;
};

export type BsgEvidenceRelation = {
  fromKey: string;
  toKey: string;
  kind: BsgEdge["kind"];
  locator: string;
  /** Optional explicit fence for collectors that carry qualified references. */
  targetTenantId?: string;
};

export type BsgHumanApproval = {
  state: "approved";
  authorId: string;
  approverId: string;
  approvalId: string;
  approvedAt: string;
};

export type BsgEvidenceSource = {
  id: string;
  kind: BsgEvidenceKind;
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  /** Exact immutable source control revision. */
  revision: string;
  snapshotDigest: string;
  contentDigest: string;
  observedAt: string;
  deletedAt?: string;
  approval?: BsgHumanApproval;
  assertions: BsgEvidenceAssertion[];
  relations: BsgEvidenceRelation[];
};

export type BsgProvenance = {
  sourceId: string;
  kind: BsgEvidenceKind;
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
  contentDigest: string;
  observedAt: string;
  locator: string;
  state: BsgEvidenceState;
  staleAt: string;
  deletedAt?: string;
  approvalId?: string;
};

export type ExtractedBsgNode = BsgNode & {
  key: string;
  sourceRefs: string[];
  provenance: BsgProvenance[];
  state: BsgEvidenceState;
};

export type ExtractedBsgEdge = BsgEdge & {
  provenance: BsgProvenance[];
  state: BsgEvidenceState;
};

export type ExtractedBehavioralSpecGraph = {
  id: string;
  schemaVersion: "2026-08-02.v1";
  tenantId: string;
  title: string;
  sourceSystem: string;
  targetSystem: string;
  evaluatedAt: string;
  snapshots: Array<{
    repositoryId: string;
    snapshotId: string;
    revision: string;
    snapshotDigest: string;
  }>;
  nodes: ExtractedBsgNode[];
  edges: ExtractedBsgEdge[];
  execution: {
    allowed: true;
    activeNodeCount: number;
    executableNodeIds: string[];
    excludedNodeIds: string[];
    executableEdgeIds: string[];
    excludedEdgeIds: string[];
  };
  automation: { mayReadRepository: false; mayMutateRepository: false };
  digest: string;
};

export type BsgExtractionInput = {
  tenantId: string;
  title: string;
  sourceSystem: string;
  targetSystem: string;
  evaluatedAt: string;
  maxEvidenceAgeMs: number;
  sources: BsgEvidenceSource[];
};

export class BsgExtractionError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "BsgExtractionError";
  }
}

/**
 * Collect explicit behavior annotations from code, test, schema, or trace
 * fixtures. The strict line format keeps extraction reproducible and makes the
 * exact artifact line the evidence locator.
 */
export function collectBsgAnnotations(
  content: string,
  artifactLocator: string,
): { assertions: BsgEvidenceAssertion[]; relations: BsgEvidenceRelation[] } {
  const locator = text(artifactLocator, "bsg_artifact_locator_required", 2_000);
  if (typeof content !== "string" || content.length > 2_000_000) {
    fail("bsg_artifact_content_invalid");
  }
  const assertions: BsgEvidenceAssertion[] = [];
  const relations: BsgEvidenceRelation[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const marker = line.match(/@mendpoint-bsg-(node|edge)\s+(.+)\s*$/);
    if (!marker) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(marker[2]!);
    } catch {
      fail("bsg_annotation_json_invalid", `${locator}:${index + 1}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("bsg_annotation_record_invalid", `${locator}:${index + 1}`);
    }
    const record = parsed as Record<string, unknown>;
    const recordLocator = `${locator}:${index + 1}`;
    if (marker[1] === "node") {
      const allowed = new Set(["key", "kind", "label", "spec"]);
      if (Object.keys(record).some((key) => !allowed.has(key))) {
        fail("bsg_annotation_field_invalid", recordLocator);
      }
      assertions.push({
        key: record.key as string,
        kind: record.kind as BsgNodeKind,
        label: record.label as string,
        spec: record.spec as string,
        locator: recordLocator,
      });
    } else {
      const allowed = new Set(["fromKey", "toKey", "kind", "targetTenantId"]);
      if (Object.keys(record).some((key) => !allowed.has(key))) {
        fail("bsg_annotation_field_invalid", recordLocator);
      }
      relations.push({
        fromKey: record.fromKey as string,
        toKey: record.toKey as string,
        kind: record.kind as BsgEdge["kind"],
        locator: recordLocator,
        ...(record.targetTenantId === undefined
          ? {}
          : { targetTenantId: record.targetTenantId as string }),
      });
    }
  }
  return deepFreeze({ assertions, relations });
}

function fail(code: string, detail?: string): never {
  throw new BsgExtractionError(code, detail);
}

function text(value: unknown, code: string, maxLength = 10_000): string {
  if (typeof value !== "string" || !value.trim()) fail(code);
  const normalized = value.trim();
  if (normalized.length > maxLength) fail(code);
  return normalized;
}

function instant(value: unknown, code: string): { iso: string; epoch: number } {
  if (typeof value !== "string") fail(code);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) fail(code);
  return { iso: new Date(epoch).toISOString(), epoch };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function aggregateState(states: BsgEvidenceState[]): BsgEvidenceState {
  if (states.includes("active")) return "active";
  if (states.includes("stale")) return "stale";
  return "deleted";
}

function relationState(
  evidence: BsgEvidenceState[],
  from: BsgEvidenceState,
  to: BsgEvidenceState,
): BsgEvidenceState {
  if (from === "deleted" || to === "deleted" || evidence.every((state) => state === "deleted")) {
    return "deleted";
  }
  if (from === "stale" || to === "stale" || !evidence.includes("active")) return "stale";
  return "active";
}

type PreparedSource = {
  source: BsgEvidenceSource;
  provenance(locator: string, locatorError: string): BsgProvenance;
};

/**
 * Build a reviewable BSG from structured deterministic collector output. The
 * extractor is pure: it does not inspect or change a repository and it never
 * fills missing behavior with a model guess.
 */
export function extractBehavioralSpecGraph(
  input: BsgExtractionInput,
): ExtractedBehavioralSpecGraph {
  if (!input || typeof input !== "object") fail("bsg_input_required");
  const tenantId = text(input.tenantId, "bsg_tenant_required", 200);
  const title = text(input.title, "bsg_title_required", 500);
  const sourceSystem = text(input.sourceSystem, "bsg_source_system_required", 500);
  const targetSystem = text(input.targetSystem, "bsg_target_system_required", 500);
  const evaluated = instant(input.evaluatedAt, "bsg_evaluated_at_invalid");
  if (!Number.isSafeInteger(input.maxEvidenceAgeMs) || input.maxEvidenceAgeMs <= 0 ||
    input.maxEvidenceAgeMs > MAX_EVIDENCE_AGE_MS) {
    fail("bsg_evidence_age_limit_invalid");
  }
  if (!Array.isArray(input.sources) || !input.sources.length) fail("bsg_sources_required");
  if (input.sources.length > MAX_SOURCES) fail("bsg_source_limit_exceeded");

  const sourceIds = new Set<string>();
  const snapshots = new Map<string, ExtractedBehavioralSpecGraph["snapshots"][number]>();
  const prepared: PreparedSource[] = [];
  for (const source of input.sources) {
    if (!source || typeof source !== "object") fail("bsg_source_invalid");
    const id = text(source.id, "bsg_source_id_required", 500);
    if (sourceIds.has(id)) fail("bsg_source_id_conflict", id);
    sourceIds.add(id);
    if (!["code", "test", "schema", "trace", "human"].includes(source.kind)) {
      fail("bsg_source_kind_invalid", id);
    }
    if (source.tenantId !== tenantId) fail("bsg_cross_tenant_source", id);
    const repositoryId = text(source.repositoryId, "bsg_repository_required", 500);
    const snapshotId = text(source.snapshotId, "bsg_snapshot_required", 500);
    if (!REVISION.test(source.revision)) fail("bsg_revision_invalid", id);
    if (!DIGEST.test(source.snapshotDigest)) fail("bsg_snapshot_digest_invalid", id);
    if (!DIGEST.test(source.contentDigest)) fail("bsg_content_digest_invalid", id);
    const observed = instant(source.observedAt, "bsg_observed_at_invalid");
    if (observed.epoch > evaluated.epoch) fail("bsg_observed_at_future", id);
    const staleEpoch = observed.epoch + input.maxEvidenceAgeMs;
    let state: BsgEvidenceState = staleEpoch < evaluated.epoch ? "stale" : "active";
    let deletedAt: string | undefined;
    if (source.deletedAt !== undefined) {
      const deleted = instant(source.deletedAt, "bsg_deleted_at_invalid");
      if (deleted.epoch < observed.epoch || deleted.epoch > evaluated.epoch) {
        fail("bsg_deleted_at_out_of_range", id);
      }
      deletedAt = deleted.iso;
      state = "deleted";
    }
    let approvalId: string | undefined;
    if (source.kind === "human") {
      const approval = source.approval;
      if (!approval || approval.state !== "approved") fail("bsg_human_approval_required", id);
      const authorId = text(approval.authorId, "bsg_human_author_required", 500);
      const approverId = text(approval.approverId, "bsg_human_approver_required", 500);
      if (authorId === approverId) fail("bsg_human_independent_approval_required", id);
      approvalId = text(approval.approvalId, "bsg_human_approval_id_required", 500);
      const approved = instant(approval.approvedAt, "bsg_human_approved_at_invalid");
      if (approved.epoch < observed.epoch || approved.epoch > evaluated.epoch) {
        fail("bsg_human_approval_time_invalid", id);
      }
    } else if (source.approval !== undefined) {
      fail("bsg_non_human_approval_forbidden", id);
    }
    if (!Array.isArray(source.assertions) || !Array.isArray(source.relations)) {
      fail("bsg_source_records_invalid", id);
    }

    const snapshot = {
      repositoryId,
      snapshotId,
      revision: source.revision.toLowerCase(),
      snapshotDigest: source.snapshotDigest.toLowerCase(),
    };
    const existing = snapshots.get(repositoryId);
    if (existing && canonical(existing) !== canonical(snapshot)) fail("bsg_snapshot_contradiction", repositoryId);
    snapshots.set(repositoryId, snapshot);
    prepared.push({
      source,
      provenance(locatorValue, locatorError) {
        const locator = text(locatorValue, locatorError, 2_000);
        return {
          sourceId: id,
          kind: source.kind,
          tenantId,
          repositoryId,
          snapshotId,
          revision: source.revision.toLowerCase(),
          snapshotDigest: source.snapshotDigest.toLowerCase(),
          contentDigest: source.contentDigest.toLowerCase(),
          observedAt: observed.iso,
          locator,
          state,
          staleAt: new Date(staleEpoch).toISOString(),
          ...(deletedAt ? { deletedAt } : {}),
          ...(approvalId ? { approvalId } : {}),
        };
      },
    });
  }

  type NodeAccumulator = Omit<ExtractedBsgNode, "id" | "sourceRefs" | "state"> & {
    provenance: BsgProvenance[];
  };
  const nodesByKey = new Map<string, NodeAccumulator>();
  for (const item of prepared) {
    for (const assertion of item.source.assertions) {
      if (!assertion || typeof assertion !== "object") fail("bsg_assertion_invalid", item.source.id);
      const key = text(assertion.key, "bsg_assertion_key_required", 500);
      if (!["precondition", "postcondition", "invariant", "behavior"].includes(assertion.kind)) {
        fail("bsg_assertion_kind_invalid", key);
      }
      const label = text(assertion.label, "bsg_assertion_label_required", 1_000);
      const spec = text(assertion.spec, "bsg_assertion_spec_required");
      const provenance = item.provenance(assertion.locator, "bsg_assertion_locator_required");
      const existing = nodesByKey.get(key);
      if (existing && (existing.kind !== assertion.kind || existing.label !== label || existing.spec !== spec)) {
        fail("bsg_assertion_contradiction", key);
      }
      if (existing) existing.provenance.push(provenance);
      else nodesByKey.set(key, { key, kind: assertion.kind, label, spec, provenance: [provenance] });
      if (nodesByKey.size > MAX_NODES) fail("bsg_node_limit_exceeded");
    }
  }

  const nodes = [...nodesByKey.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((node): ExtractedBsgNode => {
      const provenance = node.provenance.sort((left, right) =>
        `${left.sourceId}:${left.locator}`.localeCompare(`${right.sourceId}:${right.locator}`),
      );
      return {
        id: `bsgn_${sha256({ tenantId, key: node.key }).slice(7, 31)}`,
        key: node.key,
        kind: node.kind,
        label: node.label,
        spec: node.spec,
        sourceRefs: [...new Set(provenance.map((ref) => ref.locator))].sort(),
        provenance,
        state: aggregateState(provenance.map((ref) => ref.state)),
      };
    });
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));

  type RelationAccumulator = {
    fromKey: string;
    toKey: string;
    kind: BsgEdge["kind"];
    provenance: BsgProvenance[];
  };
  const relations = new Map<string, RelationAccumulator>();
  for (const item of prepared) {
    for (const relation of item.source.relations) {
      if (!relation || typeof relation !== "object") fail("bsg_relation_invalid", item.source.id);
      const fromKey = text(relation.fromKey, "bsg_relation_source_required", 500);
      const toKey = text(relation.toKey, "bsg_relation_target_required", 500);
      if (relation.targetTenantId !== undefined && relation.targetTenantId !== tenantId) {
        fail("bsg_cross_tenant_relation", `${fromKey}:${toKey}`);
      }
      if (!nodeByKey.has(fromKey)) fail("bsg_relation_source_unknown", fromKey);
      if (!nodeByKey.has(toKey)) fail("bsg_relation_target_unknown", toKey);
      if (fromKey === toKey) fail("bsg_relation_self_reference", fromKey);
      if (!["implies", "orders", "refines"].includes(relation.kind)) fail("bsg_relation_kind_invalid");
      const identity = `${fromKey}\u0000${toKey}`;
      const provenance = item.provenance(relation.locator, "bsg_relation_locator_required");
      const existing = relations.get(identity);
      if (existing && existing.kind !== relation.kind) fail("bsg_relation_contradiction", `${fromKey}:${toKey}`);
      if (existing) existing.provenance.push(provenance);
      else relations.set(identity, { fromKey, toKey, kind: relation.kind, provenance: [provenance] });
      if (relations.size > MAX_EDGES) fail("bsg_edge_limit_exceeded");
    }
  }

  const edges = [...relations.values()]
    .sort((left, right) => `${left.fromKey}:${left.toKey}`.localeCompare(`${right.fromKey}:${right.toKey}`))
    .map((relation): ExtractedBsgEdge => {
      const from = nodeByKey.get(relation.fromKey)!;
      const to = nodeByKey.get(relation.toKey)!;
      const provenance = relation.provenance.sort((left, right) =>
        `${left.sourceId}:${left.locator}`.localeCompare(`${right.sourceId}:${right.locator}`),
      );
      return {
        id: `bsge_${sha256({ tenantId, from: relation.fromKey, to: relation.toKey, kind: relation.kind }).slice(7, 31)}`,
        from: from.id,
        to: to.id,
        kind: relation.kind,
        provenance,
        state: relationState(provenance.map((ref) => ref.state), from.state, to.state),
      };
    });

  const activeNodeCount = nodes.filter((node) => node.state === "active").length;
  if (!nodes.length || activeNodeCount === 0) fail("bsg_active_node_required");
  const executableNodeIds = nodes.filter((node) => node.state === "active").map((node) => node.id);
  const excludedNodeIds = nodes.filter((node) => node.state !== "active").map((node) => node.id);
  const executableEdgeIds = edges.filter((edge) => edge.state === "active").map((edge) => edge.id);
  const excludedEdgeIds = edges.filter((edge) => edge.state !== "active").map((edge) => edge.id);
  const body = {
    schemaVersion: "2026-08-02.v1" as const,
    tenantId,
    title,
    sourceSystem,
    targetSystem,
    evaluatedAt: evaluated.iso,
    snapshots: [...snapshots.values()].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
    nodes,
    edges,
    execution: {
      allowed: true as const,
      activeNodeCount,
      executableNodeIds,
      excludedNodeIds,
      executableEdgeIds,
      excludedEdgeIds,
    },
    automation: { mayReadRepository: false as const, mayMutateRepository: false as const },
  };
  const digest = sha256(body);
  return deepFreeze({
    id: `bsg_${digest.slice(7, 31)}`,
    ...body,
    digest,
  });
}
