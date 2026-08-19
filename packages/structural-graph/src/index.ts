import { createHash } from "node:crypto";
import type { CallEdge, CallGraph, CallResolution, FunctionNode } from "@mendpoint/call-graph";

export type StructuralFailureCode =
  | "GRAPHIFY_EXTRACTION_FAILURE"
  | "GRAPHIFY_LANGUAGE_GAP"
  | "GRAPHIFY_EDGE_MISS"
  | "GRAPHIFY_FALSE_EDGE"
  | "GRAPHIFY_AMBIGUITY"
  | "GRAPHIFY_IDENTITY_INSTABILITY"
  | "GRAPHIFY_INCREMENTAL_DIFF_FAILURE"
  | "GRAPHIFY_PERFORMANCE_FAILURE"
  | "GRAPHIFY_SECURITY_FAILURE";
export type StructuralBlindSpotClass =
  | "STRUCTURAL_STATIC_GAP"
  | "SEMANTIC_RESOLUTION_REQUIRED"
  | "RUNTIME_EVIDENCE_REQUIRED";
export type StructuralFailureAttribution =
  | "structural_extractor"
  | "normalization"
  | "entity_resolution"
  | "provider_mapping"
  | "runtime_evidence"
  | "query"
  | "model";

export class StructuralExtractionError extends Error {
  readonly code: StructuralFailureCode;
  constructor(code: StructuralFailureCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "StructuralExtractionError";
    this.code = code;
  }
}

export function structuralFailure(code: StructuralFailureCode, detail: string): StructuralExtractionError {
  return new StructuralExtractionError(code, detail);
}

export function classifyStructuralBlindSpot(input: {
  supportedLanguage: boolean;
  structuralFactPresent: boolean;
  runtimeOnly: boolean;
}): StructuralBlindSpotClass {
  if (input.runtimeOnly) return "RUNTIME_EVIDENCE_REQUIRED";
  if (!input.supportedLanguage || !input.structuralFactPresent) return "STRUCTURAL_STATIC_GAP";
  return "SEMANTIC_RESOLUTION_REQUIRED";
}

export function attributeStructuralFailure(input: {
  extracted: boolean;
  normalized: boolean;
  entityResolved: boolean;
  providerMapped: boolean;
  runtimeOnly: boolean;
  queryIncluded: boolean;
  modelObserved: boolean;
}): StructuralFailureAttribution {
  if (!input.extracted) return "structural_extractor";
  if (!input.normalized) return "normalization";
  if (!input.entityResolved) return "entity_resolution";
  if (!input.providerMapped) return input.runtimeOnly ? "runtime_evidence" : "provider_mapping";
  if (!input.queryIncluded) return "query";
  return "model";
}

export type StructuralNodeKind =
  | "file"
  | "module"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "test"
  | "symbol"
  | "external_symbol";

export type StructuralEdgeKind =
  | "imports"
  | "calls"
  | "inherits"
  | "implements"
  | "references"
  | "contains"
  | "defines"
  | "tests"
  | "uses"
  | "re_exports"
  | "method";

export type StructuralEpistemicState = "observed" | "inferred" | "ambiguous";

export type StructuralExtractorIdentity = {
  id: string;
  version: string;
  digest: string;
};

export type StructuralProvenance = {
  engine: "graphify";
  extractorVersion: string;
  method: "tree-sitter";
  upstreamNodeId?: string;
  upstreamRelation?: string;
  upstreamConfidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  sourceFile: string;
  sourceLocation: string;
  repositorySnapshotId: string;
  observedAt: string;
};

export type StructuralNodeV1 = {
  id: string;
  canonicalKey: string;
  kind: StructuralNodeKind;
  label: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  lineStart: number;
  lineEnd: number;
  isTest: boolean;
  epistemicState: StructuralEpistemicState;
  provenance: StructuralProvenance;
};

export type StructuralEdgeV1 = {
  id: string;
  kind: StructuralEdgeKind;
  sourceId: string;
  targetId: string;
  sourceFile: string;
  lineStart: number;
  lineEnd: number;
  epistemicState: StructuralEpistemicState;
  confidence?: number;
  provenance: StructuralProvenance;
};

