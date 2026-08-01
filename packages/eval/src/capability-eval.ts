import { classifyFailures, FAILURE_MODES } from "@mendpoint/agent";
import {
  classifyMigrationChange,
  createCampaign,
  diffOutputs,
  MIGRATION_COMPATIBILITY_RULES,
  orderDag,
  planMultiRepoAgents,
  type MigrationDagNode,
  type MigrationChangeKind,
} from "@mendpoint/transformer";
import { WARDEN_CAPABILITY_CASES } from "./corpus/warden-v1.js";
import { TRANSFORMER_CAPABILITY_CASES } from "./corpus/transformer-v1.js";
import type {
  CapabilityOperation,
  CapabilityProduct,
  CapabilityTier,
  TransformerBehaviorScenario,
} from "./corpus/types.js";
import { runWardenBench } from "./warden-bench.js";

export type CapabilityCaseResult = {
  id: string;
  product: CapabilityProduct;
  tier: CapabilityTier;
  category: string;
  operation: CapabilityOperation;
  critical: boolean;
  ok: boolean;
  error?: string;
};

export type CapabilityEvalReport = {
  corpusVersion: "2026-08-01.v1";
  passed: number;
  total: number;
  criticalFailures: string[];
  unsupported: string[];
  byProduct: Record<CapabilityProduct, { passed: number; total: number }>;
  byTier: Record<CapabilityTier, { passed: number; total: number }>;
  cases: CapabilityCaseResult[];
};

function node(
  id: string,
  repoKey: string,
  dependsOn: string[] = [],
): MigrationDagNode {
  return { id, title: id, repoKey, dependsOn, status: "pending" };
}

function expectError(action: () => unknown, pattern: RegExp): boolean {
  try {
    action();
    return false;
  } catch (error) {
    return pattern.test(error instanceof Error ? error.message : String(error));
  }
}

function evaluateTransformerBehavior(scenario: TransformerBehaviorScenario): boolean {
  switch (scenario) {
    case "linear_dag":
      return orderDag([node("c", "c", ["b"]), node("a", "a"), node("b", "b", ["a"])])
        .map((entry) => entry.id).join(",") === "a,b,c";
    case "diamond_dag": {
      const campaign = createCampaign({
        name: "diamond",
        sourceSystem: "old",
        targetStack: "new",
        dag: [
          node("a", "producer"),
          node("b", "consumer-b", ["a"]),
          node("c", "consumer-c", ["a"]),
          node("d", "contract", ["b", "c"]),
        ],
      });
      return JSON.stringify(planMultiRepoAgents(campaign).waves) === JSON.stringify([["a"], ["b", "c"], ["d"]]);
    }
    case "duplicate_id":
      return expectError(() => orderDag([node("a", "one"), node("a", "two")]), /duplicate node id/);
    case "unknown_dependency":
      return expectError(() => orderDag([node("a", "one", ["missing"])]), /unknown dependency/);
    case "self_dependency":
      return expectError(() => orderDag([node("a", "one", ["a"])]), /depend on itself/);
    case "cycle":
      return expectError(() => orderDag([node("a", "one", ["b"]), node("b", "two", ["a"])]), /cycle involving/);
    case "empty_dag":
      return expectError(() => orderDag([]), /at least one node/);
    case "same_repo_serialized": {
      const campaign = createCampaign({
        name: "serialize",
        sourceSystem: "old",
        targetStack: "new",
        dag: [node("a", "same"), node("b", "same"), node("c", "other")],
      });
      return planMultiRepoAgents(campaign).waves.every((wave) => {
        const repos = wave.map((id) => campaign.dag.find((entry) => entry.id === id)!.repoKey);
        return new Set(repos).size === repos.length;
      });
    }
    case "stable_replan": {
      const campaign = createCampaign({
        name: "resume",
        sourceSystem: "old",
        targetStack: "new",
        dag: [node("a", "one"), node("b", "two", ["a"])],
      });
      return JSON.stringify(planMultiRepoAgents(campaign)) === JSON.stringify(planMultiRepoAgents(campaign));
    }
    case "complete_coverage": {
      const campaign = createCampaign({
        name: "coverage",
        sourceSystem: "old",
        targetStack: "new",
        dag: [node("a", "one"), node("b", "two", ["a"]), node("c", "one", ["a"])],
      });
      const planned = planMultiRepoAgents(campaign).waves.flat();
      return planned.length === campaign.dag.length && new Set(planned).size === campaign.dag.length;
    }
    case "object_key_order":
      return diffOutputs({ a: 1, b: 2 }, { b: 2, a: 1 }).equal;
    case "missing_vs_null":
      return !diffOutputs({}, { value: null }).equal;
    case "array_order":
      return !diffOutputs([1, 2], [2, 1]).equal;
    case "nan_vs_null":
      return !diffOutputs(Number.NaN, null).equal;
    case "cyclic_output": {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const result = diffOutputs(cyclic, cyclic);
      return !result.equal && result.comparisonError === "cyclic output cannot be compared";
    }
  }
}

