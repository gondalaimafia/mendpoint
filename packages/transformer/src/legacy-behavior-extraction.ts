import { createHash } from "node:crypto";
import {
  extractBehavioralSpecGraph,
  type BsgEvidenceSource,
} from "./bsg-extractor.js";
import type {
  BsgEvidenceAssertion,
  BsgEvidenceRelation,
  ExtractedBehavioralSpecGraph,
} from "./bsg-extractor.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/i;
const SUPPORTED_KINDS = Object.freeze(["code", "test", "schema", "trace"] as const);
const MAX_ARTIFACTS = 500;
const MAX_ASSERTIONS = 2_000;
const MAX_RELATIONS = 4_000;
const MAX_PAYLOAD_BYTES = 2_000_000;
const MAX_JSON_DEPTH = 32;
const MAX_BSG_SOURCES = 500;
const MAX_EVIDENCE_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

export type LegacyBehaviorJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LegacyBehaviorJsonValue[]
  | { readonly [key: string]: LegacyBehaviorJsonValue };

export type LegacyBehaviorArtifact = {
  id: string;
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
  kind: "code" | "test" | "schema" | "trace";
  locator: string;
  contentDigest: string;
  observedAt: string;
  payload: LegacyBehaviorJsonValue;
};

export type LegacyBehaviorCollector = {
  id: string;
  version: string;
  digest: string;
  kinds: readonly LegacyBehaviorArtifact["kind"][];
  collect(input: LegacyBehaviorArtifact): Readonly<{
    assertions: readonly BsgEvidenceAssertion[];
    relations: readonly BsgEvidenceRelation[];
  }>;
};

export type LegacyBehaviorCollectorPin = {
  id: string;
  version: string;
  digest: string;
};

export type LegacyBehaviorExtractionPolicy =
  | { enabled: false }
  | {
      enabled: true;
      allowedCollectors: LegacyBehaviorCollectorPin[];
      maxArtifacts: number;
      maxAssertions: number;
      maxRelations: number;
      maxPayloadBytes: number;
      allowModelInference: false;
    };

export type LegacyBehaviorExtractionInput = {
  policy?: LegacyBehaviorExtractionPolicy;
  tenantId: string;
  title: string;
  sourceSystem: string;
  targetSystem: string;
  evaluatedAt: string;
  maxEvidenceAgeMs: number;
  artifacts: LegacyBehaviorArtifact[];
  collectors: LegacyBehaviorCollector[];
};

export type LegacyBehaviorExtractionResult =
  | Readonly<{
      status: "disabled";
      reason: "legacy_behavior_extraction_disabled";
    }>
  | Readonly<{
      status: "extracted";
      graph: ExtractedBehavioralSpecGraph;
      collectorEvidenceRefs: readonly string[];
    }>;

export class LegacyBehaviorExtractionError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code);
    this.name = "LegacyBehaviorExtractionError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

function fail(code: string, cause?: unknown): never {
  throw new LegacyBehaviorExtractionError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function requiredText(value: unknown, code: string, maxLength = 1_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) fail(code);
  return value.trim();
}

function boundedInteger(value: unknown, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(code);
  }
  return value as number;
}