export type StructuralAmbiguityV1 = {
  kind: "edge" | "identity";
  subjectId: string;
  candidates: string[];
  reason: string;
};

export type StructuralWarningV1 = {
  code: StructuralFailureCode;
  detail: string;
  sourceFile?: string;
};

export type StructuralExtractionMetricsV1 = {
  elapsedMs: number;
  normalizationMs: number;
  peakMemoryBytes: number;
  nodeCount: number;
  edgeCount: number;
  languageCount: number;
  confidenceDistribution: { observed: number; inferred: number; ambiguous: number };
};

export type StructuralExtractionV1 = {
  schemaVersion: "mendpoint.structural-extraction.v1";
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  observedAt: string;
  extractor: StructuralExtractorIdentity;
  languages: string[];
  nodes: StructuralNodeV1[];
  edges: StructuralEdgeV1[];
  ambiguities: StructuralAmbiguityV1[];
  warnings: StructuralWarningV1[];
  metrics: StructuralExtractionMetricsV1;
  contentDigest: string;
};

export type StructuralSnapshotFileV1 = {
  path: string;
  contentDigest: string;
  byteLength: number;
  mode: string;
  kind: "file";
};

export type StructuralExtractionRequest = {
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  manifestDigest: string;
  verifiedSnapshotRoot: string;
  observedAt: string;
  files: StructuralSnapshotFileV1[];
  limits: {
    maxFiles: number;
    maxInputBytes: number;
    maxNodes: number;
    maxEdges: number;
    maxOutputBytes: number;
    maxMemoryBytes: number;
    timeoutMs: number;
  };
};

type GraphifyProcessRequest = Pick<StructuralExtractionRequest,
  "verifiedSnapshotRoot" | "snapshotId" | "revision" | "manifestDigest" | "files" | "limits"
>;
type GraphifyProcessResult = {
  output: unknown;
  observedFiles: StructuralSnapshotFileV1[];
  peakMemoryBytes: number;
};
type GraphifyProcessOperation = {
  result: Promise<GraphifyProcessResult>;
  terminate(): Promise<void>;
};
export type GraphifyProcessPort = {
  version: string;
  digest: string;
  start(input: GraphifyProcessRequest): GraphifyProcessOperation;
};

type GraphifyMetadata = {
  version: string;
  digest: string;
  elapsedMs: number;
  peakMemoryBytes: number;
  observedFiles: StructuralSnapshotFileV1[];
};

export type StructuralGraphExtractor<T = StructuralExtractionV1> = {
  readonly descriptor: { id: string; version: string; implementationDigest: `sha256:${string}` };
  extract(request: StructuralExtractionRequest): Promise<T>;
};

type RawGraphifyNode = {
  id: string;
  label: string;
  file_type?: string;
  source_file: string;
  source_location?: string;
  confidence?: string;
};

type RawGraphifyEdge = {
  source: string;
  target: string;
  relation: string;
  confidence?: string;
  source_file?: string;
  source_location?: string;
  weight?: number;
};

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const REVISION_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EXACT_CONFIDENCE = new Set(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);
const compareCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      output[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

const canonicalJson = (value: unknown) => JSON.stringify(canonicalValue(value));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function boundedText(value: unknown, code: StructuralFailureCode, label: string, max = 1_024): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw structuralFailure(code, `${label} is invalid`);
  }
  return value;
}

function exactUtc(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "observedAt must be canonical UTC");
  }
}

function normalizePath(value: unknown): string {
  const input = boundedText(value, "GRAPHIFY_SECURITY_FAILURE", "source path", 2_048).replace(/\\/gu, "/");
  if (input.startsWith("/") || /^[A-Za-z]:\//u.test(input) || input.split("/").some((part) => part === ".." || part === "")) {
    throw structuralFailure("GRAPHIFY_SECURITY_FAILURE", "source path escapes the repository root");
  }
  return input.startsWith("./") ? input.slice(2) : input;
}

