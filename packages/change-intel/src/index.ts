import type {
  ChangeRisk,
  DiffEntry,
  DiffOp,
  ImpactableSurface,
  StructuralDiff,
} from "@mendpoint/shared";
import { newId } from "@mendpoint/shared";

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

function schemaProps(schema: unknown): { props: Json; required: Set<string> } {
  const s = asObj(schema);
  // unwrap application/json content schemas when needed
  return {
    props: asObj(s.properties),
    required: new Set(Array.isArray(s.required) ? (s.required as string[]) : []),
  };
}

function requestBodySchema(operation: unknown): unknown {
  const op = asObj(operation);
  const rb = asObj(op.requestBody);
  const content = asObj(rb.content);
  const json = asObj(content["application/json"]);
  return json.schema ?? op.requestBody;
}

function responseSchema(operation: unknown): unknown {
  const op = asObj(operation);
  const responses = asObj(op.responses);
  const success =
    responses["200"] ?? responses["201"] ?? responses["default"] ?? {};
  const content = asObj(asObj(success).content);
  const json = asObj(content["application/json"]);
  return json.schema;
}

function fieldKeys(schema: unknown): Set<string> {
  return new Set(Object.keys(schemaProps(schema).props));
}

function detectRenames(
  oldKeys: Set<string>,
  newKeys: Set<string>,
): Array<{ from: string; to: string }> {
  const removed = [...oldKeys].filter((k) => !newKeys.has(k));
  const added = [...newKeys].filter((k) => !oldKeys.has(k));
  const renames: Array<{ from: string; to: string }> = [];
  // Simple rename heuristic: singular pairs with shared prefix/suffix
  for (const from of removed) {
    for (const to of added) {
      if (
        from.includes(to) ||
        to.includes(from) ||
        (from.replace(/_cents$/, "") === to) ||
        (to.replace(/_cents$/, "") === from) ||
        levenshtein(from, to) <= 3
      ) {
        renames.push({ from, to });
        break;
      }
    }
  }
  return renames;
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

export function summarizeChange(entries: DiffEntry[], risk: ChangeRisk): string {
  if (entries.length === 0) return "No structural API changes detected.";
  const parts: string[] = [];
  const removed = entries.filter((e) => e.op === "path_removed" || e.op === "method_removed");
  const renames = entries.filter((e) => e.op === "request_field_renamed");
  const required = entries.filter((e) => e.op === "request_field_added_required");
  const added = entries.filter((e) => e.op === "path_added" || e.op === "method_added");
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
      !removed.includes(e) &&
      !required.includes(e) &&
      !added.includes(e),
  );
  if (rest.length) parts.push(`${rest.length} other structural change(s)`);
  return `[${risk}] ${parts.join(". ")}.`;
}

export function diffOpenApi(oldSpec: unknown, newSpec: unknown): StructuralDiff {
  const old = asObj(oldSpec);
  const neu = asObj(newSpec);
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
    const oldMethods = getMethods(oldPaths[path]);
    const newMethods = getMethods(newPaths[path]);
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
      const oldReq = requestBodySchema(oldMethods[method]);
      const newReq = requestBodySchema(newMethods[method]);
      const oldKeys = fieldKeys(oldReq);
      const newKeys = fieldKeys(newReq);
      const { required: newRequired } = schemaProps(newReq);
      const { required: oldRequired } = schemaProps(oldReq);

      const renames = detectRenames(oldKeys, newKeys);
      const renamedFrom = new Set(renames.map((r) => r.from));
      const renamedTo = new Set(renames.map((r) => r.to));

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

      for (const field of oldKeys) {
        if (!newKeys.has(field) && !renamedFrom.has(field)) {
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
        if (!oldKeys.has(field) && !renamedTo.has(field) && newRequired.has(field) && !oldRequired.has(field)) {
          entries.push({
            op: "request_field_added_required",
            path,
            method,
            field,
            breaking: true,
            detail: `Required request field ${field} added`,
          });
        }
      }

      const oldResKeys = fieldKeys(responseSchema(oldMethods[method]));
      const newResKeys = fieldKeys(responseSchema(newMethods[method]));
      for (const field of oldResKeys) {
        if (!newResKeys.has(field)) {
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
        if (!oldResKeys.has(field)) {
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

  // Nested path removals already covered; also detect method-level path that existed as nested
  // e.g. /v1/charges/{id}/receipt fully removed handled by path_removed

  const risk = classifyRisk(entries);
  return {
    entries,
    risk,
    summary: summarizeChange(entries, risk),
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
    case "request_field_removed":
    case "response_field_removed":
      return `Stop reading/writing field ${e.field}; migrate consumers of that property.`;
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

