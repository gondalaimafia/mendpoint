import type {
  ChangeRisk,
  DiffEntry,
  DiffOp,
  ImpactableSurface,
  StructuralDiff,
} from "@mendpoint/shared";
import { newId } from "@mendpoint/shared";
import {
  SchemaResolver,
  buildResolutionReport,
  schemaDeepEqual,
  type SpecResolutionReport,
} from "./spec-ref.js";

export {
  MAX_REF_DEPTH,
  SchemaResolver,
  buildResolutionReport,
  schemaDeepEqual,
  type FlattenedSchema,
  type SpecRefIssue,
  type SpecRefIssueKind,
  type SpecResolutionReport,
} from "./spec-ref.js";

export {
  canonicalChangeSourceContentHash,
  confirmCustomerIncident,
  createChangeSourceArtifact,
  escalateCustomerIncident,
  getChangeSourceArtifact,
  listChangeSourceEvents,
  listChangeSourceRevisions,
  openChangeSourceStore,
  requireApprovedChangeSourceForFanout,
  reviewChangeSourceArtifact,
  verifyChangeSourceEventIntegrity,
  type ChangeSourceArtifact,
  type ChangeSourceEvent,
  type ChangeSourceEvidence,
  type ChangeSourceInput,
  type ChangeSourceKind,
  type ChangeSourceProvenance,
  type ChangeSourceReviewerOverride,
  type ChangeSourceReviewState,
  type ChangeSourceRevision,
  type ChangeSourceStore,
  type CustomerIncidentInput,
  type IncidentConfirmationState,
  type ManualProviderAnnouncementInput,
} from "./change-source-store.js";

export {
  CHANGE_TAXONOMY_KINDS,
  CHANGE_TAXONOMY_VERSION,
  createUnifiedSourceArtifact,
  getMonitorHealth,
  getUnifiedSourceArtifact,
  listUnifiedSourceArtifacts,
  normalizeOpenApiSourceInput,
  openUnifiedChangeEvidenceStore,
  recordMonitorObservation,
  registerMonitorSchedule,
  taxonomySignalsFromOpenApi,
  type ChangeTaxonomyKind,
  type MonitorHealth,
  type MonitorObservation,
  type MonitorSchedule,
  type TaxonomySignal,
  type UnifiedChangeEvidenceStore,
  type UnifiedChangeSourceKind,
  type UnifiedSourceArtifact,
  type UnifiedSourceInput,
} from "./unified-change-evidence.js";

export {
  buildCapabilityOpportunity,
  detectNewCapabilities,
  prioritizeCapabilityOpportunities,
  type CapabilityAdoptionOpportunity,
  type CapabilityConsumerRef,
  type CapabilityOpportunityOptions,
  type ConsumerCapabilityAdoption,
  type NewCapability,
} from "./capability-adoption.js";

export {
  GraphQLSchemaError,
  diffGraphQLSchemas,
  normalizeGraphQLSchema,
  type CanonicalGraphQLArgument,
  type CanonicalGraphQLDefinition,
  type CanonicalGraphQLField,
  type CanonicalGraphQLSchema,
  type GraphQLChangeClassification,
  type GraphQLDefinitionKind,
  type GraphQLSchemaChange,
  type GraphQLSchemaDiff,
  type GraphQLSchemaErrorCode,
  type GraphQLSchemaLimits,
  type GraphQLSchemaSourceFormat,
  type GraphQLSourceLocation,
} from "./graphql-schema.js";

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function getPaths(spec: Json): Json {
  return asObj(spec.paths);
}

function getMethods(pathItem: unknown): Json {
  const obj = asObj(pathItem);
  const methods: Json = {};
  for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
    if (obj[m]) methods[m] = obj[m];
  }
  return methods;
}

/**
 * Pick the representative schema out of an OpenAPI `content` map. Real specs do
 * not all speak `application/json`: Stripe, for one, models request bodies as
 * `application/x-www-form-urlencoded`. Prefer JSON for determinism, then the
 * common form encodings, then whatever media type is present, so field-level
 * changes are seen regardless of the wire format.
 */
function pickContentSchema(content: Json): unknown {
  const preferred = [
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
  ];
  for (const media of preferred) {
    const schema = asObj(content[media]).schema;
    if (schema !== undefined) return schema;
  }
  for (const media of Object.keys(content)) {
    const schema = asObj(content[media]).schema;
    if (schema !== undefined) return schema;
  }
  return undefined;
}

