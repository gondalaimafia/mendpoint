import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BsgExtractionError,
  collectBsgAnnotations,
  extractBehavioralSpecGraph,
  verifyExtractedBehavioralSpecGraph,
  type BsgExtractionInput,
  type ExtractedBehavioralSpecGraph,
} from "./bsg-extractor.js";

const REVISION = "a".repeat(40);
const SNAPSHOT_DIGEST = `sha256:${"b".repeat(64)}`;
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function reseal(value: ExtractedBehavioralSpecGraph): ExtractedBehavioralSpecGraph {
  const { id: _id, digest: _digest, ...body } = value;
  const digest = `sha256:${createHash("sha256").update(canonical(body)).digest("hex")}`;
  value.digest = digest;
  value.id = `bsg_${digest.slice(7, 31)}`;
  return value;
}

function fixture(): BsgExtractionInput {
  const shared = {
    tenantId: "tenant-a",
    repositoryId: "payments-api",
    snapshotId: "snapshot-001",
    revision: REVISION,
    snapshotDigest: SNAPSHOT_DIGEST,
    observedAt: "2026-08-02T11:55:00.000Z",
  };
  return {
    tenantId: "tenant-a",
    title: "Payments behavior",
    sourceSystem: "node@18",
    targetSystem: "node@20",
    evaluatedAt: "2026-08-02T12:00:00.000Z",
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    sources: [
      {
        ...shared,
        id: "code-payment",
        kind: "code",
        contentDigest: DIGEST("1"),
        assertions: [{
          key: "payment-calculation",
          kind: "behavior",
          label: "Calculate payment",
          spec: "calculatePayment returns the sum of authorized line items",
          locator: "src/payments.ts:18-31",
        }],
        relations: [],
      },
      {
        ...shared,
        id: "test-payment",
        kind: "test",
        contentDigest: DIGEST("2"),
        assertions: [{
          key: "payment-total-preserved",
          kind: "postcondition",
          label: "Payment total is preserved",
          spec: "the persisted total equals the calculated payment total",
          locator: "test/payments.test.ts:42-55",
        }],
        relations: [{
          fromKey: "payment-calculation",
          toKey: "payment-total-preserved",
          kind: "implies",
          locator: "test/payments.test.ts:42-55",
        }],
      },
      {
        ...shared,
        id: "schema-payment",
        kind: "schema",
        contentDigest: DIGEST("3"),
        assertions: [{
          key: "currency-required",
          kind: "invariant",
          label: "Currency is required",
          spec: "payments.currency is non-null",
          locator: "schema/payments.sql:7",
        }],
        relations: [{
          fromKey: "currency-required",
          toKey: "payment-calculation",
          kind: "orders",
          locator: "schema/payments.sql:7",
        }],
      },
      {
        ...shared,
        id: "trace-payment",
        kind: "trace",
        contentDigest: DIGEST("4"),
        assertions: [{
          key: "authorized-payment-trace",
          kind: "behavior",
          label: "Authorized payment succeeds",
          spec: "an authorized payment returns status 201",
          locator: "trace://payments/run-77/span-3",
        }],
        relations: [{
          fromKey: "authorized-payment-trace",
          toKey: "payment-calculation",
          kind: "refines",
          locator: "trace://payments/run-77/span-3",
        }],
      },
      {
        ...shared,
        id: "human-payment",
        kind: "human",
        contentDigest: DIGEST("5"),
        observedAt: "2026-08-02T11:57:00.000Z",
        approval: {
          state: "approved",
          authorId: "domain-owner",
          approverId: "reviewer-1",
          approvalId: "approval-77",
          approvedAt: "2026-08-02T11:58:00.000Z",
        },
        assertions: [{
          key: "manual-review-limit",
          kind: "precondition",
          label: "Large payments require review",
          spec: "payments above the approved threshold require manual review",
          locator: "decision://payments/approval-77#threshold",
        }],
        relations: [{
          fromKey: "manual-review-limit",
          toKey: "authorized-payment-trace",
          kind: "orders",
          locator: "decision://payments/approval-77#threshold",
        }],
      },
    ],
  };
}