function sourceLines(value: unknown): { lineStart: number; lineEnd: number; text: string } {
  if (value === undefined || value === null || value === "") return { lineStart: 1, lineEnd: 1, text: "L1" };
  if (typeof value !== "string" || value.length > 128) throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "source location is invalid");
  const match = /^L(\d+)(?:-L?(\d+))?$/u.exec(value);
  if (!match) throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "source location is not an exact line range");
  const lineStart = Number(match[1]);
  const lineEnd = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart || lineEnd > 10_000_000) {
    throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "source location is out of bounds");
  }
  return { lineStart, lineEnd, text: `L${lineStart}${lineEnd === lineStart ? "" : `-L${lineEnd}`}` };
}

function epistemic(value: unknown): { upstream: "EXTRACTED" | "INFERRED" | "AMBIGUOUS"; state: StructuralEpistemicState } {
  const confidence = value ?? "EXTRACTED";
  if (typeof confidence !== "string" || !EXACT_CONFIDENCE.has(confidence)) {
    throw structuralFailure("GRAPHIFY_AMBIGUITY", "upstream confidence is unsupported");
  }
  const upstream = confidence as "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  return { upstream, state: upstream === "EXTRACTED" ? "observed" : upstream === "INFERRED" ? "inferred" : "ambiguous" };
}

const extensionLanguage = (path: string): string => {
  const extension = path.toLowerCase().split(".").at(-1) ?? "";
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", java: "java", go: "go", rb: "ruby", rs: "rust", cs: "csharp", kt: "kotlin", php: "php", swift: "swift" } as Record<string, string>)[extension] ?? "other";
};

function nodeKind(raw: RawGraphifyNode): StructuralNodeKind {
  const type = String(raw.file_type ?? "").toLowerCase();
  const path = raw.source_file.toLowerCase();
  if (type === "file" || /\.[a-z0-9]+$/u.test(raw.label) && raw.source_location === "L1") return "file";
  if (type.includes("test") || /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./u.test(path)) return "test";
  if (type.includes("method") || raw.label.startsWith(".")) return "method";
  if (type.includes("function")) return "function";
  if (type.includes("class")) return "class";
  if (type.includes("interface")) return "interface";
  if (type.includes("module") || type === "package") return "module";
  if (type.includes("external")) return "external_symbol";
  return "symbol";
}

function edgeKind(value: unknown): StructuralEdgeKind {
  const relation = boundedText(value, "GRAPHIFY_AMBIGUITY", "edge relation", 128).toLowerCase();
  const aliases: Record<string, StructuralEdgeKind> = {
    import: "imports", imports: "imports", imports_from: "imports",
    call: "calls", calls: "calls", indirect_call: "calls",
    inherit: "inherits", inherits: "inherits", extends: "inherits",
    implement: "implements", implements: "implements",
    reference: "references", referenced: "references", references: "references",
    contain: "contains", contains: "contains",
    define: "defines", defines: "defines",
    test: "tests", tests: "tests", covers: "tests",
    use: "uses", uses: "uses",
    re_export: "re_exports", re_exports: "re_exports",
    method: "method",
  };
  const mapped = aliases[relation];
  if (!mapped) throw structuralFailure("GRAPHIFY_AMBIGUITY", `unsupported upstream relation ${relation}`);
  return mapped;
}

