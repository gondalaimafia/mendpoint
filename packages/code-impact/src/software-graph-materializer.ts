import { createHash } from "node:crypto";
import type { CodebaseIndex, ApiUsageRecord } from "@mendpoint/codebase-index";
import type {
  SoftwareGraphCoverageStageV1,
  SoftwareGraphEntityV1,
  SoftwareGraphPublicationV1,
  SoftwareGraphRelationshipV1,
} from "@mendpoint/graph-learn";

type EndpointInput = {
  canonicalKey: string;
  method: string;
  path: string;
  sdkMethodPaths: string[];
  evidenceRefs: string[];
};

export type FettlerSoftwareGraphMaterializationInput = {
  index: CodebaseIndex;
  tenantId: string;
  repositoryId: string;
  repositorySnapshotId: string;
  repositoryRevision: string;
  providerId: string;
  providerSnapshotId: string;
  providerRevision: string;
  providerSdkPackage: string;
  providerSdkVersion: string;
  endpoint: EndpointInput;
  providerEndpointSurfaceCount: number;
  observedAt: string;
  parentVersionId?: string;
  maxCallerHops: number;
};

const EXTRACTOR_SOURCE = "mendpoint.code-impact.software-graph.v1";
const EXTRACTOR = Object.freeze({
  id: "mendpoint.code-impact",
  version: "1.0.0",
  digest: `sha256:${createHash("sha256").update(EXTRACTOR_SOURCE).digest("hex")}`,
});

const compareCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const digestId = (prefix: string, value: string) =>
  `${prefix}:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function sourceRef(filePath: string, line: number): string {
  return `source:${filePath.replace(/\\/g, "/")}:${line}`;
}

type SdkMethodMatch = { sdkMethod: string; exact: boolean };

function matchesSdkMethod(
  usage: ApiUsageRecord,
  endpoint: Pick<EndpointInput, "path" | "sdkMethodPaths">,
): SdkMethodMatch | undefined {
  if (usage.kind !== "sdk_call" || usage.detection !== "provider_surface") return undefined;
  const value = usage.value.toLowerCase();
  const explicit = endpoint.sdkMethodPaths.find(
    (path) => value === path.toLowerCase() || value.endsWith(`.${path.toLowerCase()}`),
  );
  if (explicit) return { sdkMethod: explicit, exact: true };
  // Fallback: the SDK method path was never supplied, so we guess from the
  // endpoint's last path segment appearing anywhere in the dotted call. This is
  // a heuristic, NOT a deterministic binding — it must never be labelled
  // `deterministic_exact` in evidence a reviewer reads.
  const resource = endpoint.path
    .split("/")
    .filter((part) => part && !part.startsWith("{"))
    .at(-1)
    ?.toLowerCase();
  return resource && value.split(".").includes(resource)
    ? { sdkMethod: usage.value, exact: false }
    : undefined;
}

function addEntity(map: Map<string, SoftwareGraphEntityV1>, entity: SoftwareGraphEntityV1): void {
  const existing = map.get(entity.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(entity)) {
    throw new Error("software_graph_materializer_entity_collision");
  }
  map.set(entity.id, entity);
}

function addRelationship(
  map: Map<string, SoftwareGraphRelationshipV1>,
  input: {
    kind: SoftwareGraphRelationshipV1["kind"];
    sourceId: string;
    targetId: string;
    evidenceRefs: string[];
    derivation: SoftwareGraphRelationshipV1["derivation"];
    confidenceBasis: SoftwareGraphRelationshipV1["confidenceBasis"];
    validFrom: string;
  },
): void {
  const id = digestId("relationship", [input.kind, input.sourceId, input.targetId, ...input.evidenceRefs].join("\0"));
  map.set(id, {
    id,
    kind: input.kind,
    sourceId: input.sourceId,
    targetId: input.targetId,
    evidenceRefs: [...input.evidenceRefs].sort(compareCodeUnits),
    extractor: EXTRACTOR,
    derivation: input.derivation,
    confidenceBasis: input.confidenceBasis,
    status: "active",
    validFrom: input.validFrom,
  });
}

export function materializeFettlerSoftwareGraph(
  input: FettlerSoftwareGraphMaterializationInput,
): SoftwareGraphPublicationV1 {
  if (!Number.isInteger(input.maxCallerHops) || input.maxCallerHops < 1 || input.maxCallerHops > 8) {
    throw new Error("software_graph_materializer_hops_invalid");
  }
  if (
    !Number.isSafeInteger(input.providerEndpointSurfaceCount) ||
    input.providerEndpointSurfaceCount < 1 || input.providerEndpointSurfaceCount > 10_000
  ) throw new Error("software_graph_materializer_provider_coverage_invalid");
  const entities = new Map<string, SoftwareGraphEntityV1>();
  const relationships = new Map<string, SoftwareGraphRelationshipV1>();
  const endpointId = digestId(
    "endpoint",
    `${input.providerSnapshotId}\0${input.endpoint.method.toUpperCase()}\0${input.endpoint.path}`,
  );
  addEntity(entities, {
    id: endpointId,
    kind: "endpoint",
    canonicalKey: input.endpoint.canonicalKey,
    aliases: input.endpoint.sdkMethodPaths,
    label: `${input.endpoint.method.toUpperCase()} ${input.endpoint.path}`,
    scope: "provider",
    evidenceRefs: input.endpoint.evidenceRefs,
    extractor: EXTRACTOR,
    derivation: "provider_spec",
    confidenceBasis: "deterministic_exact",
    status: "active",
    validFrom: input.observedAt,
  });

  const matchedUsages = input.index.apiUsages
    .map((usage) => ({ usage, match: matchesSdkMethod(usage, input.endpoint) }))
    .filter((item): item is { usage: ApiUsageRecord; match: SdkMethodMatch } => Boolean(item.match))
    .sort((a, b) => compareCodeUnits(`${a.usage.filePath}\0${a.usage.line}`, `${b.usage.filePath}\0${b.usage.line}`));

  const graph = input.index.callGraph;
  const graphEdgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  let unattributedUsages = 0;

  // Resolve the enclosing function ("seed") for a matched usage. A single
  // function can hold several matched call sites -- a retry that calls in both
  // try and catch, or a list then a create -- and all of them must fold into ONE
  // internal_sdk_method entity whose evidenceRefs carry every call-site line.
  const seedFor = (usage: ApiUsageRecord) =>
    Object.values(graph.nodes)
      .filter((node) =>
        node.filePath.replace(/\\/g, "/") === usage.filePath.replace(/\\/g, "/") &&
        usage.line >= node.lineStart && usage.line <= node.lineEnd &&
        (!usage.functionName || node.name === usage.functionName),
      )
      .sort((a, b) => compareCodeUnits(a.id, b.id))[0];
  const seedKeyOf = (seed: NonNullable<ReturnType<typeof seedFor>>) =>
    `${seed.filePath.replace(/\\/g, "/")}::${seed.enclosingType ?? ""}::${seed.name}`;
  const seedEntityIdOf = (seedKey: string) =>
    digestId("internal-sdk-method", `${input.repositorySnapshotId}\0${seedKey}`);

  // Pre-pass: accumulate every matched call-site line per seed entity so the
  // entity is emitted once, below, with its complete evidence. Emitting it once
  // per usage instead collides in addEntity (identical file::type::name id,
  // differing evidenceRefs) and leaves the whole graph unpublishable.
  const seedEvidenceRefs = new Map<string, Set<string>>();
  for (const { usage } of matchedUsages) {
    const seed = seedFor(usage);
    if (!seed) continue;
    const seedEntityId = seedEntityIdOf(seedKeyOf(seed));
    const refs = seedEvidenceRefs.get(seedEntityId) ?? new Set<string>();
    refs.add(sourceRef(seed.filePath, usage.line));
    seedEvidenceRefs.set(seedEntityId, refs);
  }

  const bfsSeeded = new Set<string>();
  for (const { usage, match } of matchedUsages) {
    const { sdkMethod, exact } = match;
    // The endpoint binding is only as trustworthy as the match that produced it:
    // an explicit SDK method path is a deterministic binding; a last-path-segment
    // guess is a heuristic and must never be labelled deterministic_exact in
    // evidence a reviewer reads.
    const sdkBindingBasis = exact ? "deterministic_exact" as const : "static_analysis_medium" as const;
    const providerSdkId = digestId(
      "provider-sdk-method",
      `${input.providerSnapshotId}\0${input.providerSdkPackage}\0${input.providerSdkVersion}\0${sdkMethod}`,
    );
    addEntity(entities, {
      id: providerSdkId,
      kind: "provider_sdk_method",
      canonicalKey: `${input.providerSdkPackage}@${input.providerSdkVersion}:${sdkMethod}`,
      aliases: [sdkMethod],
      label: sdkMethod,
      scope: "provider",
      evidenceRefs: [
        ...input.endpoint.evidenceRefs,
        `provider-sdk:${input.providerSdkPackage}@${input.providerSdkVersion}:${sdkMethod}`,
      ],
      extractor: EXTRACTOR,
      derivation: "provider_sdk_binding",
      confidenceBasis: sdkBindingBasis,
      status: "active",
      validFrom: input.observedAt,
    });
    addRelationship(relationships, {
      kind: "uses_endpoint",
      sourceId: providerSdkId,
      targetId: endpointId,
      evidenceRefs: input.endpoint.evidenceRefs,
      derivation: "provider_sdk_binding",
      confidenceBasis: sdkBindingBasis,
      validFrom: input.observedAt,
    });

    const seed = seedFor(usage);
    if (!seed) {
      unattributedUsages += 1;
      continue;
    }
    const seedKey = seedKeyOf(seed);
    const seedEntityId = seedEntityIdOf(seedKey);
    addEntity(entities, {
      id: seedEntityId,
      kind: "internal_sdk_method",
      canonicalKey: `internal_sdk_method:${seedKey}`,
      aliases: [seed.name],
      label: seed.name,
      scope: "repository",
      evidenceRefs: [...(seedEvidenceRefs.get(seedEntityId) ?? [sourceRef(seed.filePath, usage.line)])].sort(compareCodeUnits),
      extractor: EXTRACTOR,
      derivation: "repository_usage",
      confidenceBasis: "deterministic_exact",
      status: "active",
      validFrom: input.observedAt,
    });
    addRelationship(relationships, {
      kind: "uses_sdk_method",
      sourceId: seedEntityId,
      targetId: providerSdkId,
      evidenceRefs: [sourceRef(usage.filePath, usage.line)],
      derivation: "repository_usage",
      confidenceBasis: "deterministic_exact",
      validFrom: input.observedAt,
    });

    // Caller expansion depends only on the seed function, not the individual call
    // site, so walk it once per seed however many matched usages it holds.
    if (bfsSeeded.has(seed.id)) continue;
    bfsSeeded.add(seed.id);
    const runtimeToEntity = new Map<string, string>([[seed.id, seedEntityId]]);
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: seed.id, depth: 0 }];
    const visited = new Map<string, number>([[seed.id, 0]]);
    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth >= input.maxCallerHops) continue;
      const incomingIds = graph.inEdges[current.nodeId] ?? [];
      const incomingEdges = incomingIds
        .map((edgeId) => graphEdgeById.get(edgeId))
        .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
        .sort((a, b) => compareCodeUnits(a.id, b.id));
      for (const edge of incomingEdges) {
        const caller = graph.nodes[edge.callerId];
        if (!caller) continue;
        const callerKey = `${caller.filePath.replace(/\\/g, "/")}::${caller.enclosingType ?? ""}::${caller.name}`;
        const callerKind = caller.isTest ? "test" as const : "function" as const;
        const callerEntityId = digestId(callerKind, `${input.repositorySnapshotId}\0${callerKey}`);
        addEntity(entities, {
          id: callerEntityId,
          kind: callerKind,
          canonicalKey: `${callerKind}:${callerKey}`,
          aliases: [caller.name],
          label: caller.name,
          scope: "repository",
          evidenceRefs: [sourceRef(caller.filePath, caller.lineStart)],
          extractor: EXTRACTOR,
          derivation: "call_graph",
          confidenceBasis: "deterministic_exact",
          status: "active",
          validFrom: input.observedAt,
        });
        runtimeToEntity.set(caller.id, callerEntityId);
        const targetEntityId = runtimeToEntity.get(current.nodeId);
        if (!targetEntityId) throw new Error("software_graph_materializer_target_missing");
        const targetKind = entities.get(targetEntityId)?.kind;
        if (!targetKind) throw new Error("software_graph_materializer_target_missing");
        addRelationship(relationships, {
          kind: callerKind === "test"
            ? targetKind === "test" ? "calls" : "tests"
            : current.depth === 0 ? "wraps" : "calls",
          sourceId: callerEntityId,
          targetId: targetEntityId,
          evidenceRefs: [sourceRef(edge.callSiteFile, edge.callSiteLine)],
          derivation: "call_graph",
          confidenceBasis: edge.confidence === "high"
            ? "static_analysis_high"
            : edge.confidence === "medium"
              ? "static_analysis_medium"
              : "static_analysis_low",
          validFrom: input.observedAt,
        });
        const priorDepth = visited.get(caller.id);
        if (priorDepth === undefined || priorDepth > current.depth + 1) {
          visited.set(caller.id, current.depth + 1);
          queue.push({ nodeId: caller.id, depth: current.depth + 1 });
        }
      }
    }
  }

  const diagnostics = input.index.callGraph.diagnostics;
  const unsupported = diagnostics?.unsupportedLanguageFiles ?? [];
  const unsupportedReasons = unsupported.length
    ? [...new Set(unsupported.map((file) => `unsupported:${file.language}`))]
        .sort(compareCodeUnits)
    : [];
  const skippedDirectories = input.index.skippedDirectories;
  // A deliberately-pruned dependency or VCS tree (`.git`, `node_modules`, a
  // virtualenv) is correct SCOPE, not a coverage gap: we chose not to walk it,
  // we did not try and fail. Only a skip we did NOT choose -- an unreadable or
  // otherwise genuinely-omitted directory -- reduces discovery coverage and
  // drives `partial`. Without this, every git working tree (every production
  // analysis) is permanently `partial`, so `no_impact` is unreachable and every
  // evidence row is `failed`.
  //
  // The deliberate prunes are NOT echoed into `reasons` here: the coverage
  // schema forbids reasons on a `complete` stage (a complete stage must have
  // omitted === 0 and reasons === undefined), and they remain fully auditable in
  // `index.skippedDirectories`. Only the genuine gaps -- which make the stage
  // `partial` -- are reported as reasons.
  const isDeliberatePrune = (reason: string) =>
    reason.startsWith("ignored_name:") || reason.startsWith("python_virtualenv:");
  const genuineDiscoveryGaps = skippedDirectories.filter(
    (entry) => !isDeliberatePrune(entry.reason),
  );
  const discoveryReasons = [...new Set(genuineDiscoveryGaps.map(
    (entry) => `skipped_directory:${entry.reason}`,
  ))].sort(compareCodeUnits).slice(0, 32);
  const callReasons = [...unsupportedReasons];
  if (unattributedUsages > 0) callReasons.push("sdk_usage_not_attributed_to_function");
  const diagnosticsUnavailable = ["call_graph_diagnostics_unavailable"];
  const coverage: SoftwareGraphCoverageStageV1[] = [
    {
      extractor: EXTRACTOR,
      stage: "repository_discovery",
      basis: genuineDiscoveryGaps.length ? "partial" : "complete",
      analyzed: input.index.files.length,
      omitted: genuineDiscoveryGaps.length,
      reasons: genuineDiscoveryGaps.length ? discoveryReasons : undefined,
      evidenceRefs: [`repository-snapshot:${input.repositorySnapshotId}`],
    },
    {
      extractor: EXTRACTOR,
      stage: "language_parsing",
      basis: diagnostics ? unsupported.length ? "partial" : "complete" : "not_analyzed",
      analyzed: diagnostics ? input.index.files.length - unsupported.length : 0,
      omitted: diagnostics ? unsupported.length : input.index.files.length,
      reasons: diagnostics
        ? unsupported.length ? unsupportedReasons : undefined
        : diagnosticsUnavailable,
      evidenceRefs: [`code-index:${input.repositorySnapshotId}`],
    },
    {
      extractor: EXTRACTOR,
      stage: "provider_specification",
      // This graph answers impact for exactly the ONE endpoint it materialized,
      // and the impact query targets that endpoint by key. Sibling endpoints
      // changed in the same diff are each their own query's responsibility, not a
      // gap in THIS endpoint's provider-specification coverage -- that endpoint's
      // spec was fully processed. Treating their mere presence as `partial` made
      // the confident negative unreachable for a fully-analyzed endpoint (the
      // same inertness as the `.git` skip), so this stage is `complete` for the
      // single materialized endpoint. (The coverage schema forbids reasons on a
      // complete stage; the sibling count is available to callers from the
      // surface list, not recorded here as a coverage gap.)
      basis: "complete",
      analyzed: 1,
      omitted: 0,
      reasons: undefined,
      evidenceRefs: input.endpoint.evidenceRefs,
    },
    {
      extractor: EXTRACTOR,
      stage: "sdk_resolution",
      basis: matchedUsages.length ? "complete" : "partial",
      analyzed: matchedUsages.length,
      omitted: matchedUsages.length ? 0 : 1,
      reasons: matchedUsages.length ? undefined : ["provider_sdk_method_unresolved"],
      evidenceRefs: [`provider-sdk:${input.providerSdkPackage}@${input.providerSdkVersion}`],
    },
    {
      extractor: EXTRACTOR,
      stage: "call_resolution",
      basis: diagnostics
        ? callReasons.length ? "partial" : "complete"
        : "not_analyzed",
      analyzed: diagnostics ? graph.edges.length : 0,
      omitted: diagnostics ? unsupported.length + unattributedUsages : Math.max(1, matchedUsages.length),
      reasons: diagnostics
        ? callReasons.length ? callReasons : undefined
        : diagnosticsUnavailable,
      evidenceRefs: [`call-graph:${input.repositorySnapshotId}`],
    },
    {
      extractor: EXTRACTOR,
      stage: "test_resolution",
      basis: diagnostics ? unsupported.length ? "partial" : "complete" : "not_analyzed",
      analyzed: diagnostics ? Object.values(graph.nodes).filter((node) => node.isTest).length : 0,
      omitted: diagnostics ? unsupported.length : Math.max(1, input.index.files.filter((file) => file.isTest).length),
      reasons: diagnostics
        ? unsupported.length ? unsupportedReasons : undefined
        : diagnosticsUnavailable,
      evidenceRefs: [`call-graph:${input.repositorySnapshotId}:tests`],
    },
  ];

  return {
    schemaVersion: "mendpoint.software-graph.v1",
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    repositorySnapshotId: input.repositorySnapshotId,
    repositoryRevision: input.repositoryRevision,
    providerId: input.providerId,
    providerSnapshotId: input.providerSnapshotId,
    providerRevision: input.providerRevision,
    observedAt: input.observedAt,
    parentVersionId: input.parentVersionId,
    entities: [...entities.values()].sort((a, b) => compareCodeUnits(a.id, b.id)),
    relationships: [...relationships.values()].sort((a, b) => compareCodeUnits(a.id, b.id)),
    coverage,
  };
}
