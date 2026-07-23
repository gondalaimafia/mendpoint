/**
 * Turn a published ChangeEvent into StructuralDiff + ImpactableSurfaces
 * (same contract as OpenAPI normalizer output).
 */
import { newId, type DiffEntry, type ImpactableSurface, type StructuralDiff } from "@mendpoint/shared";
import type { ChangeEvent } from "./types.js";

export function changeEventToDiff(ev: ChangeEvent): StructuralDiff {
  const entries: DiffEntry[] = ev.ops.map((o) => ({
    op: o.op as DiffEntry["op"],
    path: o.path,
    method: o.method,
    field: o.field,
    fromField: o.fromField,
    toField: o.toField,
    detail: o.detail,
    breaking: o.breaking ?? ev.type === "breaking",
  }));
  return {
    entries,
    risk: ev.type === "new_capability" ? "new_capability" : ev.type === "breaking" ? "breaking" : "non_breaking",
    summary: `[${ev.type}] ${ev.title}. ${ev.description}`,
  };
}

export function changeEventToSurfaces(ev: ChangeEvent): ImpactableSurface[] {
  const diff = changeEventToDiff(ev);
  return diff.entries.map((e, i) => {
    const tokens = new Set<string>([
      ...ev.searchTokens,
      e.path,
      e.field,
      e.fromField,
      e.toField,
      ev.sdkSurface,
      ev.surface,
    ].filter(Boolean) as string[]);
    return {
      id: newId(),
      canonicalId: `${ev.vendor}.${e.op}.${e.path ?? e.field ?? i}`,
      kind:
        e.op.includes("path") || e.path?.startsWith("/")
          ? "http_path"
          : e.op.includes("field")
            ? "request_field"
            : e.op.includes("security")
              ? "auth"
              : "sdk_method",
      op: e.op,
      path: e.path,
      method: e.method,
      field: e.field,
      fromField: e.fromField,
      toField: e.toField,
      before: e.fromField,
      after: e.toField,
      severity: e.breaking ? "breaking" : diff.risk,
      migrationStrategy: e.detail ?? ev.migration,
      explanation: ev.description,
      providerNotes: ev.migration,
      searchTokens: [...tokens],
    };
  });
}