function validateRequest(input: StructuralExtractionRequest): void {
  boundedText(input.tenantId, "GRAPHIFY_IDENTITY_INSTABILITY", "tenantId", 256);
  boundedText(input.repositoryId, "GRAPHIFY_IDENTITY_INSTABILITY", "repositoryId", 256);
  boundedText(input.snapshotId, "GRAPHIFY_IDENTITY_INSTABILITY", "snapshotId", 256);
  if (!REVISION_RE.test(input.revision)) throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "repository revision is invalid");
  if (!DIGEST_RE.test(input.manifestDigest)) throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "manifest digest is invalid");
  boundedText(input.verifiedSnapshotRoot, "GRAPHIFY_SECURITY_FAILURE", "verifiedSnapshotRoot", 2_048);
  exactUtc(input.observedAt);
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > input.limits.maxFiles) {
    throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "file count exceeds the extraction plan");
  }
  const normalized = input.files.map((entry) => {
    if (!entry || typeof entry !== "object" || entry.kind !== "file" || !DIGEST_RE.test(entry.contentDigest) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength > input.limits.maxInputBytes || !/^[0-7]{6}$/u.test(entry.mode)) {
      throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "snapshot file binding is invalid");
    }
    return normalizePath(entry.path);
  });
  if (new Set(normalized).size !== normalized.length) throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "file list contains aliases or duplicates");
  const inputBytes = input.files.reduce((total, entry) => total + entry.byteLength, 0);
  if (inputBytes > input.limits.maxInputBytes) throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "snapshot exceeds the input byte limit");
  if (structuralSnapshotManifestDigest(input.files) !== input.manifestDigest) throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "manifest digest does not match file bindings");
  const { maxFiles, maxInputBytes, maxNodes, maxEdges, maxOutputBytes, maxMemoryBytes, timeoutMs } = input.limits;
  if (![maxFiles, maxInputBytes, maxNodes, maxEdges, maxOutputBytes, maxMemoryBytes, timeoutMs].every(Number.isSafeInteger) || maxFiles < 1 || maxFiles > 100_000 || maxInputBytes < 1 || maxInputBytes > 10_000_000_000 || maxNodes < 1 || maxNodes > 2_000_000 || maxEdges < 0 || maxEdges > 8_000_000 || maxOutputBytes < 1 || maxOutputBytes > 2_000_000_000 || maxMemoryBytes < 1 || maxMemoryBytes > 16_000_000_000 || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "extraction limits are invalid");
  }
}

export function structuralSnapshotManifestDigest(files: readonly StructuralSnapshotFileV1[]): string {
  const normalized = [...files]
    .map((entry) => {
      if (!entry || typeof entry !== "object" || entry.kind !== "file" || !DIGEST_RE.test(entry.contentDigest) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength > 10_000_000_000 || !/^[0-7]{6}$/u.test(entry.mode)) {
        throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "snapshot file binding is invalid");
      }
      return { path: normalizePath(entry.path), contentDigest: entry.contentDigest, byteLength: entry.byteLength, mode: entry.mode, kind: entry.kind };
    })
    .sort((a, b) => compareCodeUnits(a.path, b.path));
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "file list contains aliases or duplicates");
  }
  return sha256(canonicalJson(normalized));
}

export function structuralContentDigest(input: Omit<StructuralExtractionV1, "contentDigest"> | StructuralExtractionV1): string {
  const copy = structuredClone(input) as Partial<StructuralExtractionV1>;
  delete copy.contentDigest;
  delete copy.observedAt;
  delete copy.metrics;
  for (const node of copy.nodes ?? []) delete (node.provenance as Partial<StructuralProvenance>).observedAt;
  for (const edge of copy.edges ?? []) delete (edge.provenance as Partial<StructuralProvenance>).observedAt;
  return sha256(canonicalJson(copy));
}