/**
 * The schema behind an operation's request body. The `requestBody` wrapper may
 * itself be a `$ref` (`#/components/requestBodies/...`), so it is dereferenced
 * before descending into `content`. The returned schema may still be a `$ref`
 * or a composition; the resolver flattens that when properties are read.
 */
function requestBodySchema(operation: unknown, resolver: SchemaResolver): unknown {
  const op = asObj(operation);
  const rb = asObj(resolver.deref(op.requestBody));
  const schema = pickContentSchema(asObj(rb.content));
  return schema ?? op.requestBody;
}

/** The success response schema for an operation, dereferencing the response wrapper. */
function responseSchema(operation: unknown, resolver: SchemaResolver): unknown {
  const op = asObj(operation);
  const responses = asObj(op.responses);
  const success =
    responses["200"] ?? responses["201"] ?? responses["default"] ?? {};
  return pickContentSchema(asObj(asObj(resolver.deref(success)).content));
}

function fieldType(schema: unknown): string | undefined {
  const t = asObj(schema).type;
  return typeof t === "string" ? t : undefined;
}

/** Same primitive JSON type, or lenient when either side omits `type`. */
function typeCompatible(a: unknown, b: unknown): boolean {
  const ta = fieldType(a);
  const tb = fieldType(b);
  if (ta === undefined || tb === undefined) return true;
  return ta === tb;
}

/** Both fields carry the same non-empty `example` value. */
function sharedExample(a: unknown, b: unknown): boolean {
  const ea = asObj(a).example;
  const eb = asObj(b).example;
  if (ea === undefined || eb === undefined) return false;
  return schemaDeepEqual(ea, eb);
}

/**
 * Whether an added field is a plausible successor of a removed field. Broader
 * than a confident rename on purpose: it is the predicate that *counts*
 * successors, so it must catch every candidate a human would consider. Names
 * that are lexically close, schemas that are structurally identical, or
 * type-compatible fields that carry the same example value all qualify — a
 * copied example strongly implies the same underlying field even when names and
 * descriptions diverge.
 */
function isPlausibleSuccessor(
  from: string,
  fromSchema: unknown,
  to: string,
  toSchema: unknown,
): boolean {
  const lexical =
    from.includes(to) ||
    to.includes(from) ||
    from.replace(/_cents$/, "") === to ||
    to.replace(/_cents$/, "") === from ||
    levenshtein(from, to) <= 3;
  if (lexical) return true;
  if (schemaDeepEqual(fromSchema, toSchema)) return true;
  if (typeCompatible(fromSchema, toSchema) && sharedExample(fromSchema, toSchema)) {
    return true;
  }
  return false;
}

export interface FieldRename {
  from: string;
  to: string;
}
export interface FieldAmbiguity {
  from: string;
  candidates: string[];
}

/**
 * Pair removed fields with added ones. A removed field with exactly one
 * plausible successor is a confident rename. A removed field with two or more
 * plausible successors is ambiguous: the tool must not guess which one it
 * became — it splits (e.g. `source` -> `payment_method` OR `payment_source`
 * chosen at runtime), so those fields are reported for a human to resolve and
 * are never turned into a rename.
 */
function detectFieldChanges(
  oldProps: Map<string, Json>,
  newProps: Map<string, Json>,
): { renames: FieldRename[]; ambiguities: FieldAmbiguity[] } {
  const removed = [...oldProps.keys()].filter((k) => !newProps.has(k));
  const added = [...newProps.keys()].filter((k) => !oldProps.has(k));
  const renames: FieldRename[] = [];
  const ambiguities: FieldAmbiguity[] = [];
  const usedTo = new Set<string>();
  for (const from of removed) {
    const candidates = added.filter(
      (to) =>
        !usedTo.has(to) &&
        isPlausibleSuccessor(from, oldProps.get(from), to, newProps.get(to)),
    );
    if (candidates.length === 1) {
      renames.push({ from, to: candidates[0]! });
      usedTo.add(candidates[0]!);
    } else if (candidates.length > 1) {
      ambiguities.push({ from, candidates });
    }
  }
  return { renames, ambiguities };
}

