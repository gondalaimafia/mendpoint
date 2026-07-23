/**
 * F2: OpenAPI structural diff → API surface / change graph.
 */
import type { DiffEntry, StructuralDiff } from "@mendpoint/shared";
import { edge, node, withStats, type ProductGraph } from "./types.js";

function opId(e: DiffEntry, i: number): string {
  return `op:${i}:${e.op}:${e.path ?? ""}:${e.field ?? e.fromField ?? ""}`;
}

function pathId(path: string): string {
  return `path:${path}`;
}

function fieldId(path: string, field: string): string {
  return `field:${path}:${field}`;
}

/**
 * Build a graph of API change operations for visualization and alignment.
 */
export function buildApiChangeGraph(
  diff: StructuralDiff,
  opts?: { id?: string; title?: string; providerSlug?: string },
): ProductGraph {
  const nodes = new Map<string, ReturnType<typeof node>>();
  const edges: ReturnType<typeof edge>[] = [];
  let ei = 0;

  const changeId = opts?.id ?? "api-change";
  nodes.set(
    changeId,
    node(
      changeId,
      "change",
      opts?.title ?? diff.summary.slice(0, 80),
      { risk: diff.risk, providerSlug: opts?.providerSlug },
      0,
    ),
  );

  for (let i = 0; i < diff.entries.length; i++) {
    const e = diff.entries[i]!;
    const oid = opId(e, i);
    nodes.set(
      oid,
      node(
        oid,
        "operation",
        `${e.op}${e.path ? ` ${e.path}` : ""}`,
        {
          op: e.op,
          path: e.path,
          method: e.method,
          field: e.field,
          fromField: e.fromField,
          toField: e.toField,
          breaking: e.breaking,
          detail: e.detail,
        },
        1,
      ),
    );
    edges.push(edge(`e${ei++}`, changeId, oid, e.breaking ? "BREAKING_OP" : "OP", { op: e.op }));

    if (e.path) {
      const pid = pathId(e.path);
      if (!nodes.has(pid)) {
        nodes.set(pid, node(pid, "operation", e.path, { path: e.path }, 2));
      }
      edges.push(edge(`e${ei++}`, oid, pid, "ON_PATH"));
    }

    if (e.fromField && e.toField) {
      const from = fieldId(e.path ?? "", e.fromField);
      const to = fieldId(e.path ?? "", e.toField);
      if (!nodes.has(from)) {
        nodes.set(from, node(from, "field", e.fromField, { role: "from" }, 3));
      }
      if (!nodes.has(to)) {
        nodes.set(to, node(to, "field", e.toField, { role: "to" }, 3));
      }
      edges.push(edge(`e${ei++}`, from, to, "RENAMES_TO", { via: e.op }));
      edges.push(edge(`e${ei++}`, oid, from, "TOUCHES_FIELD"));
    } else if (e.field) {
      const fid = fieldId(e.path ?? "", e.field);
      if (!nodes.has(fid)) {
        nodes.set(fid, node(fid, "field", e.field, { role: "field" }, 3));
      }
      const kind =
        e.op.includes("removed")
          ? "REMOVED_FIELD"
          : e.op.includes("added")
            ? "ADDED_FIELD"
            : "TOUCHES_FIELD";
      edges.push(edge(`e${ei++}`, oid, fid, kind));
    }
  }

  return withStats({
    id: `api-surface:${changeId}`,
    title: opts?.title ?? "API change graph",
    description: diff.summary,
    nodes: [...nodes.values()],
    edges,
  });
}