export function normalizeGraphifyExtraction(
  request: StructuralExtractionRequest,
  value: unknown,
  metadata: GraphifyMetadata,
): StructuralExtractionV1 {
  const started = performance.now();
  validateRequest(request);
  if (!DIGEST_RE.test(metadata.digest) || metadata.version !== "0.9.46") {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "unapproved Graphify extractor identity");
  }
  if (!Number.isSafeInteger(metadata.peakMemoryBytes) || metadata.peakMemoryBytes < 0 || metadata.peakMemoryBytes > request.limits.maxMemoryBytes) {
    throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify process exceeded its memory ceiling");
  }
  if (!Array.isArray(metadata.observedFiles) || structuralSnapshotManifestDigest(metadata.observedFiles) !== request.manifestDigest) {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "Graphify observed different snapshot bytes than the extraction authority");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "output is not an object");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > request.limits.maxOutputBytes) throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify output exceeds its byte ceiling");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "nodes and edges must be arrays");
  if (raw.nodes.length > request.limits.maxNodes || raw.edges.length > request.limits.maxEdges) throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "output exceeds bounded graph size");
  if (Array.isArray(raw.failed_sources) && raw.failed_sources.length > 0) throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "one or more source files were only partially extracted");
  if (Array.isArray(raw.unsupported_languages) && raw.unsupported_languages.length > 0) throw structuralFailure("GRAPHIFY_LANGUAGE_GAP", "one or more repository languages are unsupported");

  const upstreamIds = new Set<string>();
  const canonicalKeys = new Set<string>();
  const upstreamToNode = new Map<string, StructuralNodeV1>();
  const allowedPaths = new Set(request.files.map((entry) => normalizePath(entry.path)));
  const nodes = raw.nodes.map((candidate): StructuralNodeV1 => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "node shape is invalid");
    const item = candidate as Partial<RawGraphifyNode>;
    const upstreamNodeId = boundedText(item.id, "GRAPHIFY_IDENTITY_INSTABILITY", "upstream node id");
    if (upstreamIds.has(upstreamNodeId)) throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "upstream node id is duplicated");
    upstreamIds.add(upstreamNodeId);
    const label = boundedText(item.label, "GRAPHIFY_EXTRACTION_FAILURE", "node label");
    const filePath = normalizePath(item.source_file);
    if (!allowedPaths.has(filePath)) throw structuralFailure("GRAPHIFY_SECURITY_FAILURE", "node cites a file outside the verified manifest");
    const kind = nodeKind(item as RawGraphifyNode);
    const location = sourceLines(item.source_location);
    const confidence = epistemic(item.confidence);
    const qualifiedName = label.startsWith(".") ? label.slice(1).replace(/\(\)$/u, "") : label.replace(/\(\)$/u, "");
    const canonicalKey = `${filePath}::${kind}::${qualifiedName}`;
    if (canonicalKeys.has(canonicalKey)) throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "multiple upstream nodes collapse to one canonical identity");
    canonicalKeys.add(canonicalKey);
    const node: StructuralNodeV1 = {
      id: sha256(`${request.tenantId}\0${request.repositoryId}\0${request.snapshotId}\0${canonicalKey}`),
      canonicalKey,
      kind,
      label,
      qualifiedName,
      filePath,
      language: extensionLanguage(filePath),
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      isTest: kind === "test" || /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./u.test(filePath.toLowerCase()),
      epistemicState: confidence.state,
      provenance: {
        engine: "graphify", extractorVersion: metadata.version, method: "tree-sitter",
        upstreamNodeId, upstreamConfidence: confidence.upstream,
        sourceFile: filePath, sourceLocation: location.text,
        repositorySnapshotId: request.snapshotId, observedAt: request.observedAt,
      },
    };
    upstreamToNode.set(upstreamNodeId, node);
    return node;
  }).sort((a, b) => compareCodeUnits(a.canonicalKey, b.canonicalKey));

  const edgeIds = new Set<string>();
  const edges = raw.edges.map((candidate): StructuralEdgeV1 => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "edge shape is invalid");
    const item = candidate as Partial<RawGraphifyEdge>;
    const source = upstreamToNode.get(boundedText(item.source, "GRAPHIFY_EDGE_MISS", "edge source"));
    const target = upstreamToNode.get(boundedText(item.target, "GRAPHIFY_EDGE_MISS", "edge target"));
    if (!source || !target) throw structuralFailure("GRAPHIFY_EDGE_MISS", "edge endpoint is absent from the extraction");
    const kind = edgeKind(item.relation);
    const confidence = epistemic(item.confidence);
    const sourceFile = item.source_file === undefined ? source.filePath : normalizePath(item.source_file);
    if (!allowedPaths.has(sourceFile)) throw structuralFailure("GRAPHIFY_SECURITY_FAILURE", "edge cites a file outside the verified manifest");
    const location = sourceLines(item.source_location);
    const edgeKey = `${kind}\0${source.id}\0${target.id}\0${sourceFile}\0${location.lineStart}`;
    const id = sha256(`${request.snapshotId}\0${edgeKey}`);
    if (edgeIds.has(id)) throw structuralFailure("GRAPHIFY_FALSE_EDGE", "duplicate structural edge");
    edgeIds.add(id);
    if (item.weight !== undefined && (typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight < 0 || item.weight > 1)) {
      throw structuralFailure("GRAPHIFY_AMBIGUITY", "edge confidence score is invalid");
    }
    return {
      id, kind, sourceId: source.id, targetId: target.id,
      sourceFile, lineStart: location.lineStart, lineEnd: location.lineEnd,
      epistemicState: confidence.state,
      ...(item.weight === undefined ? {} : { confidence: item.weight }),
      provenance: {
        engine: "graphify", extractorVersion: metadata.version, method: "tree-sitter",
        upstreamRelation: String(item.relation), upstreamConfidence: confidence.upstream,
        sourceFile, sourceLocation: location.text,
        repositorySnapshotId: request.snapshotId, observedAt: request.observedAt,
      },
    };
  }).sort((a, b) => compareCodeUnits(`${a.kind}\0${a.sourceId}\0${a.targetId}\0${a.id}`, `${b.kind}\0${b.sourceId}\0${b.targetId}\0${b.id}`));

  const languages = Array.from(new Set(nodes.map((node) => node.language))).sort(compareCodeUnits);
  const warnings: StructuralWarningV1[] = (Array.isArray(raw.warnings) ? raw.warnings : [])
    .map((item) => ({ code: "GRAPHIFY_AMBIGUITY" as const, detail: boundedText(item, "GRAPHIFY_EXTRACTION_FAILURE", "warning", 2_048) }))
    .sort((a, b) => compareCodeUnits(a.detail, b.detail));
  const ambiguities = edges.filter((edge) => edge.epistemicState === "ambiguous").map((edge) => ({
    kind: "edge" as const,
    subjectId: edge.id,
    candidates: [edge.sourceId, edge.targetId].sort(compareCodeUnits),
    reason: `graphify:${edge.provenance.upstreamRelation}:AMBIGUOUS`,
  }));
  const distribution = { observed: 0, inferred: 0, ambiguous: 0 };
  for (const item of [...nodes, ...edges]) distribution[item.epistemicState] += 1;
  const extractionWithoutDigest: Omit<StructuralExtractionV1, "contentDigest"> = {
    schemaVersion: "mendpoint.structural-extraction.v1",
    tenantId: request.tenantId,
    repositoryId: request.repositoryId,
    snapshotId: request.snapshotId,
    revision: request.revision,
    observedAt: request.observedAt,
    extractor: { id: "graphify", version: metadata.version, digest: metadata.digest },
    languages,
    nodes,
    edges,
    ambiguities,
    warnings,
    metrics: {
      elapsedMs: metadata.elapsedMs,
      normalizationMs: Math.max(0, Math.round((performance.now() - started) * 1_000) / 1_000),
      peakMemoryBytes: metadata.peakMemoryBytes,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      languageCount: languages.length,
      confidenceDistribution: distribution,
    },
  };
  return deepFreeze({ ...extractionWithoutDigest, contentDigest: structuralContentDigest(extractionWithoutDigest) });
}