function canonicalJson(
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): string {
  if (depth > MAX_JSON_DEPTH) fail("legacy_behavior_artifact_payload_invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("legacy_behavior_artifact_payload_invalid");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail("legacy_behavior_artifact_payload_invalid");
  if (seen.has(value)) fail("legacy_behavior_artifact_payload_invalid");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) fail("legacy_behavior_artifact_payload_invalid");
        items.push(canonicalJson(value[index], seen, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("legacy_behavior_artifact_payload_invalid");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      fail("legacy_behavior_artifact_payload_invalid");
    }
    const entries = (ownKeys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
        fail("legacy_behavior_artifact_payload_invalid");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen, depth + 1)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function collectorKey(value: Pick<LegacyBehaviorCollector, "id" | "version">): string {
  return `${value.id.length}:${value.id}${value.version}`;
}

type EnabledPolicyPlan = Readonly<{
  allowedCollectors: readonly Readonly<LegacyBehaviorCollectorPin>[];
  maxArtifacts: number;
  maxAssertions: number;
  maxRelations: number;
  maxPayloadBytes: number;
}>;

function validatePolicy(
  policy: Extract<LegacyBehaviorExtractionPolicy, { enabled: true }>,
): EnabledPolicyPlan {
  if (policy.allowModelInference !== false) fail("legacy_behavior_model_inference_forbidden");
  boundedInteger(policy.maxArtifacts, MAX_ARTIFACTS, "legacy_behavior_artifact_limit_invalid");
  boundedInteger(policy.maxAssertions, MAX_ASSERTIONS, "legacy_behavior_assertion_limit_invalid");
  boundedInteger(policy.maxRelations, MAX_RELATIONS, "legacy_behavior_relation_limit_invalid");
  boundedInteger(policy.maxPayloadBytes, MAX_PAYLOAD_BYTES, "legacy_behavior_payload_limit_invalid");
  if (!Array.isArray(policy.allowedCollectors) || policy.allowedCollectors.length === 0) {
    fail("legacy_behavior_collector_allowlist_required");
  }
  const identities = new Set<string>();
  const allowedCollectors: Readonly<LegacyBehaviorCollectorPin>[] = [];
  for (const pin of policy.allowedCollectors) {
    const id = requiredText(pin?.id, "legacy_behavior_collector_pin_invalid", 200);
    const version = requiredText(pin?.version, "legacy_behavior_collector_pin_invalid", 200);
    if (!DIGEST.test(pin?.digest ?? "")) fail("legacy_behavior_collector_pin_invalid");
    const identity = collectorKey({ id, version });
    if (identities.has(identity)) fail("legacy_behavior_collector_pin_conflict");
    identities.add(identity);
    allowedCollectors.push(Object.freeze({ id, version, digest: pin.digest }));
  }
  return Object.freeze({
    allowedCollectors: Object.freeze(allowedCollectors),
    maxArtifacts: policy.maxArtifacts,
    maxAssertions: policy.maxAssertions,
    maxRelations: policy.maxRelations,
    maxPayloadBytes: policy.maxPayloadBytes,
  });
}

type CollectorPlan = Readonly<{
  id: string;
  version: string;
  digest: string;
  kinds: readonly LegacyBehaviorArtifact["kind"][];
  collect: LegacyBehaviorCollector["collect"];
}>;

function validateCollectors(
  collectors: LegacyBehaviorCollector[],
  policy: EnabledPolicyPlan,
): CollectorPlan[] {
  if (!Array.isArray(collectors) || collectors.length === 0) {
    fail("legacy_behavior_collectors_required");
  }
  const allowed = new Map(policy.allowedCollectors.map((pin) => [collectorKey(pin), pin]));
  const identities = new Set<string>();
  const validated = collectors.map((collector) => {
    const id = requiredText(collector?.id, "legacy_behavior_collector_invalid", 200);
    const version = requiredText(collector?.version, "legacy_behavior_collector_invalid", 200);
    const digest = collector?.digest;
    const kinds = collector?.kinds;
    const collect = collector?.collect;
    const identity = collectorKey({ id, version });
    if (identities.has(identity)) fail("legacy_behavior_collector_identity_conflict");
    identities.add(identity);
    const pin = allowed.get(identity);
    if (!pin || pin.digest !== digest || !DIGEST.test(digest ?? "")) {
      fail("legacy_behavior_collector_not_allowed");
    }
    if (typeof collect !== "function" || !Array.isArray(kinds) ||
      kinds.length === 0 || new Set(kinds).size !== kinds.length ||
      kinds.some((kind) => !SUPPORTED_KINDS.includes(kind))) {
      fail("legacy_behavior_collector_invalid");
    }
    return Object.freeze({
      id,
      version,
      digest: digest!,
      kinds: Object.freeze([...kinds]),
      collect: collect.bind(collector),
    });
  });
  return validated.sort((left, right) =>
    compareCodeUnits(
      `${left.id}\0${left.version}\0${left.digest}`,
      `${right.id}\0${right.version}\0${right.digest}`,
    ),
  );
}

type ExtractionContext = Readonly<{
  tenantId: string;
  title: string;
  sourceSystem: string;
  targetSystem: string;
  evaluatedAt: string;
  maxEvidenceAgeMs: number;
}>;

function validateContext(input: LegacyBehaviorExtractionInput): ExtractionContext {
  const evaluatedEpoch = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedEpoch)) fail("legacy_behavior_evaluated_at_invalid");
  return Object.freeze({
    tenantId: requiredText(input.tenantId, "legacy_behavior_tenant_required", 200),
    title: requiredText(input.title, "legacy_behavior_title_required", 500),
    sourceSystem: requiredText(input.sourceSystem, "legacy_behavior_source_system_required", 500),
    targetSystem: requiredText(input.targetSystem, "legacy_behavior_target_system_required", 500),
    evaluatedAt: new Date(evaluatedEpoch).toISOString(),
    maxEvidenceAgeMs: boundedInteger(
      input.maxEvidenceAgeMs,
      MAX_EVIDENCE_AGE_MS,
      "legacy_behavior_evidence_age_limit_invalid",
    ),
  });
}

