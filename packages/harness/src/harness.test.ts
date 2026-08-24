import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addStep, emptyPlan } from "@mendpoint/orchestrator";
import {
  executePlan,
  helloWorldRun,
  loadPlan,
  runDir,
  collectDogfood,
  seedDogfoodScores,
  formatDogfoodReport,
  writeDogfoodReport,
  listTrajectories,
  viewTrajectory,
  DOGFOOD_TARGET_RUNS,
  savePlanHitl,
  listPlans,
  getPlan,
} from "./index.js";
import { runSpecialistTool } from "./tools.js";
import {
  getGraphLearnDb,
  ingestControlPlane,
  resetGraphLearnDbForTests,
} from "@mendpoint/graph-learn";
import type { SandboxHandle } from "@mendpoint/platform";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("harness", () => {
  it("hello world persists plan trace score", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-"));
    dirs.push(base);
    const r = await helloWorldRun(base);
    expect(r.ok).toBe(true);
    const plan = JSON.parse(readFileSync(r.paths.planPath, "utf8"));
    expect(plan.steps.length).toBe(2);
    const trace = readFileSync(r.paths.tracePath, "utf8");
    expect(trace).toContain("step_start");
    const score = JSON.parse(readFileSync(r.paths.scorePath, "utf8"));
    expect(score.runId).toBe(r.runId);
  });

  it("preserves an injected failure across execution and resume", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-rec-"));
    dirs.push(base);
    let plan = emptyPlan({
      kind: "generic",
      title: "recovery",
      goal: "fail then skip",
      agent: "shared",
    });
    plan = addStep(plan, {
      title: "Will fail",
      action: "harness.echo",
      successCriteria: ["x"],
      notes: "boom",
    });
    plan = addStep(plan, {
      title: "Still runs",
      action: "harness.echo",
      successCriteria: ["stdout contains after"],
      notes: "after",
    });
    const r1 = await executePlan({
      baseDir: base,
      plan,
      injectFailureAction: "harness.echo",
    });
    expect(r1.score.recoveredFromFailure).toBe(false);
    expect(r1.ok).toBe(false);
    expect(r1.score.ok).toBe(false);
    expect(r1.score.stepsDone).toBe(1);
    expect(r1.score.stepsFailed).toBe(1);
    expect(r1.plan.steps.map((step) => step.status)).toEqual(["failed", "done"]);
    expect(readFileSync(r1.paths.tracePath, "utf8")).toContain(
      '"continuation":"remaining_steps"',
    );

    // resume: all steps should already be terminal
    const r2 = await executePlan({
      baseDir: base,
      plan: loadPlan(runDir(base, r1.runId)),
      resumeRunId: r1.runId,
    });
    expect(r2.runId).toBe(r1.runId);
    expect(r2.ok).toBe(false);
    expect(r2.score.stepsFailed).toBe(1);
    expect(r2.plan.steps[0]?.status).toBe("failed");
  });

  it("aggregates seeded runs but marks them synthetic and keeps them out of the real figures", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-dog-"));
    dirs.push(base);
    await helloWorldRun(base);
    const seeded = seedDogfoodScores(base, DOGFOOD_TARGET_RUNS, {
      okRate: 0.6,
      prefix: "seed",
    });
    expect(seeded).toHaveLength(DOGFOOD_TARGET_RUNS);
    const report = collectDogfood(base);
    // Fabricated records are recorded and surfaced explicitly ...
    expect(report.syntheticRuns).toBe(DOGFOOD_TARGET_RUNS);
    expect(report.synthetic).toBe(true);
    // ... but excluded from the real figures: only the one real helloWorldRun counts.
    expect(report.totalRuns).toBe(1);
    expect(report.meetsVolume).toBe(false);
    expect(report.day90Ready).toBe(false);
    const written = readFileSync(writeDogfoodReport(base, report), "utf8");
    expect(written).toContain("day90Ready");
    expect(written).toContain("syntheticRuns");
    // The synthetic marker survives into the human-readable summary.
    expect(formatDogfoodReport(report)).toMatch(/SYNTHETIC/);
    expect(formatDogfoodReport(report)).toMatch(/Dogfood/);
  });

  it("does not count a synthetic dogfood record as a real one (integrity control)", async () => {
    // This is the control for the fabrication guard. If the synthetic marker or the
    // real-vs-synthetic segregation in collectDogfood is removed, these fabricated
    // OK runs would satisfy the day-90 gate and this test dies.
    const base = mkdtempSync(join(tmpdir(), "harness-dog-control-"));
    dirs.push(base);
    seedDogfoodScores(base, DOGFOOD_TARGET_RUNS + 5, { okRate: 1, prefix: "seed" });
    const report = collectDogfood(base);
    expect(report.totalRuns).toBe(0);
    expect(report.okRate).toBe(0);
    expect(report.meetsVolume).toBe(false);
    expect(report.day90Ready).toBe(false);
    expect(report.synthetic).toBe(true);
    expect(report.syntheticRuns).toBe(DOGFOOD_TARGET_RUNS + 5);
  });

  it("views trajectories", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-view-"));
    dirs.push(base);
    const r = await helloWorldRun(base);
    const list = listTrajectories(base);
    expect(list.some((x) => x.runId === r.runId)).toBe(true);
    const text = viewTrajectory(base, r.runId);
    expect(text).toContain("score.json");
    expect(text).toContain("trace");
  });

  it("HITL plan edit + cost fields on score", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-hitl-"));
    dirs.push(base);
    const r = await helloWorldRun(base);
    expect(r.score.costUsd).toBeGreaterThanOrEqual(0);
    expect(r.score.tokensEst).toBeGreaterThan(0);
    const plans = listPlans(base);
    expect(plans.some((p) => p.runId === r.runId)).toBe(true);
    const updated = savePlanHitl(base, r.runId, {
      title: "Edited by human",
      goal: "HITL goal",
    });
    expect(updated.title).toBe("Edited by human");
    expect(getPlan(base, r.runId).goal).toBe("HITL goal");
  });

  it("filters run directories without a readable plan", () => {
    const base = mkdtempSync(join(tmpdir(), "harness-plans-"));
    dirs.push(base);
    mkdirSync(join(base, "runs", "missing"), { recursive: true });
    mkdirSync(join(base, "runs", "invalid"), { recursive: true });
    writeFileSync(join(base, "runs", "invalid", "plan.json"), "{", "utf8");

    expect(listPlans(base)).toEqual([]);
  });

  it("rejects run identifiers that can escape the runs directory", () => {
    const base = mkdtempSync(join(tmpdir(), "harness-path-"));
    dirs.push(base);
    expect(() => runDir(base, "../outside")).toThrow(/Invalid run id/);
    expect(() => runDir(base, "nested/run")).toThrow(/Invalid run id/);
    expect(runDir(base, "run-1").root).toBe(join(base, "runs", "run-1"));
  });

  it("namespaces identical run ids by tenant and persists the tenant on scores", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-tenant-"));
    dirs.push(base);
    const tenantA = { tenantId: "tenant-a" };
    const tenantB = { tenantId: "tenant-b" };

    let planA = emptyPlan({ kind: "generic", title: "A", goal: "tenant A", agent: "shared" });
    planA = addStep(planA, {
      title: "Echo A",
      action: "harness.echo",
      successCriteria: ["stdout contains tenant A"],
      notes: "tenant A",
    });
    let planB = emptyPlan({ kind: "generic", title: "B", goal: "tenant B", agent: "shared" });
    planB = addStep(planB, {
      title: "Echo B",
      action: "harness.echo",
      successCriteria: ["stdout contains tenant B"],
      notes: "tenant B",
    });

    const a = await executePlan({ baseDir: base, runId: "same-run", plan: planA, scope: tenantA });
    const b = await executePlan({ baseDir: base, runId: "same-run", plan: planB, scope: tenantB });

    expect(a.paths.root).not.toBe(b.paths.root);
    expect(a.score.tenantId).toBe("tenant-a");
    expect(b.score.tenantId).toBe("tenant-b");
    expect(getPlan(base, "same-run", tenantA).title).toBe("A");
    expect(getPlan(base, "same-run", tenantB).title).toBe("B");
    expect(listPlans(base, tenantA).map((item) => item.runId)).toEqual(["same-run"]);
    expect(listTrajectories(base, tenantB).map((item) => item.runId)).toEqual(["same-run"]);
  });

  it("keeps the legacy unscoped layout explicit and rejects blank tenant scopes", () => {
    const base = mkdtempSync(join(tmpdir(), "harness-scope-"));
    dirs.push(base);
    expect(runDir(base, "legacy-run").root).toBe(join(base, "runs", "legacy-run"));
    expect(() => runDir(base, "run-1", { tenantId: " " })).toThrow(/tenant scope required/i);
    expect(() => listPlans(base, { tenantId: "" })).toThrow(/tenant scope required/i);
  });

  it("contains path-shaped tenant ids inside an opaque namespace", () => {
    const base = mkdtempSync(join(tmpdir(), "harness-hostile-tenant-"));
    dirs.push(base);
    const paths = runDir(base, "run-1", { tenantId: "../../other/tenant" });
    expect(paths.root.startsWith(join(base, "tenant-runs"))).toBe(true);
    expect(paths.root).not.toContain("other");
    expect(paths.root).not.toContain("tenant\\run-1");
  });

  it("does not expose tenant namespaces as legacy unscoped runs", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-legacy-list-"));
    dirs.push(base);
    await helloWorldRun(base, { tenantId: "tenant-a" });
    expect(listTrajectories(base)).toEqual([]);
    expect(listPlans(base)).toEqual([]);
  });

  it("runs real specialist tools not stub_ok", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-real-"));
    dirs.push(base);
    let plan = emptyPlan({
      kind: "generic",
      title: "real tools",
      goal: "no stubs",
      agent: "warden",
    });
    plan = addStep(plan, {
      title: "API review",
      action: "critic.api_reviewer",
      successCriteria: ["score"],
    });
    plan = addStep(plan, {
      title: "BSG lock",
      action: "bsg.lock",
      successCriteria: ["bsg"],
    });
    plan = addStep(plan, {
      title: "DAG unit",
      action: "dag.pr_unit",
      successCriteria: ["plan"],
      notes: JSON.stringify({
        name: "demo",
        sourceSystem: "vb6",
        targetStack: "node",
        dag: [
          { id: "first", title: "First", repoKey: "core" },
          {
            id: "second",
            title: "Second",
            repoKey: "api",
            dependsOn: ["first"],
          },
        ],
      }),
    });
    plan = addStep(plan, {
      title: "Fidelity",
      action: "critic.bsg_fidelity",
      successCriteria: ["equal"],
      notes: JSON.stringify({ expected: "ok", actual: "ok" }),
    });
    const r = await executePlan({ baseDir: base, plan });
    expect(r.ok).toBe(true);
    const evidence = r.plan.steps.map((s) => s.evidence ?? "").join("\n");
    expect(evidence).not.toContain("stub_ok");
    expect(evidence).toMatch(/score|bsgId|campaignId|equal/);
  });

  it("fails the contract-suite security gate when no attestation is manufactured", () => {
    const base = mkdtempSync(join(tmpdir(), "harness-attest-"));
    dirs.push(base);
    const sandbox: SandboxHandle = {
      id: "attest",
      kind: "vm",
      root: base,
      mocks: [],
      dispose: () => undefined,
      run: () => ({ ok: true, stdout: "", stderr: "" }),
    };
    const securityGate = (notes?: string) => {
      let plan = emptyPlan({
        kind: "generic",
        title: "attest",
        goal: "fail closed",
        agent: "warden",
      });
      plan = addStep(plan, {
        title: "Contract suite",
        action: "gate.contract_suite",
        successCriteria: ["ok"],
        ...(notes === undefined ? {} : { notes }),
      });
      const result = runSpecialistTool(plan.steps[0]!, sandbox);
      const parsed = JSON.parse(result.output) as {
        gates: Array<{ id: string; ok: boolean }>;
      };
      return { result, gate: parsed.gates.find((g) => g.id === "security-scan") };
    };

    // Absent notes: the value is manufactured nowhere, so the gate must refuse.
    const absent = securityGate(undefined);
    expect(absent.result.ok).toBe(false);
    expect(absent.gate?.ok).toBe(false);

    // Non-JSON notes: parseJsonNotes yields { text }, still not an attestation.
    const nonJson = securityGate("free-form operator note");
    expect(nonJson.result.ok).toBe(false);
    expect(nonJson.gate?.ok).toBe(false);

    // Only an explicit boolean attestation satisfies the security gate.
    const attested = securityGate(JSON.stringify({ securityScanAttested: true }));
    expect(attested.gate?.ok).toBe(true);
  });

  it("keeps the graph coverage statement inside the tool truncation limits", () => {
    // Seed the process-wide graph DB in a temp file so the harness tools, which
    // read the singleton, see enough rows that formatQueryForPlanner's output
    // overruns both the 600- and 1200-char tool caps.
    const dbDir = mkdtempSync(join(tmpdir(), "harness-graph-"));
    dirs.push(dbDir);
    const prevDbPath = process.env.GRAPH_LEARN_DB;
    process.env.GRAPH_LEARN_DB = join(dbDir, "graph-learn.sqlite");
    resetGraphLearnDbForTests();
    try {
      const tenantId = "tenant-trunc";
      // Long consumer ids guarantee each rendered row is wide.
      const consumerIds = Array.from(
        { length: 15 },
        (_, i) => `consumer-${"x".repeat(90)}-${i}`,
      );
      ingestControlPlane(
        getGraphLearnDb(),
        {
          provider: { id: "p1", slug: "acme", name: "Acme" },
          consumers: consumerIds.map((id, i) => ({
            id,
            name: `Consumer ${i}`,
            githubOwner: "o",
            githubRepo: `r${i}`,
          })),
          monitors: consumerIds.map((id) => ({ consumerId: id, providerId: "p1" })),
        },
        tenantId,
      );
      const scope = { tenantId, consumerIds };
      const sandbox: SandboxHandle = {
        id: "trunc",
        kind: "local",
        root: dbDir,
        mocks: [],
        dispose: () => undefined,
        run: () => ({ ok: true, stdout: "", stderr: "" }),
      };

      const stepFor = (action: string, notes: string) => {
        let plan = emptyPlan({
          kind: "generic",
          title: action,
          goal: "render graph result",
          agent: "shared",
        });
        plan = addStep(plan, {
          title: action,
          action,
          successCriteria: ["ok"],
          notes,
        });
        return plan.steps[0]!;
      };

      // Site 1: impact.fanout_prs truncates the markdown field to 600 chars.
      const fanout = runSpecialistTool(
        stepFor("impact.fanout_prs", JSON.stringify({ providerSlug: "acme" })),
        sandbox,
        scope,
      );
      const fanoutMd = (JSON.parse(fanout.output) as { markdown: string }).markdown;
      expect(fanoutMd).toContain("Coverage:");
      expect(fanoutMd).toContain("truncated for tool output");

      // Site 2: graph.query truncates the whole formatted output to 1200 chars.
      const query = runSpecialistTool(
        stepFor(
          "graph.query",
          JSON.stringify({
            query: { op: "who_consumes_provider", providerSlug: "acme" },
          }),
        ),
        sandbox,
        scope,
      );
      // The marker is only appended when the formatted output overran the cap,
      // so its presence proves truncation happened without dropping coverage.
      expect(query.output).toContain("Coverage:");
      expect(query.output).toContain("truncated for tool output");
      expect(query.output.length).toBeLessThanOrEqual(1200);
    } finally {
      resetGraphLearnDbForTests();
      if (prevDbPath === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = prevDbPath;
    }
  });

  it("fails unknown actions and unmet success criteria", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-gates-"));
    dirs.push(base);
    let plan = emptyPlan({
      kind: "generic",
      title: "strict gates",
      goal: "fail closed",
      agent: "shared",
    });
    plan = addStep(plan, {
      title: "Unknown",
      action: "does.not.exist",
      successCriteria: ["ok"],
    });
    plan = addStep(plan, {
      title: "Unmet",
      action: "harness.echo",
      successCriteria: ["stdout contains impossible"],
      notes: "actual",
    });

    const r = await executePlan({ baseDir: base, plan });
    expect(r.ok).toBe(false);
    expect(r.plan.steps.map((step) => step.status)).toEqual(["failed", "failed"]);
    expect(r.plan.steps[0]?.evidence).toContain("unknown action");
    expect(r.plan.steps[1]?.evidence).toContain("success criterion not met");
  });

  it("does not execute shell commands in the local workdir sandbox", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-local-shell-"));
    dirs.push(base);
    let plan = emptyPlan({
      kind: "generic",
      title: "local shell",
      goal: "fail closed",
      agent: "shared",
    });
    plan = addStep(plan, {
      title: "Shell",
      action: "harness.shell",
      successCriteria: ["output is non-empty"],
      notes: "node --version",
    });
    const result = await executePlan({ baseDir: base, plan });
    expect(result.ok).toBe(false);
    expect(result.plan.steps[0]?.evidence).toContain("real isolated sandbox");
  });

  it("allows shell execution only through an isolated backend handle", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-vm-shell-"));
    dirs.push(base);
    const sandbox: SandboxHandle = {
      id: "vm-test",
      kind: "vm",
      root: base,
      mocks: [],
      dispose: () => undefined,
      run: () => ({ ok: true, stdout: "v20.0.0", stderr: "" }),
    };
    let plan = emptyPlan({
      kind: "generic",
      title: "vm shell",
      goal: "isolated execution",
      agent: "shared",
    });
    plan = addStep(plan, {
      title: "Shell",
      action: "harness.shell",
      successCriteria: ["stdout contains v20"],
      notes: "node --version",
    });
    const result = await executePlan({ baseDir: base, plan, sandbox });
    expect(result.ok).toBe(true);
  });

  it("records the real graph-query count, not a hardcoded zero", async () => {
    // A run with no graph steps: graphQueries is a measured zero.
    const base0 = mkdtempSync(join(tmpdir(), "harness-gq0-"));
    dirs.push(base0);
    const noGraph = await helloWorldRun(base0);
    expect(noGraph.score.graphQueries).toBe(0);

    // A run with two graph.stats steps: graphQueries is the real count (2),
    // proving the value is threaded from execution rather than fabricated.
    const dbDir = mkdtempSync(join(tmpdir(), "harness-gq-"));
    dirs.push(dbDir);
    const prevDbPath = process.env.GRAPH_LEARN_DB;
    process.env.GRAPH_LEARN_DB = join(dbDir, "graph-learn.sqlite");
    resetGraphLearnDbForTests();
    try {
      const tenantId = "tenant-gq";
      ingestControlPlane(
        getGraphLearnDb(),
        {
          provider: { id: "p1", slug: "acme", name: "Acme" },
          consumers: [{ id: "c1", name: "Shop", githubOwner: "o", githubRepo: "s" }],
          monitors: [{ consumerId: "c1", providerId: "p1" }],
        },
        tenantId,
      );
      const scope = { tenantId, consumerIds: ["c1"] };
      const sandbox: SandboxHandle = {
        id: "gq",
        kind: "local",
        root: dbDir,
        mocks: [],
        dispose: () => undefined,
        run: () => ({ ok: true, stdout: "", stderr: "" }),
      };
      let plan = emptyPlan({
        kind: "generic",
        title: "graph queries",
        goal: "count graph queries",
        agent: "shared",
      });
      plan = addStep(plan, {
        title: "stats 1",
        action: "graph.stats",
        successCriteria: ["output contains nodes"],
        notes: "",
      });
      plan = addStep(plan, {
        title: "stats 2",
        action: "graph.stats",
        successCriteria: ["output contains nodes"],
        notes: "",
      });
      const base = mkdtempSync(join(tmpdir(), "harness-gqrun-"));
      dirs.push(base);
      const result = await executePlan({ baseDir: base, plan, scope });
      expect(result.ok).toBe(true);
      expect(result.score.graphQueries).toBe(2);
      // The persisted score file carries the same measured count.
      const persisted = JSON.parse(readFileSync(result.paths.scorePath, "utf8"));
      expect(persisted.graphQueries).toBe(2);
    } finally {
      resetGraphLearnDbForTests();
      if (prevDbPath === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = prevDbPath;
    }
  });
});