function countBy<T extends string>(
  values: CapabilityCaseResult[],
  keys: readonly T[],
  select: (value: CapabilityCaseResult) => T,
): Record<T, { passed: number; total: number }> {
  return Object.fromEntries(keys.map((key) => {
    const matching = values.filter((value) => select(value) === key);
    return [key, { passed: matching.filter((value) => value.ok).length, total: matching.length }];
  })) as Record<T, { passed: number; total: number }>;
}

export async function runCapabilityEval(): Promise<CapabilityEvalReport> {
  const results: CapabilityCaseResult[] = [];
  const coveredWardenModes = new Set<string>();

  for (const testCase of WARDEN_CAPABILITY_CASES) {
    const matches = classifyFailures(testCase.input.goal, testCase.input.errorLog);
    const match = matches.find((mode) => mode.id === testCase.expected.modeId);
    coveredWardenModes.add(testCase.expected.modeId);
    const ok = Boolean(match) && match!.clientFixable === testCase.expected.clientFixable;
    results.push({
      id: testCase.id,
      product: "warden",
      tier: testCase.tier,
      category: testCase.category,
      operation: testCase.operation,
      critical: testCase.critical,
      ok,
      ...(!ok ? { error: match
        ? `support mismatch: expected clientFixable=${testCase.expected.clientFixable}`
        : `missing diagnosis: ${testCase.expected.modeId}` } : {}),
    });
  }

  for (const mode of FAILURE_MODES) {
    if (!coveredWardenModes.has(mode.id)) {
      results.push({
        id: `warden.coverage.${mode.id}`,
        product: "warden",
        tier: "edge",
        category: "coverage",
        operation: "diagnose",
        critical: true,
        ok: false,
        error: "declared failure mode has no versioned corpus case",
      });
    }
  }

  const coveredTransformerKinds = new Set<string>();
  for (const testCase of TRANSFORMER_CAPABILITY_CASES) {
    let ok = false;
    let error: string | undefined;
    if ("changeKind" in testCase.input && "severity" in testCase.expected) {
      coveredTransformerKinds.add(testCase.input.changeKind);
      try {
        const result = classifyMigrationChange(testCase.input.changeKind as MigrationChangeKind);
        ok = result.severity === testCase.expected.severity;
        if (!ok) error = `expected ${testCase.expected.severity}, received ${result.severity}`;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } else if ("scenario" in testCase.input) {
      try {
        ok = evaluateTransformerBehavior(testCase.input.scenario);
        if (!ok) error = `scenario failed: ${testCase.input.scenario}`;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } else {
      error = "invalid Transformer capability case";
    }
    results.push({
      id: testCase.id,
      product: "transformer",
      tier: testCase.tier,
      category: testCase.category,
      operation: testCase.operation,
      critical: testCase.critical,
      ok,
      ...(error ? { error } : {}),
    });
  }

  for (const rule of MIGRATION_COMPATIBILITY_RULES) {
    if (!coveredTransformerKinds.has(rule.kind)) {
      results.push({
        id: `transformer.coverage.${rule.kind}`,
        product: "transformer",
        tier: "edge",
        category: "coverage",
        operation: "plan",
        critical: true,
        ok: false,
        error: "declared compatibility rule has no versioned corpus case",
      });
    }
  }

  const wardenBench = await runWardenBench();
  for (const benchCase of wardenBench.cases) {
    results.push({
      id: `warden.end_to_end.${benchCase.id}`,
      product: "warden",
      tier: "recovery",
      category: "end_to_end",
      operation: benchCase.filesChanged.length ? "repair" : "safe_handoff",
      critical: true,
      ok: benchCase.ok,
      ...(benchCase.error ? { error: benchCase.error } : {}),
    });
  }

  const criticalFailures = results
    .filter((result) => result.critical && !result.ok)
    .map((result) => result.id);
  return {
    corpusVersion: "2026-08-01.v1",
    passed: results.filter((result) => result.ok).length,
    total: results.length,
    criticalFailures,
    unsupported: results
      .filter((result) => result.operation === "safe_handoff")
      .map((result) => result.id),
    byProduct: countBy(results, ["warden", "transformer"] as const, (result) => result.product),
    byTier: countBy(results, ["common", "edge", "adversarial", "recovery"] as const, (result) => result.tier),
    cases: results,
  };
}

async function main() {
  const report = await runCapabilityEval();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Capability corpus ${report.corpusVersion}`);
    console.log(`Warden ${report.byProduct.warden.passed}/${report.byProduct.warden.total}`);
    console.log(`Transformer ${report.byProduct.transformer.passed}/${report.byProduct.transformer.total}`);
    console.log(`Critical failures ${report.criticalFailures.length}`);
    console.log(`Safe handoffs ${report.unsupported.length}`);
    for (const failure of report.cases.filter((result) => !result.ok)) {
      console.error(`${failure.id}: ${failure.error ?? "failed"}`);
    }
  }
  if (report.passed !== report.total || report.criticalFailures.length) process.exit(1);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("capability-eval.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("capability-eval.js");
if (isMain) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