function levenshtein(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

export function classifyRisk(entries: DiffEntry[]): ChangeRisk {
  if (entries.some((e) => e.breaking)) return "breaking";
  if (
    entries.every(
      (e) =>
        e.op === "path_added" ||
        e.op === "method_added" ||
        e.op === "response_field_added",
    ) &&
    entries.length > 0
  ) {
    return "new_capability";
  }
  if (entries.length === 0) return "non_breaking";
  return "non_breaking";
}

export function summarizeChange(
  entries: DiffEntry[],
  risk: ChangeRisk,
  resolution?: SpecResolutionReport,
): string {
  const note = resolutionNote(resolution);
  if (entries.length === 0) {
    return `No structural API changes detected.${note}`;
  }
  const parts: string[] = [];
  const removed = entries.filter((e) => e.op === "path_removed" || e.op === "method_removed");
  const ambiguous = entries.filter(
    (e) => e.op === "request_field_ambiguous" || e.op === "response_field_ambiguous",
  );
  const renames = entries.filter((e) => e.op === "request_field_renamed");
  const required = entries.filter((e) => e.op === "request_field_added_required");
  const optionalFields = entries.filter((e) => e.op === "request_field_added");
  const added = entries.filter((e) => e.op === "path_added" || e.op === "method_added");
  if (ambiguous.length) {
    parts.push(
      ambiguous
        .map(
          (a) =>
            `ambiguous field ${a.fromField} on ${a.method?.toUpperCase()} ${a.path} (candidates: ${(a.candidates ?? []).join(", ")}; human decision required)`,
        )
        .join("; "),
    );
  }
  if (renames.length) {
    parts.push(
      renames
        .map((r) => `renamed request field ${r.fromField} → ${r.toField} on ${r.method?.toUpperCase()} ${r.path}`)
        .join("; "),
    );
  }
  if (removed.length) {
    parts.push(
      removed
        .map((r) => `removed ${r.method ? r.method.toUpperCase() + " " : ""}${r.path}`)
        .join("; "),
    );
  }
  if (required.length) {
    parts.push(
      required.map((r) => `new required field ${r.field} on ${r.method?.toUpperCase()} ${r.path}`).join("; "),
    );
  }
  if (optionalFields.length) {
    parts.push(
      optionalFields
        .map((r) => `added optional field ${r.field} on ${r.method?.toUpperCase()} ${r.path}`)
        .join("; "),
    );
  }
  if (added.length) {
    parts.push(
      added
        .map((a) => `added ${a.method ? a.method.toUpperCase() + " " : ""}${a.path}`)
        .join("; "),
    );
  }
  const rest = entries.filter(
    (e) =>
      !renames.includes(e) &&
      !ambiguous.includes(e) &&
      !removed.includes(e) &&
      !required.includes(e) &&
      !optionalFields.includes(e) &&
      !added.includes(e),
  );
  if (rest.length) parts.push(`${rest.length} other structural change(s)`);
  return `[${risk}] ${parts.join(". ")}.${note}`;
}

/** Human-readable suffix flagging that ref resolution was partial, if so. */
function resolutionNote(resolution?: SpecResolutionReport): string {
  if (!resolution || resolution.complete || resolution.issues.length === 0) {
    return "";
  }
  const counts = new Map<string, number>();
  for (const issue of resolution.issues) {
    counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  }
  const label: Record<string, string> = {
    external_ref: "unresolved remote reference",
    unresolvable_ref: "unresolvable local reference",
    cycle_bounded: "bounded cyclic reference",
  };
  const phrases = [...counts.entries()].map(([kind, n]) => {
    const base = label[kind] ?? kind;
    return `${n} ${base}${n === 1 ? "" : "s"}`;
  });
  return ` (partial: ${phrases.join(", ")}; diff may be incomplete)`;
}

/**
 * A structural diff augmented with the ref-resolution report. It is a superset
 * of {@link StructuralDiff}: consumers that only read entries/risk/summary work
 * unchanged, while callers that care about confidence can inspect `resolution`
 * to see whether any `$ref` was left unresolved (remote, unresolvable, or a
 * bounded cycle).
 */
export interface ResolvedStructuralDiff extends StructuralDiff {
  resolution: SpecResolutionReport;
}

/**
 * Diff the operations (methods, request/response fields) of a single path pair.
 * `recordPath` is the path recorded on every emitted entry — for an exact match
 * it is that path; for a version-normalized pair it is the old (v1) path so the
 * entries align with the code under analysis.
 */
function diffPathOperations(
  oldPathItem: unknown,
  newPathItem: unknown,
  recordPath: string,
  oldResolver: SchemaResolver,
  newResolver: SchemaResolver,
  entries: DiffEntry[],
): void {
  const path = recordPath;
  const oldMethods = getMethods(oldPathItem);
  const newMethods = getMethods(newPathItem);
  const oldM = new Set(Object.keys(oldMethods));
  const newM = new Set(Object.keys(newMethods));

  for (const method of oldM) {
    if (!newM.has(method)) {
      entries.push({
        op: "method_removed",
        path,
        method,
        breaking: true,
        detail: `${method.toUpperCase()} ${path} removed`,
      });
    }
  }
  for (const method of newM) {
    if (!oldM.has(method)) {
      entries.push({
        op: "method_added",
        path,
        method,
        breaking: false,
        detail: `${method.toUpperCase()} ${path} added`,
      });
    }
  }

  for (const method of oldM) {
    if (!newM.has(method)) continue;
    const oldReq = oldResolver.properties(
      requestBodySchema(oldMethods[method], oldResolver),
    );
    const newReq = newResolver.properties(
      requestBodySchema(newMethods[method], newResolver),
    );
    const oldKeys = new Set(oldReq.props.keys());
    const newKeys = new Set(newReq.props.keys());
    const newRequired = newReq.required;
    const oldRequired = oldReq.required;

    const { renames, ambiguities } = detectFieldChanges(oldReq.props, newReq.props);
    const renamedFrom = new Set(renames.map((r) => r.from));
    const renamedTo = new Set(renames.map((r) => r.to));
    const ambiguousFrom = new Set(ambiguities.map((a) => a.from));
    const ambiguousTo = new Set(ambiguities.flatMap((a) => a.candidates));

    for (const r of renames) {
      entries.push({
        op: "request_field_renamed",
        path,
        method,
        fromField: r.from,
        toField: r.to,
        field: r.to,
        breaking: true,
        detail: `Request field ${r.from} renamed to ${r.to}`,
      });
    }

    for (const a of ambiguities) {
      entries.push({
        op: "request_field_ambiguous",
        path,
        method,
        fromField: a.from,
        field: a.from,
        candidates: a.candidates,
        breaking: true,
        detail: `Request field ${a.from} has more than one plausible successor (${a.candidates.join(", ")}); the successor is selected by a runtime condition and cannot be resolved statically. Human decision required.`,
      });
    }

    for (const field of oldKeys) {
      if (!newKeys.has(field) && !renamedFrom.has(field) && !ambiguousFrom.has(field)) {
        entries.push({
          op: "request_field_removed",
          path,
          method,
          field,
          breaking: true,
          detail: `Request field ${field} removed`,
        });
      }
    }

    for (const field of newKeys) {
      if (oldKeys.has(field) || renamedTo.has(field) || ambiguousTo.has(field)) continue;
      if (newRequired.has(field) && !oldRequired.has(field)) {
        entries.push({
          op: "request_field_added_required",
          path,
          method,
          field,
          breaking: true,
          detail: `Required request field ${field} added`,
        });
      } else {
        entries.push({
          op: "request_field_added",
          path,
          method,
          field,
          breaking: false,
          detail: `Optional request field ${field} added`,
        });
      }
    }

    const oldRes = oldResolver.properties(
      responseSchema(oldMethods[method], oldResolver),
    );
    const newRes = newResolver.properties(
      responseSchema(newMethods[method], newResolver),
    );
    const oldResKeys = new Set(oldRes.props.keys());
    const newResKeys = new Set(newRes.props.keys());
    // Response fields have no rename op; a single-successor change stays a
    // removed + added pair. Only ambiguity (a field that splits into several
    // successors) is special-cased, so the tool abstains instead of asserting
    // one successor's removal as a confident finding.
    const { ambiguities: resAmbiguities } = detectFieldChanges(
      oldRes.props,
      newRes.props,
    );
    const resAmbiguousFrom = new Set(resAmbiguities.map((a) => a.from));
    const resAmbiguousTo = new Set(resAmbiguities.flatMap((a) => a.candidates));
    for (const a of resAmbiguities) {
      entries.push({
        op: "response_field_ambiguous",
        path,
        method,
        fromField: a.from,
        field: a.from,
        candidates: a.candidates,
        breaking: true,
        detail: `Response field ${a.from} has more than one plausible successor (${a.candidates.join(", ")}); which one is populated is selected by a runtime condition. Human decision required.`,
      });
    }
    for (const field of oldResKeys) {
      if (!newResKeys.has(field) && !resAmbiguousFrom.has(field)) {
        entries.push({
          op: "response_field_removed",
          path,
          method,
          field,
          breaking: true,
          detail: `Response field ${field} removed`,
        });
      }
    }
    for (const field of newResKeys) {
      if (!oldResKeys.has(field) && !resAmbiguousTo.has(field)) {
        entries.push({
          op: "response_field_added",
          path,
          method,
          field,
          breaking: false,
          detail: `Response field ${field} added`,
        });
      }
    }
  }
}

export function diffOpenApi(
  oldSpec: unknown,
  newSpec: unknown,
): ResolvedStructuralDiff {
  const old = asObj(oldSpec);
  const neu = asObj(newSpec);
  const oldResolver = new SchemaResolver(old);
  const newResolver = new SchemaResolver(neu);
  const oldPaths = getPaths(old);
  const newPaths = getPaths(neu);
  const entries: DiffEntry[] = [];

  const oldPathKeys = new Set(Object.keys(oldPaths));
  const newPathKeys = new Set(Object.keys(newPaths));

  for (const path of oldPathKeys) {
    if (!newPathKeys.has(path)) {
      entries.push({
        op: "path_removed",
        path,
        breaking: true,
        detail: `Path ${path} removed`,
      });
    }
  }

  for (const path of newPathKeys) {
    if (!oldPathKeys.has(path)) {
      entries.push({
        op: "path_added",
        path,
        breaking: false,
        detail: `Path ${path} added`,
      });
    }
  }

  for (const path of oldPathKeys) {
    if (!newPathKeys.has(path)) continue;
    diffPathOperations(
      oldPaths[path],
      newPaths[path],
      path,
      oldResolver,
      newResolver,
      entries,
    );
  }

  // Version-normalized path pairing. When a path changed only by its `/vN`
  // version prefix (e.g. `/v1/charges` → `/v2/charges`), the resource is the
  // same and its schema-level field changes must still surface — otherwise a
  // provider version bump hides a field rename (`source` → `payment_method`)
  // behind a bare path add/remove, and downstream consumers never see it. We
  // pair each removed old path with a uniquely-matching added new path by their
  // version-stripped key and diff their operations, recording entries against
  // the OLD path so they align with the (v1) code under analysis. The
  // path_removed / path_added entries above are left intact so the version bump
  // is still reported and still anchors provenance.
  const stripVersion = (p: string): string => p.replace(/^\/v\d+(?=\/|$)/, "");
  const removedByNorm = new Map<string, string[]>();
  const addedByNorm = new Map<string, string[]>();
  for (const path of oldPathKeys) {
    if (newPathKeys.has(path)) continue;
    const key = stripVersion(path);
    if (key === path) continue; // no version prefix to normalize
    (removedByNorm.get(key) ?? removedByNorm.set(key, []).get(key)!).push(path);
  }
  for (const path of newPathKeys) {
    if (oldPathKeys.has(path)) continue;
    const key = stripVersion(path);
    if (key === path) continue;
    (addedByNorm.get(key) ?? addedByNorm.set(key, []).get(key)!).push(path);
  }
  for (const [key, olds] of removedByNorm) {
    const news = addedByNorm.get(key);
    if (!news || olds.length !== 1 || news.length !== 1) continue; // only unambiguous pairs
    diffPathOperations(
      oldPaths[olds[0]!],
      newPaths[news[0]!],
      olds[0]!,
      oldResolver,
      newResolver,
      entries,
    );
  }

  // Nested path removals already covered; also detect method-level path that existed as nested
  // e.g. /v1/charges/{id}/receipt fully removed handled by path_removed

  const resolution = buildResolutionReport(oldResolver, newResolver);
  const risk = classifyRisk(entries);
  return {
    entries,
    risk,
    summary: summarizeChange(entries, risk, resolution),
    resolution,
  };
}

export function parseOpenApiJson(raw: string): unknown {
  return JSON.parse(raw);
}

function migrationStrategyFor(op: DiffOp, e: DiffEntry): string {
  switch (op) {
    case "request_field_renamed":
      return `Rename field usages ${e.fromField} → ${e.toField} on ${e.method?.toUpperCase() ?? ""} ${e.path ?? ""}`.trim();
    case "path_removed":
    case "method_removed":
      return `Remove or replace calls to ${e.method ? e.method.toUpperCase() + " " : ""}${e.path}; follow provider migration notes.`;
    case "request_field_added_required":
      return `Supply new required field ${e.field} on ${e.method?.toUpperCase() ?? ""} ${e.path ?? ""}`.trim();
    case "request_field_ambiguous":
    case "response_field_ambiguous":
      return `Field ${e.fromField} splits into ${(e.candidates ?? []).join(" or ")}; a human must choose the successor per call site. Do not auto-apply.`;
    case "request_field_removed":
    case "response_field_removed":
      return `Stop reading/writing field ${e.field}; migrate consumers of that property.`;
    case "request_field_added":
      return `Optional adoption: new request field ${e.field} on ${e.method?.toUpperCase() ?? ""} ${e.path ?? ""}`.trim();
    case "path_added":
    case "method_added":
    case "response_field_added":
      return `Optional adoption: new capability at ${e.method ? e.method.toUpperCase() + " " : ""}${e.path ?? e.field ?? ""}`.trim();
    default:
      return e.detail ?? "Review and update call sites.";
  }
}

function surfaceKind(op: DiffOp): ImpactableSurface["kind"] {
  if (op === "path_removed" || op === "path_added") return "http_path";
  if (op === "method_removed" || op === "method_added" || op === "method_changed") return "http_method";
  if (op.startsWith("request_field")) return "request_field";
  if (op.startsWith("response_field")) return "response_field";
  if (op === "security_changed") return "auth";
  return "other";
}

function searchTokensFor(e: DiffEntry): string[] {
  const tokens = new Set<string>();
  if (e.path) {
    tokens.add(e.path);
    tokens.add(e.path.replace(/\{[^}]+\}/g, ""));
    const segs = e.path.split("/").filter(Boolean);
    if (segs.length) tokens.add(segs[segs.length - 1]!);
  }
  if (e.method) tokens.add(e.method);
  if (e.field) tokens.add(e.field);
  if (e.fromField) tokens.add(e.fromField);
  if (e.toField) tokens.add(e.toField);
  // Common SDK-style hints derived from path
  if (e.path?.includes("charges")) {
    tokens.add("charges.create");
    tokens.add("charges.retrieve");
    tokens.add("client.charges");
  }
  return [...tokens].filter(Boolean);
}