export class GraphifyStructuralExtractor {
  readonly descriptor: StructuralGraphExtractor["descriptor"];
  readonly #start: GraphifyProcessPort["start"];
  readonly #version: string;
  readonly #digest: string;

  constructor(port: GraphifyProcessPort) {
    const version = port.version;
    const digest = port.digest;
    const start = port.start;
    if (version !== "0.9.46" || !DIGEST_RE.test(digest) || typeof start !== "function") {
      throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "unapproved Graphify process port");
    }
    this.#start = start.bind(port);
    this.#version = version;
    this.#digest = digest;
    this.descriptor = Object.freeze({ id: "graphify", version, implementationDigest: digest as `sha256:${string}` });
  }

  async extract(request: StructuralExtractionRequest): Promise<StructuralExtractionV1> {
    const plan = structuredClone(request);
    validateRequest(plan);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    const operation = this.#start({
      verifiedSnapshotRoot: plan.verifiedSnapshotRoot,
      snapshotId: plan.snapshotId,
      revision: plan.revision,
      manifestDigest: plan.manifestDigest,
      files: structuredClone(plan.files),
      limits: { ...plan.limits },
    });
    operation.result.catch(() => undefined);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void operation.terminate().catch(() => undefined);
        reject(structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify extraction timed out"));
      }, plan.limits.timeoutMs);
    });
    let completed: GraphifyProcessResult;
    try {
      completed = await Promise.race([operation.result, timeout]);
    } catch (error) {
      if (error instanceof StructuralExtractionError) throw error;
      throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", error instanceof Error ? error.message : "Graphify library failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
    return normalizeGraphifyExtraction(plan, completed.output, {
      version: this.#version,
      digest: this.#digest,
      elapsedMs: Math.max(0, Math.round((performance.now() - started) * 1_000) / 1_000),
      peakMemoryBytes: completed.peakMemoryBytes,
      observedFiles: completed.observedFiles,
    });
  }
}

