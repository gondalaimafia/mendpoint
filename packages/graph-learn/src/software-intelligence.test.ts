import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openGraphLearnMemory } from "./store.js";
import {
  assertRawRetrievalRelationshipCandidateAuthority,
  compileFettlerImpactContext,
  compileMissionGraphProjection,
  createRawRetrievalRelationshipCandidate,
  classifyChangeGraphFailure,
  diffSoftwareGraphVersions,
  getSoftwareGraphHead,
  listSoftwareGraphHeads,
  publishSoftwareGraphVersion,
  queryFettlerEndpointImpact,
  readSoftwareGraphVersion,
  resolveSoftwareEntity,
  type SoftwareGraphPublicationV1,
} from "./software-intelligence.js";

const extractor = Object.freeze({
  id: "mendpoint.code-index",
  version: "1.0.0",
  digest: `sha256:${"1".repeat(64)}`,
});
const entityProvenance = Object.freeze({
  extractor,
  derivation: "repository_usage" as const,
  confidenceBasis: "deterministic_exact" as const,
  validFrom: "2026-08-17T12:00:00.000Z",
});
const relationshipValidity = Object.freeze({
  derivation: "call_graph" as const,
  confidenceBasis: "static_analysis_high" as const,
  validFrom: "2026-08-17T12:00:00.000Z",
});

function canonicalTestJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item)
    ? item.map(normalize)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, normalize(child)]))
      : item;
  return JSON.stringify(normalize(value));
}

function publication(snapshotId = "snapshot-1"): SoftwareGraphPublicationV1 {
  return {
    schemaVersion: "mendpoint.software-graph.v1",
    tenantId: "tenant-a",
    repositoryId: "repo-a",
    repositorySnapshotId: snapshotId,
    repositoryRevision: "a".repeat(40),
    providerId: "provider-a",
    providerSnapshotId: "provider-snapshot-1",
    providerRevision: "2026-08-17",
    observedAt: "2026-08-17T12:00:00.000Z",
    entities: [
      {
        ...entityProvenance,
        id: "endpoint:charges-create",
        kind: "endpoint",
        canonicalKey: "POST /v1/charges",
        aliases: ["charges.create"],
        label: "POST /v1/charges",
        scope: "provider",
        evidenceRefs: ["artifact:openapi:v1"],
        status: "active",
      },
      {
        ...entityProvenance,
        id: "provider-sdk:charges-create",
        kind: "provider_sdk_method",
        canonicalKey: "stripe@14:charges.create",
        aliases: ["charges.create"],
        label: "charges.create",
        scope: "provider",
        evidenceRefs: ["artifact:sdk:stripe-14"],
        status: "active",
      },
      {
        ...entityProvenance,
        id: "internal-sdk:create-charge",
        kind: "internal_sdk_method",
        canonicalKey: "src/payments/client.ts::createCharge",
        aliases: ["createCharge"],
        label: "createCharge",
        scope: "repository",
        evidenceRefs: ["source:src/payments/client.ts:10"],
        status: "active",
      },
      {
        ...entityProvenance,
        id: "function:bill-customer",
        kind: "function",
        canonicalKey: "src/billing.ts::billCustomer",
        aliases: ["billCustomer"],
        label: "billCustomer",
        scope: "repository",
        evidenceRefs: ["source:src/billing.ts:20"],
        status: "active",
      },
      {
        ...entityProvenance,
        id: "test:bill-customer",
        kind: "test",
        canonicalKey: "test/billing.test.ts::bills a customer",
        aliases: [],
        label: "bills a customer",
        scope: "repository",
        evidenceRefs: ["source:test/billing.test.ts:8"],
        status: "active",
      },
    ],
    relationships: [
      {
        ...relationshipValidity,
        id: "edge:provider-sdk:endpoint",
        kind: "uses_endpoint",
        sourceId: "provider-sdk:charges-create",
        targetId: "endpoint:charges-create",
        evidenceRefs: ["artifact:sdk-map:1"],
        extractor,
        status: "active",
      },
      {
        ...relationshipValidity,
        id: "edge:internal:provider-sdk",
        kind: "uses_sdk_method",
        sourceId: "internal-sdk:create-charge",
        targetId: "provider-sdk:charges-create",
        evidenceRefs: ["source:src/payments/client.ts:12"],
        extractor,
        status: "active",
      },
      {
        ...relationshipValidity,
        id: "edge:function:internal",
        kind: "wraps",
        sourceId: "function:bill-customer",
        targetId: "internal-sdk:create-charge",
        evidenceRefs: ["call:src/billing.ts:22"],
        extractor,
        status: "active",
      },
      {
        ...relationshipValidity,
        id: "edge:test:function",
        kind: "tests",
        sourceId: "test:bill-customer",
        targetId: "function:bill-customer",
        evidenceRefs: ["call:test/billing.test.ts:10"],
        extractor,
        status: "active",
      },
    ],
    coverage: [
      {
        extractor,
        stage: "repository_discovery",
        basis: "complete",
        analyzed: 3,
        omitted: 0,
        evidenceRefs: ["manifest:repo-a:snapshot-1"],
      },
      {
        extractor,
        stage: "language_parsing",
        basis: "complete",
        analyzed: 3,
        omitted: 0,
        evidenceRefs: ["parser:typescript:v1"],
      },
      {
        extractor,
        stage: "provider_specification",
        basis: "complete",
        analyzed: 1,
        omitted: 0,
        evidenceRefs: ["artifact:openapi:v1"],
      },
      {
        extractor,
        stage: "sdk_resolution",
        basis: "complete",
        analyzed: 1,
        omitted: 0,
        evidenceRefs: ["artifact:sdk-map:1"],
      },
      {
        extractor,
        stage: "call_resolution",
        basis: "complete",
        analyzed: 2,
        omitted: 0,
        evidenceRefs: ["call-graph:repo-a:snapshot-1"],
      },
      {
        extractor,
        stage: "test_resolution",
        basis: "complete",
        analyzed: 1,
        omitted: 0,
        evidenceRefs: ["source:test/billing.test.ts:8"],
      },
    ],
  };
}