/**
 * Change Intelligence output: machine-searchable Impactable Surfaces
 * that drive candidate discovery and confirmation.
 */
export function toImpactableSurfaces(
  diff: StructuralDiff,
  opts: { providerSlug?: string; providerNotes?: string } = {},
): ImpactableSurface[] {
  const provider = opts.providerSlug ?? "api";
  return diff.entries.map((e) => {
    const method = e.method?.toUpperCase();
    const canonicalParts = [
      provider,
      method,
      e.path,
      e.op,
      e.fromField ?? e.field,
      e.toField,
    ].filter(Boolean);
    const severity: ChangeRisk = e.breaking
      ? "breaking"
      : e.op === "path_added" || e.op === "method_added" || e.op === "response_field_added"
        ? "new_capability"
        : "non_breaking";
    return {
      id: newId(),
      canonicalId: canonicalParts.join("."),
      kind: surfaceKind(e.op),
      op: e.op,
      path: e.path,
      method: e.method,
      field: e.field,
      fromField: e.fromField,
      toField: e.toField,
      candidates: e.candidates,
      before: e.fromField ?? (e.op.includes("removed") ? e.path : undefined),
      after: e.toField ?? (e.op.includes("added") ? e.path : undefined),
      severity,
      migrationStrategy: migrationStrategyFor(e.op, e),
      explanation: e.detail ?? diff.summary,
      providerNotes: opts.providerNotes,
      searchTokens: searchTokensFor(e),
    };
  });
}

/** Full change normalizer: OpenAPI diff → structural + surfaces. */
export function normalizeChange(
  oldSpec: unknown,
  newSpec: unknown,
  opts: { providerSlug?: string; providerNotes?: string } = {},
): { diff: StructuralDiff; surfaces: ImpactableSurface[] } {
  const diff = diffOpenApi(oldSpec, newSpec);
  return {
    diff,
    surfaces: toImpactableSurfaces(diff, opts),
  };
}

