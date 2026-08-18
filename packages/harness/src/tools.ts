/**
 * Real package-backed harness tools — no stub_ok for specialist actions.
 */
import { evaluatePrGates, reviewOpenApiDesign } from "@mendpoint/contract";
import {
  emptyBsg,
  createCampaign,
  planFromCampaign,
  diffOutputs,
  orderDag,
} from "@mendpoint/transformer";
import {
  runGraphQuery,
  getGraphLearnDb,
  formatQueryForPlanner,
  type GraphTenantScope,
} from "@mendpoint/graph-learn";
import type { PlanStep } from "@mendpoint/orchestrator";
import type { SandboxHandle } from "@mendpoint/platform";

export type ToolResult = { ok: boolean; output: string; error?: string };

function parseJsonNotes(notes?: string): Record<string, unknown> {
  if (!notes) return {};
  try {
    return JSON.parse(notes) as Record<string, unknown>;
  } catch {
    return { text: notes };
  }
}

/**
 * Truncate a formatted graph result for tool output without silently dropping
 * the coverage statement. formatQueryForPlanner renders coverage directly under
 * the summary, so a head-truncation keeps it; when the body is cut we append an
 * explicit marker so a caller can never mistake a clipped result for a full one.
 */
function truncateGraphMarkdown(md: string, limit: number): string {
  if (md.length <= limit) return md;
  const marker = "\n[graph result truncated for tool output; coverage shown above]";
  return md.slice(0, Math.max(0, limit - marker.length)) + marker;
}

/**
 * Graph-backed tools fail closed without a tenant scope: rather than read the
 * global cross-tenant graph, they refuse and surface a structured error.
 */
function graphScopeRequired(action: string): ToolResult {
  return {
    ok: false,
    output: "",
    error: `graph_tenant_scope_required for action=${action}`,
  };
}