type ArtifactPlan = Readonly<LegacyBehaviorArtifact>;

function validateArtifacts(
  input: LegacyBehaviorExtractionInput,
  policy: EnabledPolicyPlan,
  tenantId: string,
): Array<Readonly<{ artifact: ArtifactPlan; canonicalPayload: string }>> {
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    fail("legacy_behavior_artifacts_required");
  }
  if (input.artifacts.length > policy.maxArtifacts) fail("legacy_behavior_artifact_limit_exceeded");
  const identities = new Set<string>();
  const snapshots = new Map<string, string>();
  let totalPayloadBytes = 0;
  const validated = input.artifacts.map((artifact) => {
    const id = requiredText(artifact?.id, "legacy_behavior_artifact_invalid", 500);
    if (artifact.tenantId !== tenantId) fail("legacy_behavior_cross_tenant_artifact");
    const repositoryId = requiredText(
      artifact.repositoryId,
      "legacy_behavior_artifact_repository_required",
      500,
    );
    const snapshotId = requiredText(
      artifact.snapshotId,
      "legacy_behavior_artifact_snapshot_required",
      500,
    );
    if (!REVISION.test(artifact.revision)) fail("legacy_behavior_artifact_revision_invalid");
    if (!DIGEST.test(artifact.snapshotDigest)) fail("legacy_behavior_artifact_snapshot_digest_invalid");
    if (!SUPPORTED_KINDS.includes(artifact.kind)) fail("legacy_behavior_artifact_kind_invalid");
    const locator = requiredText(artifact.locator, "legacy_behavior_artifact_locator_required", 2_000);
    const observedEpoch = Date.parse(artifact.observedAt);
    if (!Number.isFinite(observedEpoch)) {
      fail("legacy_behavior_artifact_observed_at_invalid");
    }
    const canonicalPayload = canonicalJson(artifact.payload);
    totalPayloadBytes += Buffer.byteLength(canonicalPayload, "utf8");
    if (totalPayloadBytes > policy.maxPayloadBytes) {
      fail("legacy_behavior_artifact_payload_limit_exceeded");
    }
    const contentDigest = artifact.contentDigest;
    if (sha256(canonicalPayload) !== contentDigest) {
      fail("legacy_behavior_artifact_digest_mismatch");
    }
    const revision = artifact.revision.toLowerCase();
    const snapshotDigest = artifact.snapshotDigest.toLowerCase();
    const snapshotBinding = `${snapshotId}\0${revision}\0${snapshotDigest}`;
    const existingSnapshot = snapshots.get(repositoryId);
    if (existingSnapshot && existingSnapshot !== snapshotBinding) {
      fail("legacy_behavior_snapshot_binding_conflict");
    }
    snapshots.set(repositoryId, snapshotBinding);
    const identity = `${repositoryId}\0${snapshotId}\0${id}`;
    if (identities.has(identity)) fail("legacy_behavior_artifact_identity_conflict");
    identities.add(identity);
    const normalizedArtifact = deepFreeze({
      id,
      tenantId,
      repositoryId,
      snapshotId,
      revision,
      snapshotDigest,
      kind: artifact.kind,
      locator,
      contentDigest,
      observedAt: new Date(observedEpoch).toISOString(),
      payload: structuredClone(artifact.payload),
    }) as ArtifactPlan;
    return Object.freeze({ artifact: normalizedArtifact, canonicalPayload });
  });
  return validated.sort((left, right) =>
    compareCodeUnits(
      [
        left.artifact.repositoryId,
        left.artifact.snapshotId,
        left.artifact.id,
        left.artifact.kind,
        left.artifact.contentDigest,
      ].join("\0"),
      [
        right.artifact.repositoryId,
        right.artifact.snapshotId,
        right.artifact.id,
        right.artifact.kind,
        right.artifact.contentDigest,
      ].join("\0"),
    ),
  );
}