describe("foundational software intelligence graph", () => {
  it("creates software graph storage during the central graph migration", () => {
    const db = openGraphLearnMemory();
    const tables = (db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      "gl_nodes", "gl_edges", "gl_software_versions_v1", "gl_software_heads_v1",
    ]));
    db.raw.close();
  });

  it("distinguishes exact, alias, ambiguous, unresolved, and collision resolution", () => {
    const entities = publication().entities;
    expect(resolveSoftwareEntity(entities, "POST /v1/charges").status).toBe("exact");
    expect(resolveSoftwareEntity(entities, "createCharge").status).toBe("alias");
    expect(resolveSoftwareEntity(entities, "charges.create").status).toBe("ambiguous");
    expect(resolveSoftwareEntity(entities, "missing").status).toBe("unresolved");
    expect(
      resolveSoftwareEntity(
        [entities[0]!, { ...entities[0]!, id: "endpoint:collision", label: "collision" }],
        "POST /v1/charges",
      ).status,
    ).toBe("collision");
  });

  it("publishes immutable exact versions and retains historical mission reads", () => {
    const db = openGraphLearnMemory();
    const first = publishSoftwareGraphVersion(db, publication());
    const secondInput = publication("snapshot-2");
    secondInput.repositoryRevision = "b".repeat(40);
    secondInput.observedAt = "2026-08-17T12:01:00.000Z";
    secondInput.parentVersionId = first.versionId;
    const changedIndex = secondInput.entities.findIndex((entity) => entity.id === "function:bill-customer");
    secondInput.entities[changedIndex] = {
      ...secondInput.entities[changedIndex]!,
      label: "billCustomerV2",
    };
    const second = publishSoftwareGraphVersion(db, secondInput);

    expect(first.versionId).not.toBe(second.versionId);
    expect(getSoftwareGraphHead(db, "tenant-a", "repo-a", "provider-a")?.versionId).toBe(second.versionId);
    expect(
      readSoftwareGraphVersion(db, "tenant-a", "repo-a", first.versionId).entities.find(
        (entity) => entity.id === "function:bill-customer",
      )?.label,
    ).toBe("billCustomer");
    expect(
      readSoftwareGraphVersion(db, "tenant-a", "repo-a", second.versionId).entities.find(
        (entity) => entity.id === "function:bill-customer",
      )?.label,
    ).toBe("billCustomerV2");
  });

  it("replays an identical publication after response loss without a new version", () => {
    const db = openGraphLearnMemory();
    const input = publication();
    const first = publishSoftwareGraphVersion(db, input);
    const replay = publishSoftwareGraphVersion(db, input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(getSoftwareGraphHead(db, "tenant-a", "repo-a", "provider-a")?.versionId).toBe(first.versionId);
  });

  it("keeps independent provider heads for one tenant repository", () => {
    const db = openGraphLearnMemory();
    const providerA = publication();
    const first = publishSoftwareGraphVersion(db, providerA);
    const providerB = publication("snapshot-provider-b");
    providerB.providerId = "provider-b";
    providerB.providerSnapshotId = "provider-b-snapshot-1";
    providerB.providerRevision = "v1";
    providerB.repositoryRevision = "b".repeat(40);
    providerB.observedAt = "2026-08-17T12:01:00.000Z";
    providerB.entities[0] = {
      ...providerB.entities[0]!,
      id: "endpoint:messages-create",
      canonicalKey: "POST /v1/messages",
      aliases: ["messages.create"],
      label: "POST /v1/messages",
    };
    providerB.relationships[0] = {
      ...providerB.relationships[0]!,
      targetId: "endpoint:messages-create",
    };
    const second = publishSoftwareGraphVersion(db, providerB);
    expect(getSoftwareGraphHead(db, "tenant-a", "repo-a", "provider-a")?.versionId).toBe(first.versionId);
    expect(getSoftwareGraphHead(db, "tenant-a", "repo-a", "provider-b")?.versionId).toBe(second.versionId);
    expect(listSoftwareGraphHeads(db, "tenant-a", "repo-a")).toEqual([
      expect.objectContaining({ providerId: "provider-a", versionId: first.versionId }),
      expect.objectContaining({ providerId: "provider-b", versionId: second.versionId }),
    ]);
    expect(listSoftwareGraphHeads(db, "tenant-b", "repo-a")).toEqual([]);
  });

  it("reports incremental reuse and changed identities without mutating either version", () => {
    const db = openGraphLearnMemory();
    const first = publishSoftwareGraphVersion(db, publication());
    const next = publication("snapshot-2");
    next.parentVersionId = first.versionId;
    next.repositoryRevision = "b".repeat(40);
    next.observedAt = "2026-08-17T12:01:00.000Z";
    const functionIndex = next.entities.findIndex((entity) => entity.id === "function:bill-customer");
    next.entities[functionIndex] = { ...next.entities[functionIndex]!, label: "billCustomerV2" };
    const second = publishSoftwareGraphVersion(db, next);
    expect(diffSoftwareGraphVersions(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      fromVersionId: first.versionId,
      toVersionId: second.versionId,
    })).toEqual({
      addedEntityIds: [],
      removedEntityIds: [],
      changedEntityIds: ["function:bill-customer"],
      addedRelationshipIds: [],
      removedRelationshipIds: [],
      changedRelationshipIds: [],
      reusedEntities: 4,
      reusedRelationships: 4,
    });
  });

  it("does not advance the head when successor publication is invalid", () => {
    const db = openGraphLearnMemory();
    const first = publishSoftwareGraphVersion(db, publication());
    const invalid = publication("snapshot-invalid");
    invalid.parentVersionId = first.versionId;
    invalid.relationships[0] = { ...invalid.relationships[0]!, targetId: "missing" };

    expect(() => publishSoftwareGraphVersion(db, invalid)).toThrow(
      "software_graph_relationship_target_missing",
    );
    expect(getSoftwareGraphHead(db, "tenant-a", "repo-a", "provider-a")?.versionId).toBe(first.versionId);
  });

  it("traverses one evidence backed indirect endpoint to test chain", () => {
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication());
    const result = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/charges",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });

    expect(result.impact).toBe("impact");
    expect(result.paths).toContainEqual([
      "endpoint:charges-create",
      "provider-sdk:charges-create",
      "internal-sdk:create-charge",
      "function:bill-customer",
      "test:bill-customer",
    ]);
    expect(result.relationships).toHaveLength(4);
    expect(result.coverage.basis).toBe("complete");
    expect(result).toMatchObject({
      repositorySnapshotId: "snapshot-1",
      repositoryRevision: "a".repeat(40),
      providerId: "provider-a",
      providerSnapshotId: "provider-snapshot-1",
      providerRevision: "2026-08-17",
    });
    const { resultDigest, ...unsigned } = result;
    expect(resultDigest).toBe(`sha256:${createHash("sha256").update(canonicalTestJson(unsigned)).digest("hex")}`);
  });

  it("does not treat a provider-only endpoint mapping as repository impact", () => {
    const db = openGraphLearnMemory();
    const input = publication();
    input.entities = input.entities.filter((entity) =>
      entity.kind === "endpoint" || entity.kind === "provider_sdk_method"
    );
    input.relationships = input.relationships.filter((edge) => edge.kind === "uses_endpoint");
    const version = publishSoftwareGraphVersion(db, input);
    const result = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/charges",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });

    expect(result.impact).toBe("no_impact");
    expect(result.paths).toEqual([]);
  });

  it("reports impact when callers exist even if no test reaches the changed endpoint", () => {
    const db = openGraphLearnMemory();
    const input = publication();
    input.entities = input.entities.filter((entity) => entity.kind !== "test");
    input.relationships = input.relationships.filter((edge) => edge.kind !== "tests");
    input.coverage = input.coverage.map((stage) =>
      stage.stage === "test_resolution" ? { ...stage, analyzed: 0 } : stage,
    );
    const version = publishSoftwareGraphVersion(db, input);
    const result = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/charges",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });

    expect(result.impact).toBe("impact");
    expect(result.relationships.map((edge) => edge.kind)).toContain("wraps");
  });

  it("fails closed on cross tenant or cross repository exact-version reads", () => {
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication());
    expect(() => readSoftwareGraphVersion(db, "tenant-b", "repo-a", version.versionId)).toThrow(
      "software_graph_version_not_found",
    );
    expect(() => readSoftwareGraphVersion(db, "tenant-a", "repo-b", version.versionId)).toThrow(
      "software_graph_version_not_found",
    );
  });

  it("rejects a stored publication whose authenticated content scope differs from its row scope", () => {
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication());
    const stored = db.raw.prepare(
      "SELECT content_json FROM gl_software_versions_v1 WHERE version_id = ?",
    ).get(version.versionId) as { content_json: string };
    const changed = { ...(JSON.parse(stored.content_json) as SoftwareGraphPublicationV1), tenantId: "tenant-b" };
    const contentJson = JSON.stringify(changed);
    const contentDigest = `sha256:${createHash("sha256").update(contentJson).digest("hex")}`;
    db.raw.prepare(
      "UPDATE gl_software_versions_v1 SET content_json = ?, content_digest = ? WHERE version_id = ?",
    ).run(contentJson, contentDigest, version.versionId);

    expect(() => readSoftwareGraphVersion(db, "tenant-a", "repo-a", version.versionId)).toThrow(
      "software_graph_version_scope_mismatch",
    );
  });

  it("rejects runtime enum values outside the versioned ontology", () => {
    const db = openGraphLearnMemory();
    const invalid = publication();
    invalid.entities[0] = { ...invalid.entities[0]!, kind: "database" as never };
    expect(() => publishSoftwareGraphVersion(db, invalid)).toThrow(
      "software_graph_entity_kind_invalid",
    );
    const invalidScope = publication();
    invalidScope.entities[0] = { ...invalidScope.entities[0]!, scope: "repository" };
    expect(() => publishSoftwareGraphVersion(db, invalidScope)).toThrow(
      "software_graph_entity_scope_invalid",
    );
  });

  it("requires entity extractor, derivation, confidence basis, and validity provenance", () => {
    for (const [field, code] of [
      ["extractor", "software_graph_entity_extractor_invalid"],
      ["derivation", "software_graph_entity_derivation_invalid"],
      ["confidenceBasis", "software_graph_entity_confidence_basis_invalid"],
      ["validFrom", "software_graph_entity_validity_invalid"],
    ] as const) {
      const db = openGraphLearnMemory();
      const invalid = publication();
      delete (invalid.entities[0] as unknown as Record<string, unknown>)[field];
      expect(() => publishSoftwareGraphVersion(db, invalid)).toThrow(code);
    }
    // A numeric confidence has no place in the graph today: the calibrated
    // probability basis was removed, so a `confidence` key is an unknown field
    // and is rejected by the shape check rather than a confidence-specific rule.
    const fabricatedProbability = publication();
    (fabricatedProbability.entities[0] as unknown as Record<string, unknown>).confidence = 1;
    const probabilityDb = openGraphLearnMemory();
    expect(() => publishSoftwareGraphVersion(probabilityDb, fabricatedProbability)).toThrow(
      "software_graph_entity_shape_invalid",
    );
    const db = openGraphLearnMemory();
    const invalidRelationship = publication();
    delete (invalidRelationship.relationships[0] as unknown as Record<string, unknown>).validFrom;
    expect(() => publishSoftwareGraphVersion(db, invalidRelationship)).toThrow(
      "software_graph_relationship_validity_invalid",
    );
    const unexpected = publication();
    (unexpected.entities[0] as unknown as Record<string, unknown>).unversioned = true;
    expect(() => publishSoftwareGraphVersion(db, unexpected)).toThrow(
      "software_graph_entity_shape_invalid",
    );
    const missingCoverageExtractor = publication();
    delete (missingCoverageExtractor.coverage[0] as unknown as Record<string, unknown>).extractor;
    expect(() => publishSoftwareGraphVersion(db, missingCoverageExtractor)).toThrow(
      "software_graph_coverage_extractor_invalid",
    );
  });

  it("rejects an incomplete coverage declaration and invalid relationship semantics", () => {
    const db = openGraphLearnMemory();
    const missingCoverage = publication();
    missingCoverage.coverage = missingCoverage.coverage.filter(
      (stage) => stage.stage !== "sdk_resolution",
    );
    expect(() => publishSoftwareGraphVersion(db, missingCoverage)).toThrow(
      "software_graph_coverage_incomplete",
    );

    const invalidRelationship = publication();
    invalidRelationship.relationships[0] = {
      ...invalidRelationship.relationships[0]!,
      sourceId: "function:bill-customer",
    };
    expect(() => publishSoftwareGraphVersion(db, invalidRelationship)).toThrow(
      "software_graph_relationship_semantics_invalid",
    );

    const dishonestCoverage = publication();
    dishonestCoverage.coverage[0] = { ...dishonestCoverage.coverage[0]!, omitted: 1 };
    expect(() => publishSoftwareGraphVersion(db, dishonestCoverage)).toThrow(
      "software_graph_coverage_semantics_invalid",
    );

    const futureEvidence = publication();
    futureEvidence.entities[0] = {
      ...futureEvidence.entities[0]!,
      validFrom: "2026-08-18T12:00:00.000Z",
    };
    expect(() => publishSoftwareGraphVersion(db, futureEvidence)).toThrow(
      "software_graph_entity_validity_invalid",
    );
  });

  it("distinguishes complete no impact from unknown impact", () => {
    const db = openGraphLearnMemory();
    const input = publication();
    input.entities.push({
      ...entityProvenance,
      id: "endpoint:refunds-create",
      kind: "endpoint",
      canonicalKey: "POST /v1/refunds",
      aliases: ["refunds.create"],
      label: "POST /v1/refunds",
      scope: "provider",
      evidenceRefs: ["artifact:openapi:v1"],
      status: "active",
    });
    const version = publishSoftwareGraphVersion(db, input);
    const noImpact = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/refunds",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });
    const filtered = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/charges",
      allowedRelationshipKinds: [],
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });
    const unknown = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "missing",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });
    expect(noImpact.impact).toBe("no_impact");
    expect(filtered.impact).toBe("unknown_impact");
    expect(filtered.coverage.reasons).toContain("relationship_kinds_filtered");
    expect(unknown.impact).toBe("unknown_impact");
  });

  it("surfaces stale or conflicting graph evidence as incomplete coverage", () => {
    const db = openGraphLearnMemory();
    const input = publication();
    input.relationships = input.relationships.map((edge) =>
      edge.kind === "wraps" ? { ...edge, status: "stale" as const } : edge,
    );
    const version = publishSoftwareGraphVersion(db, input);
    const result = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/charges",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });

    expect(result.impact).toBe("impact");
    expect(result.coverage.basis).toBe("partial");
    expect(result.coverage.reasons).toContain("graph_non_active_evidence");
  });

  it("compiles deterministic bounded context with evidence and no graph dump", () => {
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication());
    const result = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/charges",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });
    const first = compileFettlerImpactContext(result, { maxBytes: 8_192 });
    const second = compileFettlerImpactContext(result, { maxBytes: 8_192 });
    expect(first).toEqual(second);
    expect(first.byteLength).toBeLessThanOrEqual(8_192);
    expect(first.content).toContain("artifact:openapi:v1");
    expect(first.content).not.toContain("props_json");
    expect(first.content).not.toContain('"sourceId"');
    expect(first.content).not.toContain('"targetId"');
    expect(first.content).not.toContain('"id":"endpoint:');
    expect(first.byteLength).toBeLessThan(1_800);
  });

  it("names the compiled impact a MissionGraphProjection without dumping the graph", () => {
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication());
    const result = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/charges",
      maxHops: 6,
      maxEntities: 20,
      maxRelationships: 20,
    });
    const projection = compileMissionGraphProjection({
      impact: result,
      missionId: "mission-a",
      maxBytes: 8_192,
    });
    expect(projection.schemaVersion).toBe("mendpoint.mission-graph-projection.v1");
    expect(projection.missionId).toBe("mission-a");
    expect(projection.graphVersionId).toBe(result.graphVersionId);
    expect(projection.compiled).toEqual(compileFettlerImpactContext(result, { maxBytes: 8_192 }));
    expect(projection.compiled.content).not.toContain("props_json");
  });

  it("routes representation failures away from model weight training", () => {
    for (const code of [
      "software_graph_entity_unresolved",
      "software_graph_parser_unsupported",
      "software_graph_publication_failed",
      "software_graph_query_truncated",
      "fettler_impact_context_too_large",
    ]) {
      const failure = classifyChangeGraphFailure(code);
      expect(failure.modelWeightEligible).toBe(false);
      expect(failure.destination).not.toBe("model");
    }
    expect(classifyChangeGraphFailure("generator_incorrect_with_complete_graph")).toEqual({
      destination: "model",
      category: "generator",
      modelWeightEligible: true,
    });
  });

  it("creates a deterministic pending relationship candidate without advancing the graph head", () => {
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication());
    const input = {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-1",
      repositoryRevision: "a".repeat(40),
      providerId: "provider-a",
      providerSnapshotId: "provider-snapshot-1",
      providerRevision: "2026-08-17",
      parentGraphVersionId: version.versionId,
      parentGraphContentDigest: version.contentDigest,
      observedAt: "2026-08-17T12:00:00.000Z",
      retrieval: {
        reasonCodes: ["language_parsing:partial"],
        maxFiles: 100,
        maxBytes: 1_000_000,
        maxFileBytes: 100_000,
        maxTraversalDepth: 16,
        maxCandidates: 50,
        filesInspected: 4,
        bytesInspected: 4_096,
        candidatesInspected: 2,
      },
      discovery: {
        filePath: "src/payments/client.ts",
        lineStart: 10,
        lineEnd: 11,
        symbol: "createCharge",
        surfaceIds: ["surface:charges-create"],
        evidenceRefs: ["source:src/payments/client.ts:10"],
        confidence: "high" as const,
      },
    };

    const first = createRawRetrievalRelationshipCandidate(input);
    const second = createRawRetrievalRelationshipCandidate(input);

    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe("mendpoint.raw-retrieval-relationship-candidate.v1");
    expect(first.status).toBe("pending_validation");
    expect(first.candidateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(getSoftwareGraphHead(db, "tenant-a", "repo-a", "provider-a")).toEqual({
      versionId: version.versionId,
      contentDigest: version.contentDigest,
    });
    expect(assertRawRetrievalRelationshipCandidateAuthority(first, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-1",
      repositoryRevision: "a".repeat(40),
      providerId: "provider-a",
      providerSnapshotId: "provider-snapshot-1",
      providerRevision: "2026-08-17",
      parentGraphVersionId: version.versionId,
      parentGraphContentDigest: version.contentDigest,
    })).toEqual(first);
  });

  it("rejects stale, cross-scope, tampered, unbounded, and evidence-free fallback candidates", () => {
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication());
    const valid = createRawRetrievalRelationshipCandidate({
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-1",
      repositoryRevision: "a".repeat(40),
      providerId: "provider-a",
      providerSnapshotId: "provider-snapshot-1",
      providerRevision: "2026-08-17",
      parentGraphVersionId: version.versionId,
      parentGraphContentDigest: version.contentDigest,
      observedAt: "2026-08-17T12:00:00.000Z",
      retrieval: {
        reasonCodes: ["query_truncated"],
        maxFiles: 10,
        maxBytes: 10_000,
        maxFileBytes: 1_000,
        maxTraversalDepth: 8,
        maxCandidates: 5,
        filesInspected: 1,
        bytesInspected: 100,
        candidatesInspected: 1,
      },
      discovery: {
        filePath: "src/payments/client.ts",
        lineStart: 10,
        lineEnd: 10,
        symbol: "createCharge",
        surfaceIds: ["surface:charges-create"],
        evidenceRefs: ["source:src/payments/client.ts:10"],
        confidence: "high",
      },
    });
    const authority = {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-1",
      repositoryRevision: "a".repeat(40),
      providerId: "provider-a",
      providerSnapshotId: "provider-snapshot-1",
      providerRevision: "2026-08-17",
      parentGraphVersionId: version.versionId,
      parentGraphContentDigest: version.contentDigest,
    };

    expect(() => assertRawRetrievalRelationshipCandidateAuthority(valid, {
      ...authority,
      tenantId: "tenant-b",
    })).toThrow("raw_retrieval_candidate_scope_mismatch");
    expect(() => assertRawRetrievalRelationshipCandidateAuthority(valid, {
      ...authority,
      repositorySnapshotId: "snapshot-2",
    })).toThrow("raw_retrieval_candidate_snapshot_mismatch");
    expect(() => assertRawRetrievalRelationshipCandidateAuthority(valid, {
      ...authority,
      parentGraphVersionId: `sgv1:${"f".repeat(64)}`,
      parentGraphContentDigest: `sha256:${"f".repeat(64)}`,
    })).toThrow("raw_retrieval_candidate_parent_mismatch");
    expect(() => assertRawRetrievalRelationshipCandidateAuthority({
      ...valid,
      discovery: { ...valid.discovery, symbol: "tampered" },
    }, authority)).toThrow("raw_retrieval_candidate_digest_mismatch");
    expect(() => createRawRetrievalRelationshipCandidate({
      ...valid,
      retrieval: { ...valid.retrieval, filesInspected: valid.retrieval.maxFiles + 1 },
    })).toThrow("raw_retrieval_candidate_budget_exceeded");
    for (const field of ["maxFileBytes", "maxTraversalDepth"] as const) {
      const retrieval = { ...valid.retrieval } as Record<string, unknown>;
      delete retrieval[field];
      expect(() => createRawRetrievalRelationshipCandidate({
        ...valid,
        retrieval: retrieval as typeof valid.retrieval,
      })).toThrow("raw_retrieval_candidate_budget_invalid");
    }
    expect(() => createRawRetrievalRelationshipCandidate({
      ...valid,
      retrieval: { ...valid.retrieval, maxFileBytes: 5_242_881 },
    })).toThrow("raw_retrieval_candidate_budget_invalid");
    expect(() => createRawRetrievalRelationshipCandidate({
      ...valid,
      retrieval: { ...valid.retrieval, maxTraversalDepth: 65 },
    })).toThrow("raw_retrieval_candidate_budget_invalid");
    expect(() => createRawRetrievalRelationshipCandidate({
      ...valid,
      retrieval: { ...valid.retrieval, unexpectedBound: 1 } as typeof valid.retrieval,
    })).toThrow("raw_retrieval_candidate_budget_invalid");
    expect(() => assertRawRetrievalRelationshipCandidateAuthority({
      ...valid,
      retrieval: { ...valid.retrieval, maxTraversalDepth: 7 },
    }, authority)).toThrow("raw_retrieval_candidate_digest_mismatch");
    expect(() => createRawRetrievalRelationshipCandidate({
      ...valid,
      discovery: { ...valid.discovery, evidenceRefs: [] },
    })).toThrow("raw_retrieval_candidate_evidence_invalid");
    expect(getSoftwareGraphHead(db, "tenant-a", "repo-a", "provider-a")?.versionId)
      .toBe(version.versionId);
  });
});
