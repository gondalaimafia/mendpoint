import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { addStep, emptyPlan } from "@mendpoint/orchestrator";
import { executePlan, runDir } from "@mendpoint/harness";
import { clearAlerts, emitAlert, setAlertPersistPath, type Principal } from "@mendpoint/platform";
import { createPlatformStateRoutes } from "./platform-state-routes.js";
import type { ApiEnv } from "./auth.js";

const dirs: string[] = [];

afterEach(() => {
  clearAlerts();
  setAlertPersistPath(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function appFor(baseDir: string, principal: Principal) {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    c.set("requestId", "request-1");
    await next();
  });
  app.route("/platform", createPlatformStateRoutes({ baseDir }));
  return app;
}

async function seed(baseDir: string, tenantId: string, title: string, runId = "shared-id") {
  let plan = emptyPlan({ kind: "generic", title, goal: title, agent: "shared" });
  plan = addStep(plan, {
    title: "Echo",
    action: "harness.echo",
    successCriteria: [`stdout contains ${title}`],
    notes: title,
  });
  return executePlan({ baseDir, runId, plan, scope: { tenantId } });
}

describe("platform state routes", () => {
  it("lists only the caller tenant and makes foreign reads and patches indistinguishable 404s", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "platform-state-"));
    dirs.push(baseDir);
    const own = await seed(baseDir, "tenant-a", "owned");
    await seed(baseDir, "tenant-b", "foreign shared");
    const foreign = await seed(baseDir, "tenant-b", "foreign", "only-foreign");
    const app = appFor(baseDir, { id: "a", tenantId: "tenant-a", role: "engineer" });

    const list = await app.request("/platform/plans");
    expect(list.status).toBe(200);
    const listed = await list.json() as { plans: unknown[] };
    expect(listed.plans).toEqual([{ runId: "shared-id", title: "owned", steps: 1 }]);

    const trajectories = await app.request("/platform/trajectories");
    expect(trajectories.status).toBe(200);
    const trajectoryBody = await trajectories.json() as { runs: Array<{ runId: string }> };
    expect(trajectoryBody.runs.map((run) => run.runId)).toEqual(["shared-id"]);

    const foreignTrajectory = await app.request("/platform/trajectories/only-foreign");
    expect(foreignTrajectory.status).toBe(404);

    const foreignGet = await app.request("/platform/plans/only-foreign");
    expect(foreignGet.status).toBe(404);
    const before = readFileSync(foreign.paths.planPath, "utf8");
    const foreignPatch = await app.request("/platform/plans/only-foreign", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "attacker edit" }),
    });
    expect(foreignPatch.status).toBe(404);
    expect(readFileSync(foreign.paths.planPath, "utf8")).toBe(before);
    expect(readFileSync(own.paths.planPath, "utf8")).toContain("owned");
  });

  it("filters customer alerts exactly and lets only the system catalog principal see legacy alerts", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "platform-alert-"));
    dirs.push(baseDir);
    const alertPath = join(baseDir, "alerts.jsonl");
    setAlertPersistPath(alertPath);
    clearAlerts({ wipeFile: true });
    emitAlert({ severity: "info", source: "test", message: "legacy" });
    emitAlert({ severity: "warn", source: "test", message: "a", tenantId: "tenant-a" });
    emitAlert({ severity: "critical", source: "test", message: "b", tenantId: "tenant-b" });

    const customer = await appFor(baseDir, { id: "a", tenantId: "tenant-a", role: "owner" }).request("/platform/alerts");
    const customerBody = await customer.json() as { alerts: Array<{ message: string }> };
    expect(customerBody.alerts.map((alert) => alert.message)).toEqual(["a"]);
    const persisted = readFileSync(alertPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { message: string; tenantId?: string });
    expect(persisted.find((alert) => alert.message === "a")?.tenantId).toBe("tenant-a");

    const system = await appFor(baseDir, { id: "sys", tenantId: "tenant_default", role: "owner" }).request("/platform/alerts");
    const systemBody = await system.json() as { alerts: Array<{ message: string }> };
    expect(systemBody.alerts.map((alert) => alert.message)).toEqual(["legacy", "a", "b"]);
  });

  it("lists and renders a tenant-owned score-only trajectory", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "platform-score-only-"));
    dirs.push(baseDir);
    const scope = { tenantId: "tenant-a" };
    const paths = runDir(baseDir, "score-only", scope);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.scorePath, JSON.stringify({
      runId: "score-only",
      tenantId: "tenant-a",
      ok: true,
      stepsTotal: 0,
      stepsDone: 0,
      stepsFailed: 0,
      recoveredFromFailure: false,
      durationMs: 1,
    }), "utf8");
    const app = appFor(baseDir, { id: "a", tenantId: "tenant-a", role: "viewer" });

    const list = await app.request("/platform/trajectories");
    const body = await list.json() as { runs: Array<{ runId: string; hasPlan: boolean }> };
    expect(body.runs).toContainEqual(expect.objectContaining({ runId: "score-only", hasPlan: false }));

    const detail = await app.request("/platform/trajectories/score-only");
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { text: string };
    expect(detailBody.text).toContain("score.json");
    expect(detailBody.text).toContain("tenant-a");

    const invalid = await app.request("/platform/trajectories/invalid!");
    expect(invalid.status).toBe(404);
  });
});
