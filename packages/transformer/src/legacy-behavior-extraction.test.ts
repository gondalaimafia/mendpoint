import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractLegacyBehavior,
  LegacyBehaviorExtractionError,
  type LegacyBehaviorArtifact,
  type LegacyBehaviorCollector,
  type LegacyBehaviorExtractionInput,
  type LegacyBehaviorJsonValue,
} from "./legacy-behavior-extraction.js";

const REVISION = "a".repeat(40);
const SNAPSHOT_DIGEST = `sha256:${"b".repeat(64)}`;
const COLLECTOR_DIGEST = `sha256:${"c".repeat(64)}`;

function canonical(value: LegacyBehaviorJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, LegacyBehaviorJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key]!)}`
  ).join(",")}}`;
}

function digest(value: LegacyBehaviorJsonValue): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function artifact(
  id: string,
  kind: LegacyBehaviorArtifact["kind"],
  payload: LegacyBehaviorJsonValue,
): LegacyBehaviorArtifact {
  return {
    id,
    tenantId: "tenant-a",
    repositoryId: "payments-api",
    snapshotId: "snapshot-001",
    revision: REVISION,
    snapshotDigest: SNAPSHOT_DIGEST,
    kind,
    locator: `${kind}://${id}`,
    contentDigest: digest(payload),
    observedAt: "2026-08-12T11:55:00.000Z",
    payload,
  };
}

function collector(calls?: string[]): LegacyBehaviorCollector {
  return {
    id: "structured-evidence",
    version: "1.0.0",
    digest: COLLECTOR_DIGEST,
    kinds: ["code", "test", "schema", "trace"],
    collect(input) {
      calls?.push(input.id);
      const payload = input.payload as {
        assertions: LegacyBehaviorCollector["collect"] extends (...args: never[]) => infer Result
          ? Result extends { assertions: infer Assertions } ? Assertions : never
          : never;
        relations: LegacyBehaviorCollector["collect"] extends (...args: never[]) => infer Result
          ? Result extends { relations: infer Relations } ? Relations : never
          : never;
      };
      return {
        assertions: [...payload.assertions].reverse(),
        relations: [...payload.relations].reverse(),
      };
    },
  };
}

function enabledInput(calls?: string[]): LegacyBehaviorExtractionInput {
  const code = artifact("payment-code", "code", {
    assertions: [{
      key: "payment-calculation",
      kind: "behavior",
      label: "Calculate payment",
      spec: "calculatePayment returns the authorized total",
      locator: "src/payments.ts:18-31",
    }],
    relations: [],
  });
  const test = artifact("payment-test", "test", {
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
  });
  return {
    policy: {
      enabled: true,
      allowedCollectors: [{
        id: "structured-evidence",
        version: "1.0.0",
        digest: COLLECTOR_DIGEST,
      }],
      maxArtifacts: 10,
      maxAssertions: 20,
      maxRelations: 20,
      maxPayloadBytes: 100_000,
      allowModelInference: false,
    },
    tenantId: "tenant-a",
    title: "Payments behavior",
    sourceSystem: "node@18",
    targetSystem: "node@22",
    evaluatedAt: "2026-08-12T12:00:00.000Z",
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    artifacts: [code, test],
    collectors: [collector(calls)],
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected legacy behavior extraction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyBehaviorExtractionError);
    expect((error as LegacyBehaviorExtractionError).code).toBe(code);
  }
}

