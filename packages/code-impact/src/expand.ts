/**
 * Stage: Context Expansion & Reachability
 *
 * Uses the **call graph** as the primary expansion mechanism:
 * direct API site → reverse reachability (wrappers, controllers) up to depth k.
 * Falls back to name-only callers when the graph has no seed node.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateSite, Confidence, ExpandedContext } from "@mendpoint/shared";
import {
  type CodebaseIndex,
  functionAt,
  getCallers,
  packageBoundary,
} from "@mendpoint/codebase-index";
import {
  directCallees,
  findWrappers,
  nodeAt,
  nodeByFileName,
  reverseReachability,
  type CallEdgeConfidence,
} from "@mendpoint/call-graph";

function toConfidence(c: CallEdgeConfidence): Confidence {
  return c;
}

export function expandContexts(
  index: CodebaseIndex,
  candidates: CandidateSite[],
  opts: { callerHops?: number; maxSliceLines?: number } = {},
): ExpandedContext[] {
  const hops = opts.callerHops ?? 3; // impact analysis: 1–3 hops upstream is typical
  const maxSlice = opts.maxSliceLines ?? 40;
  const out: ExpandedContext[] = [];
  const graph = index.callGraph;

  for (const candidate of candidates) {
    const fileMeta =
      index.files.find((f) => f.path === candidate.filePath) ??
      index.structuredFiles?.find((f) => f.path === candidate.filePath);
    const fn =
      functionAt(index, candidate.filePath, candidate.lineStart) ??
      (candidate.functionName
        ? index.functions.find(
            (f) => f.name === candidate.functionName && f.filePath === candidate.filePath,
          )
        : undefined);

    let slice = candidate.evidence;
    try {
      const text = readFileSync(join(index.repoRoot, candidate.filePath), "utf8");
      const lines = text.split(/\r?\n/);
      if (fn) {
        const start = Math.max(0, fn.lineStart - 1);
        const end = Math.min(lines.length, fn.lineEnd);
        const body = lines.slice(start, end);
        slice =
          body.length > maxSlice
            ? [
                ...body.slice(0, Math.floor(maxSlice / 2)),
                "/* … */",
                ...body.slice(body.length - Math.floor(maxSlice / 2)),
              ].join("\n")
            : body.join("\n");
      } else {
        const start = Math.max(0, candidate.lineStart - 4);
        const end = Math.min(lines.length, candidate.lineEnd + 4);
        slice = lines.slice(start, end).join("\n");
      }
    } catch {
      /* keep evidence */
    }

    const fnName = fn?.name ?? candidate.functionName;

    // --- Call-graph expansion (primary) ---
    let graphNodeId: string | undefined;
    let graphCallers: ExpandedContext["graphCallers"] = [];
    let wrappers: string[] = [];
    let callers: string[] = [];
    let callees: string[] = [];

    if (graph) {
      const seed =
        nodeAt(graph, candidate.filePath, candidate.lineStart) ??
        (fnName
          ? nodeByFileName(graph, candidate.filePath, fnName)
          : undefined);

      if (seed) {
        graphNodeId = seed.id;
        const upstream = reverseReachability(graph, seed.id, {
          maxDepth: hops,
          minConfidence: "low", // soundness-first; confirmation filters later
        });
        graphCallers = upstream.map((h) => ({
          qualifiedName: h.node.qualifiedName,
          name: h.node.name,
          filePath: h.node.filePath,
          depth: h.depth,
          confidence: toConfidence(h.minEdgeConfidence),
        }));
        callers = [...new Set(upstream.map((h) => h.node.name))];
        callees = directCallees(graph, seed.id).map((n) => n.name);
        wrappers = findWrappers(graph, [seed.id], { maxDepth: Math.min(2, hops) }).map(
          (w) => w.qualifiedName,
        );
      }
    }

    // Legacy name-only fallback
    if (!callers.length && fnName) {
      callers = getCallers(index, fnName, Math.min(hops, 2));
      callees = fnName ? index.calleesOf[fnName] ?? [] : [];
    }

    out.push({
      candidate: {
        ...candidate,
        functionName: fnName ?? candidate.functionName,
      },
      enclosingFunction: fnName,
      callers,
      callees,
      slice,
      isTestFile: fileMeta?.isTest ?? false,
      packageBoundary: packageBoundary(candidate.filePath),
      graphCallers,
      wrappers,
      graphNodeId,
    });
  }

  return out;
}