export async function extractWithFallback<T>(input: {
  enabled: boolean;
  request: StructuralExtractionRequest;
  current: StructuralGraphExtractor<T>;
  graphify: StructuralGraphExtractor<T>;
}): Promise<T> {
  const enabled = input.enabled;
  const request = structuredClone(input.request);
  const current = input.current;
  const graphify = input.graphify;
  const currentExtract = current.extract.bind(current);
  const graphifyExtract = graphify.extract.bind(graphify);
  if (!enabled) return currentExtract(request);
  try {
    return await graphifyExtract(request);
  } catch (error) {
    if (!(error instanceof StructuralExtractionError)) throw error;
    return currentExtract(request);
  }
}

export type StructuralExtractionDiffV1 = {
  fromSnapshotId: string;
  toSnapshotId: string;
  addedCanonicalKeys: string[];
  removedCanonicalKeys: string[];
  changedCanonicalKeys: string[];
  invalidatedCanonicalKeys: string[];
};

export function diffStructuralExtractions(before: StructuralExtractionV1, after: StructuralExtractionV1): StructuralExtractionDiffV1 {
  if (before.tenantId !== after.tenantId || before.repositoryId !== after.repositoryId || before.snapshotId === after.snapshotId) {
    throw structuralFailure("GRAPHIFY_INCREMENTAL_DIFF_FAILURE", "incremental inputs are not two versions of one tenant repository");
  }
  const beforeByKey = new Map(before.nodes.map((node) => [node.canonicalKey, node]));
  const afterByKey = new Map(after.nodes.map((node) => [node.canonicalKey, node]));
  const addedCanonicalKeys = [...afterByKey.keys()].filter((key) => !beforeByKey.has(key)).sort(compareCodeUnits);
  const removedCanonicalKeys = [...beforeByKey.keys()].filter((key) => !afterByKey.has(key)).sort(compareCodeUnits);
  const changedCanonicalKeys = [...beforeByKey.keys()].filter((key) => {
    const prior = beforeByKey.get(key)!;
    const next = afterByKey.get(key);
    if (!next) return false;
    const shape = (node: StructuralNodeV1) => canonicalJson({ kind: node.kind, label: node.label, filePath: node.filePath, lineStart: node.lineStart, lineEnd: node.lineEnd, epistemicState: node.epistemicState });
    return shape(prior) !== shape(next);
  }).sort(compareCodeUnits);
  const beforeKeyById = new Map(before.nodes.map((node) => [node.id, node.canonicalKey]));
  const afterKeyById = new Map(after.nodes.map((node) => [node.id, node.canonicalKey]));
  const edgeSignature = (edge: StructuralEdgeV1, keys: Map<string, string>) => `${edge.kind}\0${keys.get(edge.sourceId)}\0${keys.get(edge.targetId)}\0${edge.sourceFile}\0${edge.lineStart}`;
  const afterEdges = new Set(after.edges.map((edge) => edgeSignature(edge, afterKeyById)));
  const invalidated = new Set<string>([...removedCanonicalKeys, ...changedCanonicalKeys]);
  for (const edge of before.edges) {
    if (!afterEdges.has(edgeSignature(edge, beforeKeyById))) {
      const source = beforeKeyById.get(edge.sourceId);
      const target = beforeKeyById.get(edge.targetId);
      if (source) invalidated.add(source);
      if (target) invalidated.add(target);
    }
  }
  return deepFreeze({
    fromSnapshotId: before.snapshotId,
    toSnapshotId: after.snapshotId,
    addedCanonicalKeys,
    removedCanonicalKeys,
    changedCanonicalKeys,
    invalidatedCanonicalKeys: [...invalidated].sort(compareCodeUnits),
  });
}