describe("Behavioral Specification Graph extraction", () => {
  it("verifies valid serialized graphs and rejects resealed edge provenance tampering", () => {
    const extracted = extractBehavioralSpecGraph(fixture());
    const verified = verifyExtractedBehavioralSpecGraph(extracted);
    expect(verified).toEqual(extracted);
    expect(Object.isFrozen(verified.edges[0]!.provenance)).toBe(true);

    const tampered = structuredClone(extracted);
    tampered.edges[0]!.provenance[0]!.snapshotId = "snapshot-forged";
    reseal(tampered);

    expect(() => verifyExtractedBehavioralSpecGraph(tampered)).toThrow(BsgExtractionError);

    const aliased = structuredClone(extracted);
    aliased.edges[0]!.provenance[0]!.contentDigest = DIGEST("f");
    reseal(aliased);

    expect(() => verifyExtractedBehavioralSpecGraph(aliased)).toThrow(BsgExtractionError);
  });

  it("collects strict source annotations with exact line provenance", () => {
    const records = collectBsgAnnotations([
      "export function calculatePayment() {",
      "  // @mendpoint-bsg-node {\"key\":\"payment-calculation\",\"kind\":\"behavior\",\"label\":\"Calculate payment\",\"spec\":\"calculatePayment returns the authorized total\"}",
      "}",
      "// @mendpoint-bsg-edge {\"fromKey\":\"payment-calculation\",\"toKey\":\"payment-total-preserved\",\"kind\":\"implies\"}",
    ].join("\n"), "src/payments.ts");

    expect(records.assertions).toEqual([expect.objectContaining({
      key: "payment-calculation",
      locator: "src/payments.ts:2",
    })]);
    expect(records.relations).toEqual([expect.objectContaining({
      fromKey: "payment-calculation",
      locator: "src/payments.ts:4",
    })]);
    expect(Object.isFrozen(records.assertions)).toBe(true);
  });

  it("deterministically extracts source linked behavior from every supported evidence kind", () => {
    const first = extractBehavioralSpecGraph(fixture());
    const secondInput = fixture();
    for (const source of secondInput.sources) {
      source.revision = source.revision.toUpperCase();
      source.snapshotDigest = source.snapshotDigest.toUpperCase();
    }
    secondInput.sources.reverse();
    const second = extractBehavioralSpecGraph(secondInput);

    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(5);
    expect(first.edges).toHaveLength(4);
    expect(new Set(first.nodes.flatMap((node) => node.provenance.map((ref) => ref.kind)))).toEqual(
      new Set(["code", "test", "schema", "trace", "human"]),
    );
    expect(first.nodes.every((node) => node.provenance.every((ref) =>
      ref.revision === REVISION && ref.snapshotDigest === SNAPSHOT_DIGEST && ref.locator.length > 0,
    ))).toBe(true);
    expect(first.edges.every((edge) => edge.provenance.every((ref) =>
      ref.revision === REVISION && ref.snapshotDigest === SNAPSHOT_DIGEST && ref.locator.length > 0,
    ))).toBe(true);
    expect(first.execution).toEqual({
      allowed: true,
      activeNodeCount: 5,
      executableNodeIds: first.nodes.map((node) => node.id),
      excludedNodeIds: [],
      executableEdgeIds: first.edges.map((edge) => edge.id),
      excludedEdgeIds: [],
    });
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first.nodes[0]?.provenance)).toBe(true);
  });

  it("retains stale and deleted provenance while preventing it from satisfying executable behavior", () => {
    const value = fixture();
    value.sources[0]!.observedAt = "2026-08-02T09:00:00.000Z";
    value.sources[1]!.deletedAt = "2026-08-02T11:59:00.000Z";
    const graph = extractBehavioralSpecGraph(value);

    expect(graph.nodes.find((node) => node.key === "payment-calculation")?.state).toBe("stale");
    expect(graph.nodes.find((node) => node.key === "payment-total-preserved")?.state).toBe("deleted");
    const activeNodes = graph.nodes.filter((node) => node.state === "active");
    const excludedNodes = graph.nodes.filter((node) => node.state !== "active");
    expect(graph.execution).toMatchObject({
      allowed: true,
      activeNodeCount: 3,
      executableNodeIds: activeNodes.map((node) => node.id),
      excludedNodeIds: excludedNodes.map((node) => node.id),
    });
    expect(graph.execution.executableEdgeIds).toEqual(
      graph.edges.filter((edge) => edge.state === "active").map((edge) => edge.id),
    );
    expect(graph.execution.excludedEdgeIds).toEqual(
      graph.edges.filter((edge) => edge.state !== "active").map((edge) => edge.id),
    );

    for (const source of value.sources) source.deletedAt = "2026-08-02T11:59:00.000Z";
    expect(() => extractBehavioralSpecGraph(value)).toThrow("bsg_active_node_required");
  });

  it.each([
    ["missing provenance", (value: BsgExtractionInput) => { value.sources[0]!.assertions[0]!.locator = ""; }, "bsg_assertion_locator_required"],
    ["cross tenant source", (value: BsgExtractionInput) => { value.sources[0]!.tenantId = "tenant-b"; }, "bsg_cross_tenant_source"],
    ["cross tenant relation", (value: BsgExtractionInput) => { value.sources[1]!.relations[0]!.targetTenantId = "tenant-b"; }, "bsg_cross_tenant_relation"],
    ["unapproved human input", (value: BsgExtractionInput) => { value.sources[4]!.approval = undefined; }, "bsg_human_approval_required"],
    ["self approved human input", (value: BsgExtractionInput) => { value.sources[4]!.approval!.approverId = "domain-owner"; }, "bsg_human_independent_approval_required"],
    ["unknown relation target", (value: BsgExtractionInput) => { value.sources[1]!.relations[0]!.toKey = "missing"; }, "bsg_relation_target_unknown"],
    ["revision mismatch", (value: BsgExtractionInput) => { value.sources[1]!.revision = "c".repeat(40); }, "bsg_snapshot_contradiction"],
  ])("fails closed on %s", (_label, mutate, expected) => {
    const value = fixture();
    mutate(value);
    expect(() => extractBehavioralSpecGraph(value)).toThrow(expected);
  });

  it("rejects contradictory predicates and edge meanings", () => {
    const nodeConflict = fixture();
    nodeConflict.sources[1]!.assertions.push({
      ...nodeConflict.sources[0]!.assertions[0]!,
      spec: "calculatePayment returns a fixed amount",
      locator: "test/payments.test.ts:80",
    });
    expect(() => extractBehavioralSpecGraph(nodeConflict)).toThrow("bsg_assertion_contradiction");

    const edgeConflict = fixture();
    edgeConflict.sources[2]!.relations.push({
      fromKey: "payment-calculation",
      toKey: "payment-total-preserved",
      kind: "orders",
      locator: "schema/payments.sql:11",
    });
    expect(() => extractBehavioralSpecGraph(edgeConflict)).toThrow("bsg_relation_contradiction");
  });

  it("rejects empty and stale only graphs", () => {
    const empty = fixture();
    empty.sources = [];
    expect(() => extractBehavioralSpecGraph(empty)).toThrow("bsg_sources_required");

    const stale = fixture();
    for (const source of stale.sources) source.observedAt = "2026-08-01T00:00:00.000Z";
    expect(() => extractBehavioralSpecGraph(stale)).toThrow(BsgExtractionError);
    expect(() => extractBehavioralSpecGraph(stale)).toThrow("bsg_active_node_required");
  });
});