export function runSpecialistTool(
  step: PlanStep,
  sbx: SandboxHandle,
  scope?: GraphTenantScope,
): ToolResult {
  const meta = parseJsonNotes(step.notes);
  const ref = step.ref ?? "";

  switch (step.action) {
    case "echo":
    case "harness.echo": {
      const msg = step.notes ?? step.title;
      return { ok: true, output: msg };
    }
    case "harness.shell": {
      if (sbx.kind === "local") {
        return {
          ok: false,
          output: "",
          error: "harness.shell requires a real isolated sandbox backend",
        };
      }
      const cmd = step.notes ?? "node -e \"console.log('ok')\"";
      const r = sbx.run(cmd);
      return {
        ok: r.ok,
        output: r.stdout,
        error: r.ok ? undefined : r.stderr || "shell failed",
      };
    }

    case "spec.lock_diff":
    case "spec.evolve":
    case "spec.evolve_field":
    case "spec.breaking_change":
    case "spec.add_capability": {
      const oldSpec = meta.oldSpec ?? { openapi: "3.0.0", paths: {} };
      const newSpec =
        meta.newSpec ??
        ({
          openapi: "3.0.0",
          paths: {
            "/v1/demo": {
              get: { responses: { "200": { description: "ok" } } },
            },
          },
        } as object);
      const gates = evaluatePrGates({
        oldSpec,
        newSpec,
        providerSlug: String(meta.providerSlug ?? "demo"),
      });
      return {
        ok: gates.ok,
        output: JSON.stringify({
          action: step.action,
          ref,
          gates: gates.gates,
          markdown: gates.reportMarkdown.slice(0, 800),
        }),
        error: gates.ok ? undefined : "gate failures",
      };
    }

    case "gate.contract_suite": {
      const gates = evaluatePrGates({
        oldSpec: meta.oldSpec,
        newSpec: meta.newSpec,
        providerSlug: String(meta.providerSlug ?? "demo"),
        contractCases: Array.isArray(meta.contractCases)
          ? (meta.contractCases as never[])
          : [
              {
                id: "health",
                name: "health",
                expectStatus: 200,
                requiredKeys: [],
              },
            ],
        securityScanAttested: meta.securityScanAttested === true,
      });
      return {
        ok: gates.ok,
        output: JSON.stringify({
          action: step.action,
          ok: gates.ok,
          gates: gates.gates,
        }),
        error: gates.ok ? undefined : gates.reportMarkdown.slice(0, 400),
      };
    }

    case "critic.api_reviewer": {
      const report = reviewOpenApiDesign(
        meta.spec ??
          meta.newSpec ?? {
            openapi: "3.0.0",
            info: { title: "Demo", version: "1" },
            paths: {
              "/v1/items": {
                get: {
                  responses: {
                    "200": { description: "ok" },
                    "400": { description: "bad" },
                  },
                },
              },
            },
          },
      );
      return {
        ok: report.score >= 50,
        output: JSON.stringify({
          action: step.action,
          score: report.score,
          findings: report.findings.slice(0, 12),
        }),
      };
    }

    case "impact.fanout_prs": {
      if (!scope) return graphScopeRequired(step.action);
      try {
        const db = getGraphLearnDb();
        const slug = String(meta.providerSlug ?? "acme");
        const q = runGraphQuery(db, {
          op: "who_consumes_provider",
          providerSlug: slug,
        }, scope);
        const n = q.rows?.length ?? 0;
        const requireConsumers = meta.requireConsumers === true;
        return {
          ok: !requireConsumers || n > 0,
          output: JSON.stringify({
            action: step.action,
            providerSlug: slug,
            consumers: n,
            markdown: truncateGraphMarkdown(formatQueryForPlanner(q), 600),
          }),
          error:
            requireConsumers && n === 0
              ? `no consumers for provider ${slug}`
              : undefined,
        };
      } catch (e) {
        return {
          ok: false,
          output: "",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "graph.stats": {
      if (!scope) return graphScopeRequired(step.action);
      const q = runGraphQuery(getGraphLearnDb(), { op: "stats" }, scope);
      return { ok: true, output: JSON.stringify({ action: step.action, ...q.rows?.[0], summary: q.summary }) };
    }

    case "graph.query": {
      if (!scope) return graphScopeRequired(step.action);
      const op = String(meta.op ?? "stats") as "stats";
      const q = runGraphQuery(getGraphLearnDb(), (meta.query as never) ?? { op }, scope);
      return {
        ok: true,
        output: truncateGraphMarkdown(formatQueryForPlanner(q), 1200),
      };
    }

    case "bsg.lock": {
      const bsg = emptyBsg({
        title: String(meta.title ?? step.title ?? "BSG"),
        sourceSystem: String(meta.sourceSystem ?? meta.system ?? "legacy"),
        targetSystem: String(meta.targetSystem ?? meta.targetStack ?? "node"),
      });
      return {
        ok: true,
        output: JSON.stringify({
          action: step.action,
          bsgId: bsg.id,
          nodes: bsg.nodes.length,
          edges: bsg.edges.length,
          sourceSystem: bsg.sourceSystem,
          targetSystem: bsg.targetSystem,
        }),
      };
    }

    case "dag.pr_unit": {
      const campaign = createCampaign({
        name: String(meta.name ?? step.title ?? "campaign"),
        sourceSystem: String(meta.sourceSystem ?? "legacy"),
        targetStack: String(meta.targetStack ?? "node"),
        dag: Array.isArray(meta.dag)
          ? (meta.dag as Array<{
                id: string;
                title: string;
                repoKey: string;
                dependsOn?: string[];
              }>).map((node) => ({
                ...node,
                dependsOn: node.dependsOn ?? [],
              }))
          : [
              {
                id: "u1",
                title: step.title,
                repoKey: String(meta.repoKey ?? "core"),
                dependsOn: [],
              },
            ],
      });
      const order = orderDag(campaign.dag);
      const plan = planFromCampaign(campaign);
      return {
        ok: true,
        output: JSON.stringify({
          action: step.action,
          campaignId: campaign.id,
          topo: order.map((n) => n.id),
          planSteps: plan.steps.length,
          planId: plan.id,
        }),
      };
    }

    case "critic.bsg_fidelity": {
      const left = meta.expected ?? meta.left ?? "ok";
      const right = meta.actual ?? meta.right ?? "ok";
      const diff = diffOutputs(left, right);
      return {
        ok: diff.equal,
        output: JSON.stringify({
          action: step.action,
          equal: diff.equal,
          summary: diff.diffSummary,
        }),
        error: diff.equal ? undefined : diff.diffSummary,
      };
    }

    default:
      return {
        ok: false,
        output: "",
        error: JSON.stringify({
          action: step.action,
          error: "unknown action",
          ref,
        }),
      };
  }
}