/**
 * Projects accepted structural facts into the existing call-graph seam. The
 * projection is not persistence: the immutable structural extraction and the
 * graph-learn publication remain the evidence authorities.
 */
export function structuralExtractionToCallGraph(extraction: StructuralExtractionV1): CallGraph {
  if (structuralContentDigest(extraction) !== extraction.contentDigest) {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "structural extraction digest is invalid");
  }
  const source = {
    extractor: { id: extraction.extractor.id, version: extraction.extractor.version, digest: extraction.extractor.digest },
    evidenceRefs: [`structural-extraction:${extraction.contentDigest}`],
  };
  const nodes: Record<string, FunctionNode> = Object.create(null) as Record<string, FunctionNode>;
  const acceptedKinds = new Set<StructuralNodeKind>(["function", "method", "test"]);
  for (const item of extraction.nodes) {
    if (!acceptedKinds.has(item.kind)) continue;
    nodes[item.id] = {
      id: item.id,
      qualifiedName: `${item.filePath}:${item.qualifiedName}`,
      name: item.qualifiedName,
      filePath: item.filePath,
      lineStart: item.lineStart,
      lineEnd: item.lineEnd,
      language: (["typescript", "javascript", "python", "go", "java"] as string[]).includes(item.language)
        ? item.language as FunctionNode["language"] : "other",
      isExternalApi: false,
      isTest: item.isTest,
      structuralSource: { ...source, evidenceRefs: [...source.evidenceRefs, `structural-node:${item.id}`] },
    };
  }
  const edges: CallEdge[] = extraction.edges
    .filter((edge) => edge.kind === "calls" && nodes[edge.sourceId] && nodes[edge.targetId])
    .map((edge) => {
      const resolution: CallResolution = edge.epistemicState === "observed" ? "direct" : edge.epistemicState === "inferred" ? "import_context" : "virtual_approx";
      return {
        id: edge.id,
        callerId: edge.sourceId,
        calleeId: edge.targetId,
        callSiteFile: edge.sourceFile,
        callSiteLine: edge.lineStart,
        resolution,
        confidence: edge.epistemicState === "observed" ? "high" : edge.epistemicState === "inferred" ? "medium" : "low",
        virtual: edge.epistemicState === "ambiguous",
        structuralSource: { ...source, evidenceRefs: [...source.evidenceRefs, `structural-edge:${edge.id}`] },
      };
    });
  const outEdges: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const inEdges: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const byName: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const node of Object.values(nodes)) {
    outEdges[node.id] = [];
    inEdges[node.id] = [];
    (byName[node.name] ??= []).push(node.id);
  }
  for (const edge of edges) {
    outEdges[edge.callerId].push(edge.id);
    inEdges[edge.calleeId].push(edge.id);
  }
  for (const values of Object.values(byName)) values.sort(compareCodeUnits);
  return deepFreeze({
    repoRoot: `snapshot:${extraction.snapshotId}`,
    builtAt: extraction.observedAt,
    algorithm: "hybrid",
    nodes,
    edges,
    outEdges,
    inEdges,
    byName,
    hierarchy: { parentsOf: Object.create(null) as Record<string, string[]>, instantiated: [], methodsOfType: Object.create(null) as Record<string, string[]> },
    stats: {
      nodeCount: Object.keys(nodes).length,
      edgeCount: edges.length,
      directEdges: edges.filter((edge) => edge.resolution === "direct").length,
      approxEdges: edges.filter((edge) => edge.resolution !== "direct").length,
    },
    diagnostics: { skippedDirectories: [], supportedLanguages: extraction.languages, unsupportedLanguageFiles: [] },
  });
}