describe("automatic legacy behavior extraction", () => {
  it("is disabled by default without inspecting artifacts or calling collectors", () => {
    const calls: string[] = [];
    const input = enabledInput(calls);
    input.policy = undefined;
    input.artifacts[0]!.tenantId = "tenant-b";

    expect(extractLegacyBehavior(input)).toEqual({
      status: "disabled",
      reason: "legacy_behavior_extraction_disabled",
    });
    expect(calls).toEqual([]);
  });

  it("produces the same source-linked BSG regardless of artifact and collector output order", () => {
    const firstInput = enabledInput();
    const first = extractLegacyBehavior(firstInput);
    const secondInput = enabledInput();
    secondInput.artifacts.reverse();
    const second = extractLegacyBehavior(secondInput);

    expect(first).toEqual(second);
    expect(first.status).toBe("extracted");
    if (first.status !== "extracted") throw new Error("expected extracted graph");
    expect(first.graph.nodes.map((node) => node.key)).toEqual([
      "payment-calculation",
      "payment-total-preserved",
    ]);
    expect(first.graph.edges).toHaveLength(1);
    expect(first.graph.automation).toEqual({
      mayReadRepository: false,
      mayMutateRepository: false,
    });
    expect(first.collectorEvidenceRefs).toEqual([
      `collector://structured-evidence/1.0.0/${COLLECTOR_DIGEST}`,
    ]);
  });

  it("rejects collectors whose exact identity is not pinned before invoking them", () => {
    const calls: string[] = [];
    const input = enabledInput(calls);
    input.collectors[0]!.version = "1.0.1";

    expectCode(
      () => extractLegacyBehavior(input),
      "legacy_behavior_collector_not_allowed",
    );
    expect(calls).toEqual([]);
  });

  it("rejects cross-tenant and tampered snapshot artifacts before invoking collectors", () => {
    const calls: string[] = [];
    const crossTenant = enabledInput(calls);
    crossTenant.artifacts[0]!.tenantId = "tenant-b";
    expectCode(
      () => extractLegacyBehavior(crossTenant),
      "legacy_behavior_cross_tenant_artifact",
    );
    expect(calls).toEqual([]);

    const tampered = enabledInput(calls);
    (tampered.artifacts[0]!.payload as Record<string, LegacyBehaviorJsonValue>).extra = true;
    expectCode(
      () => extractLegacyBehavior(tampered),
      "legacy_behavior_artifact_digest_mismatch",
    );
    expect(calls).toEqual([]);
  });

  it("rejects non-JSON payloads and collector output beyond configured bounds", () => {
    const invalid = enabledInput();
    invalid.artifacts[0]!.payload = { callback: (() => undefined) as unknown as LegacyBehaviorJsonValue };
    expectCode(
      () => extractLegacyBehavior(invalid),
      "legacy_behavior_artifact_payload_invalid",
    );

    const bounded = enabledInput();
    if (bounded.policy?.enabled) bounded.policy.maxAssertions = 1;
    expectCode(
      () => extractLegacyBehavior(bounded),
      "legacy_behavior_assertion_limit_exceeded",
    );
  });

  it("applies the payload byte budget across the complete snapshot batch", () => {
    const input = enabledInput();
    const individualSizes = input.artifacts.map((item) =>
      Buffer.byteLength(canonical(item.payload), "utf8")
    );
    if (input.policy?.enabled) {
      input.policy.maxPayloadBytes = Math.max(...individualSizes);
    }

    expectCode(
      () => extractLegacyBehavior(input),
      "legacy_behavior_artifact_payload_limit_exceeded",
    );
  });

  it("snapshots authority and provenance before a collector callback can mutate inputs", () => {
    const input = enabledInput();
    const originalEvaluatedAt = input.evaluatedAt;
    const originalContentDigest = input.artifacts[0]!.contentDigest;
    const activeCollector = input.collectors[0]!;
    const originalCollect = activeCollector.collect;
    activeCollector.collect = (artifactInput) => {
      activeCollector.id = "mutated-collector";
      activeCollector.digest = `sha256:${"d".repeat(64)}`;
      input.artifacts[0]!.contentDigest = `sha256:${"e".repeat(64)}`;
      input.evaluatedAt = "2026-08-12T13:00:00.000Z";
      return originalCollect(artifactInput);
    };

    const result = extractLegacyBehavior(input);

    expect(result.status).toBe("extracted");
    if (result.status !== "extracted") throw new Error("expected extracted graph");
    expect(result.graph.evaluatedAt).toBe(originalEvaluatedAt);
    expect(result.graph.nodes[0]!.provenance[0]!.contentDigest).toBe(originalContentDigest);
    expect(result.collectorEvidenceRefs).toEqual([
      `collector://structured-evidence/1.0.0/${COLLECTOR_DIGEST}`,
    ]);
  });

  it("does not let a collector callback raise the snapshotted output bounds", () => {
    const input = enabledInput();
    if (!input.policy?.enabled) throw new Error("expected enabled policy");
    input.policy.maxAssertions = 1;
    const activeCollector = input.collectors[0]!;
    const originalCollect = activeCollector.collect;
    activeCollector.collect = (artifactInput) => {
      if (input.policy?.enabled) input.policy.maxAssertions = 20;
      return originalCollect(artifactInput);
    };

    expectCode(
      () => extractLegacyBehavior(input),
      "legacy_behavior_assertion_limit_exceeded",
    );
  });

  it("rejects contradictory repository snapshots before invoking collectors", () => {
    const calls: string[] = [];
    const input = enabledInput(calls);
    input.artifacts[1]!.snapshotId = "snapshot-002";

    expectCode(
      () => extractLegacyBehavior(input),
      "legacy_behavior_snapshot_binding_conflict",
    );
    expect(calls).toEqual([]);
  });

  it("rejects an applicable collector call plan above the BSG source cap before invocation", () => {
    const calls: string[] = [];
    const input = enabledInput();
    const secondDigest = `sha256:${"d".repeat(64)}`;
    input.artifacts = Array.from({ length: 251 }, (_, index) =>
      artifact(`artifact-${index}`, "code", { assertions: [], relations: [] })
    );
    input.collectors = [
      { ...collector(calls), id: "collector-a" },
      { ...collector(calls), id: "collector-b", digest: secondDigest },
    ];
    if (!input.policy?.enabled) throw new Error("expected enabled policy");
    input.policy.maxArtifacts = 500;
    input.policy.allowedCollectors = [
      { id: "collector-a", version: "1.0.0", digest: COLLECTOR_DIGEST },
      { id: "collector-b", version: "1.0.0", digest: secondDigest },
    ];

    expectCode(
      () => extractLegacyBehavior(input),
      "legacy_behavior_source_limit_exceeded",
    );
    expect(calls).toEqual([]);
  });

  it("encodes collector reference segments without collapsing distinct pinned identities", () => {
    const input = enabledInput();
    input.artifacts = [input.artifacts[0]!];
    input.collectors = [
      { ...collector(), id: "a/b", version: "c" },
      { ...collector(), id: "a", version: "b/c" },
    ];
    if (!input.policy?.enabled) throw new Error("expected enabled policy");
    input.policy.allowedCollectors = [
      { id: "a/b", version: "c", digest: COLLECTOR_DIGEST },
      { id: "a", version: "b/c", digest: COLLECTOR_DIGEST },
    ];

    const result = extractLegacyBehavior(input);

    expect(result.status).toBe("extracted");
    if (result.status !== "extracted") throw new Error("expected extracted graph");
    expect(result.collectorEvidenceRefs).toEqual([
      `collector://a%2Fb/c/${COLLECTOR_DIGEST}`,
      `collector://a/b%2Fc/${COLLECTOR_DIGEST}`,
    ]);
  });

  it("uses locale-independent code-unit order for collector invocation", () => {
    const calls: string[] = [];
    const input = enabledInput();
    input.artifacts = [input.artifacts[0]!];
    const unicodeCollector = (id: string): LegacyBehaviorCollector => ({
      ...collector(),
      id,
      collect(artifactInput) {
        calls.push(id);
        return collector().collect(artifactInput);
      },
    });
    input.collectors = [unicodeCollector("ä"), unicodeCollector("z")];
    if (!input.policy?.enabled) throw new Error("expected enabled policy");
    input.policy.allowedCollectors = input.collectors.map(({ id, version, digest }) => ({
      id,
      version,
      digest,
    }));

    extractLegacyBehavior(input);

    expect(calls).toEqual(["z", "ä"]);
  });
});
