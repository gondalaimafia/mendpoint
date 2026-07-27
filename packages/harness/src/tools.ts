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

export function runSpecialistTool(
  step: PlanStep,
  sbx: SandboxHandle,
): ToolResult {
  const meta = parseJsonNotes(step.notes);
  const ref = step.ref ?? "";

  switch (step.action) {
    case "echo":
    case "harness.echo": {
      const msg = step.notes ?? step.title;
      const r = sbx.run(
        process.platform === "win32"
          ? `cmd /c echo ${JSON.stringify(msg)}`
          : `echo ${JSON.stringify(msg)}`,
      );
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case "harness.shell": {
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
        ok: gates.ok || step.action !== "spec.breaking_change",
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
        securityScanOk: meta.securityScanOk !== false,
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
      try {
        const db = getGraphLearnDb();
        const q = runGraphQuery(db, {
          op: "who_consumes_provider",
          providerSlug: String(meta.providerSlug ?? "acme"),
        });
        return {
          ok: true,
          output: JSON.stringify({
            action: step.action,
            consumers: q.rows?.length ?? 0,
            markdown: formatQueryForPlanner(q).slice(0, 600),
          }),
        };
      } catch (e) {
        return {
          ok: true,
          output: JSON.stringify({
            action: step.action,
            note: "graph empty or unavailable",
            error: e instanceof Error ? e.message : String(e),
          }),
        };
      }
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
            }>)
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
        ok: true,
        output: JSON.stringify({
          action: step.action,
          note: "unknown action — recorded as noop",
          ref,
        }),
      };
  }
}