export function extractLegacyBehavior(
  input: LegacyBehaviorExtractionInput,
): LegacyBehaviorExtractionResult {
  if (!input?.policy || input.policy.enabled === false) {
    return Object.freeze({
      status: "disabled" as const,
      reason: "legacy_behavior_extraction_disabled" as const,
    });
  }
  const context = validateContext(input);
  const policy = validatePolicy(input.policy);
  const collectors = validateCollectors(input.collectors, policy);
  const artifacts = validateArtifacts(input, policy, context.tenantId);
  const executionPlan: Array<Readonly<{
    artifact: ArtifactPlan;
    canonicalPayload: string;
    collector: CollectorPlan;
  }>> = [];
  for (const { artifact, canonicalPayload } of artifacts) {
    const applicable = collectors.filter((collector) => collector.kinds.includes(artifact.kind));
    if (applicable.length === 0) fail("legacy_behavior_artifact_collector_required");
    for (const collector of applicable) {
      executionPlan.push(Object.freeze({ artifact, canonicalPayload, collector }));
      if (executionPlan.length > MAX_BSG_SOURCES) {
        fail("legacy_behavior_source_limit_exceeded");
      }
    }
  }
  const sources: BsgEvidenceSource[] = [];
  const collectorEvidenceRefs = new Set<string>();
  let assertionCount = 0;
  let relationCount = 0;

  for (const { artifact, canonicalPayload, collector } of executionPlan) {
    let output: ReturnType<LegacyBehaviorCollector["collect"]>;
    try {
      output = collector.collect(deepFreeze(structuredClone(artifact)));
    } catch (error) {
      fail("legacy_behavior_collector_failed", error);
    }
    if (!output || typeof output !== "object" || !Array.isArray(output.assertions) ||
      !Array.isArray(output.relations)) {
      fail("legacy_behavior_collector_output_invalid");
    }
    assertionCount += output.assertions.length;
    relationCount += output.relations.length;
    if (assertionCount > policy.maxAssertions) fail("legacy_behavior_assertion_limit_exceeded");
    if (relationCount > policy.maxRelations) fail("legacy_behavior_relation_limit_exceeded");
    const binding = {
      collector: { id: collector.id, version: collector.version, digest: collector.digest },
      artifact: {
        id: artifact.id,
        tenantId: artifact.tenantId,
        repositoryId: artifact.repositoryId,
        snapshotId: artifact.snapshotId,
        revision: artifact.revision,
        snapshotDigest: artifact.snapshotDigest,
        kind: artifact.kind,
        locator: artifact.locator,
        contentDigest: artifact.contentDigest,
        observedAt: artifact.observedAt,
        payloadDigest: sha256(canonicalPayload),
      },
    };
    const sourceDigest = sha256(canonicalJson(binding));
    sources.push({
      id: `legacy_${sourceDigest.slice("sha256:".length, "sha256:".length + 24)}`,
      kind: artifact.kind,
      tenantId: artifact.tenantId,
      repositoryId: artifact.repositoryId,
      snapshotId: artifact.snapshotId,
      revision: artifact.revision,
      snapshotDigest: artifact.snapshotDigest,
      contentDigest: artifact.contentDigest,
      observedAt: artifact.observedAt,
      assertions: [...output.assertions].map((assertion) => ({ ...assertion })),
      relations: [...output.relations].map((relation) => ({ ...relation })),
    });
    collectorEvidenceRefs.add(
      `collector://${encodeURIComponent(collector.id)}/${encodeURIComponent(collector.version)}/${collector.digest}`,
    );
  }

  const graph = extractBehavioralSpecGraph({
    ...context,
    sources,
  });
  return Object.freeze({
    status: "extracted" as const,
    graph,
    collectorEvidenceRefs: Object.freeze([...collectorEvidenceRefs].sort(compareCodeUnits)),
  });
}
