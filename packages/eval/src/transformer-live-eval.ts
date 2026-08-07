import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, getRoutingLedgerForJob } from "@mendpoint/db";
import type {
  AdaptiveExternalModelAccounting,
  AdaptiveExternalModelReservation,
  AdaptiveExternalModelSettlement,
  AdaptiveRepairPlan,
  AdaptiveRepairPlannerInput,
  TransformerAttemptRunResult,
} from "@mendpoint/transformer";
import {
  resolveTransformerAdaptivePlannerAdapter,
  type TransformerAdaptiveModelProvenance,
  type TransformerAdaptivePlannerAdapterOptions,
} from "@mendpoint/worker/transformer-adaptive-planner";
import {
  buildRoutedExecutorRegistry,
  runRoutedTransformerAttempt,
  transformerExecutorDescriptor,
  transformerRoutingRequest,
} from "@mendpoint/worker/transformer-router";

export const TRANSFORMER_LIVE_EVAL_CASE_ID = "transformer.live.synthetic_node20.live" as const;
export const DEFAULT_TRANSFORMER_LIVE_EVAL_MAX_USD = 25;
export const DEFAULT_TRANSFORMER_LIVE_MIN_PASS_RATE = 1;
export const DEFAULT_TRANSFORMER_LIVE_MIN_CONSISTENCY = 1;

// Security boundary: this compiled synthetic fixture is the only source content
// sent by this lane. The evaluator never reads the workspace or customer data.
const SYNTHETIC_PACKAGE = Object.freeze({
  name: "synthetic-runtime-service",
  private: true,
  engines: { node: ">=18 <20" },
  scripts: { test: "node --test" },
  dependencies: { undici: "^6.19.0" },
});
const SYNTHETIC_CONTENT = `${JSON.stringify(SYNTHETIC_PACKAGE, null, 2)}\n`;

export type TransformerLiveGrade = Readonly<{
  id: string;
  passed: boolean;
  expected: string;
  observed: string;
}>;

export type TransformerLiveEvalTrial = Readonly<{
  trial: number;
  passed: boolean;
  objectiveVerified: boolean;
  filesChanged: readonly string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  provider: string;
  model: string;
  deployment: string;
  executionRegion: string;
  policyDigest: string;
  provenance: readonly TransformerAdaptiveModelProvenance[];
  grades: readonly TransformerLiveGrade[];
}>;

export type TransformerLiveEvalReport = Readonly<{
  schemaVersion: 1;
  caseId: typeof TRANSFORMER_LIVE_EVAL_CASE_ID;
  lane: "live_model";
  repetitions: number;
  passed: boolean;
  passRate: number;
  consistencyRate: number;
  thresholds: Readonly<{ minimumPassRate: number; minimumConsistencyRate: number }>;
  budgetUsd: number;
  spentUsd: number;
  totalTokens: number;
  trials: readonly TransformerLiveEvalTrial[];
}>;

export type RunTransformerLiveEvalOptions = Readonly<{
  repetitions?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: NonNullable<TransformerAdaptivePlannerAdapterOptions["fetchImpl"]>;
  priceTable?: TransformerAdaptivePlannerAdapterOptions["priceTable"];
  now?: () => number;
}>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const SYNTHETIC_DIGEST = sha256(SYNTHETIC_CONTENT);

function grade(id: string, passed: boolean, expected: unknown, observed: unknown): TransformerLiveGrade {
  const render = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
  return Object.freeze({ id, passed, expected: render(expected), observed: render(observed) });
}

function repetitions(value: number | undefined): number {
  const resolved = value ?? 3;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 10) {
    throw new Error("transformer_live_eval_repetitions_invalid");
  }
  return resolved;
}

function rate(value: string | undefined, fallback: number, code: string): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) throw new Error(code);
  return resolved;
}

function budget(env: NodeJS.ProcessEnv): number {
  const resolved = Number(env.MENDPOINT_TRANSFORMER_LIVE_EVAL_MAX_USD ?? DEFAULT_TRANSFORMER_LIVE_EVAL_MAX_USD);
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error("transformer_live_eval_budget_invalid");
  return resolved;
}

function syntheticPlannerInput(): AdaptiveRepairPlannerInput {
  return Object.freeze({
    schemaVersion: 1,
    unitId: "synthetic-node20-unit",
    goal: "Change only engines.node from Node 18 to >=20 <21. Preserve all scripts and dependencies exactly.",
    recipe: Object.freeze({ id: "synthetic-node20", version: 1, digest: sha256("synthetic-node20@1") }),
    iteration: 1,
    failingCommandId: "synthetic:node-engine",
    verifierOutput: "engines.node must equal >=20 <21 and all other package fields must remain unchanged",
    context: Object.freeze([Object.freeze({
      path: "package.json",
      content: SYNTHETIC_CONTENT,
      digest: SYNTHETIC_DIGEST,
      truncated: false,
    })]),
    allowedMutationPaths: Object.freeze(["package.json"]),
    priorChangedPaths: Object.freeze([]),
    budget: Object.freeze({
      plannerCalls: 1,
      modelCalls: 1,
      inputTokens: 20_000,
      outputTokens: 2_000,
      totalTokens: 22_000,
      actualCostUsd: 5,
    }),
  });
}

function verifySyntheticObjective(plan: AdaptiveRepairPlan) {
  const edit = plan.edits[0];
  const paths = Object.freeze(plan.edits.map((candidate) => candidate.path));
  if (plan.edits.length !== 1 || edit?.path !== "package.json" || edit.observedContentDigest !== SYNTHETIC_DIGEST) {
    return Object.freeze({ passed: false, paths, observed: { paths, digest: edit?.observedContentDigest } });
  }
  try {
    const next = JSON.parse(edit.nextContent) as typeof SYNTHETIC_PACKAGE;
    const observed = {
      engine: next.engines?.node,
      scriptsPreserved: JSON.stringify(next.scripts) === JSON.stringify(SYNTHETIC_PACKAGE.scripts),
      dependenciesPreserved: JSON.stringify(next.dependencies) === JSON.stringify(SYNTHETIC_PACKAGE.dependencies),
      metadataPreserved: next.name === SYNTHETIC_PACKAGE.name && next.private === SYNTHETIC_PACKAGE.private,
    };
    return Object.freeze({
      passed: observed.engine === ">=20 <21" && observed.scriptsPreserved && observed.dependenciesPreserved && observed.metadataPreserved,
      paths,
      observed,
    });
  } catch {
    return Object.freeze({ passed: false, paths, observed: "invalid package JSON" });
  }
}

class EvalAccounting implements AdaptiveExternalModelAccounting {
  readonly executionScopeId: string;
  readonly reservations: AdaptiveExternalModelReservation[] = [];
  readonly settlements: AdaptiveExternalModelSettlement[] = [];

  constructor(trial: number, private readonly remainingUsd: () => number) {
    this.executionScopeId = sha256(`synthetic-transformer-live:${trial}`);
  }

  async reserve(value: AdaptiveExternalModelReservation): Promise<void> {
    if (value.maximumCostUsd > this.remainingUsd()) throw new Error("transformer_live_eval_budget_exceeded");
    const prior = this.reservations.find((candidate) => candidate.reservationId === value.reservationId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error("transformer_live_eval_reservation_conflict");
    if (!prior) this.reservations.push(value);
  }

  async settle(value: AdaptiveExternalModelSettlement): Promise<void> {
    const prior = this.settlements.find((candidate) => candidate.reservationId === value.reservationId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error("transformer_live_eval_settlement_conflict");
    if (!prior) this.settlements.push(value);
  }
}

function provenanceGrades(
  records: readonly TransformerAdaptiveModelProvenance[],
  expected: Readonly<{ provider: string; model: string; deployment: string; region: string; policyDigest: string }>,
): TransformerLiveGrade[] {
  const present = records.length > 0;
  return [
    grade("provenance.present", present, "at least one call", records.length),
    grade("provider.exact", present && records.every((record) => record.provider === expected.provider), expected.provider, records.map((record) => record.provider)),
    grade("model.exact", present && records.every((record) => record.configuredModel === expected.model && record.actualModel === expected.model), expected.model, records.map((record) => [record.configuredModel, record.actualModel])),
    grade("deployment.exact", present && records.every((record) => record.deployment === expected.deployment), expected.deployment, records.map((record) => record.deployment)),
    grade("region.exact", present && records.every((record) => record.executionRegion === expected.region), expected.region, records.map((record) => record.executionRegion)),
    grade("policy.exact", present && records.every((record) => record.policyDigest === expected.policyDigest), expected.policyDigest, records.map((record) => record.policyDigest)),
    grade("transport.https", present && records.every((record) => record.endpointProtocol === "https:"), "https:", records.map((record) => record.endpointProtocol)),
    grade("request_id.present", present && records.every((record) => Boolean(record.bodyRequestId || record.headerRequestId)), "request id per call", records.map((record) => [record.bodyRequestId, record.headerRequestId])),
    grade("tokens.nonzero", present && records.every((record) => record.promptTokens > 0 && record.completionTokens > 0 && record.totalTokens > 0), "nonzero token counts", records.map((record) => record.totalTokens)),
    grade("tokens.consistent", present && records.every((record) => record.promptTokens + record.completionTokens === record.totalTokens), "prompt plus completion equals total", records.map((record) => record.totalTokens)),
    grade("cost.measured", present && records.every((record) => record.costUsd !== null && record.costUsd >= 0), "measured cost", records.map((record) => record.costUsd)),
  ];
}

async function runTrial(
  db: ReturnType<typeof createDb>,
  trial: number,
  env: NodeJS.ProcessEnv,
  options: RunTransformerLiveEvalOptions,
  spentUsd: () => number,
): Promise<TransformerLiveEvalTrial> {
  const tenantId = env.MENDPOINT_TRANSFORMER_LIVE_EVAL_TENANT!.trim();
  const accounting = new EvalAccounting(trial, () => budget(env) - spentUsd());
  const adapter = resolveTransformerAdaptivePlannerAdapter(tenantId, env, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.priceTable ? { priceTable: options.priceTable } : {}),
  });
  if (!adapter) throw new Error("transformer_live_eval_configuration_required");
  const external = {
    provider: adapter.policy.provider,
    model: adapter.policy.model,
    deployment: adapter.policy.deployment,
    executionRegion: adapter.policy.executionRegion,
    maximumDataClassification: adapter.policy.maximumDataClassification,
    maximumCostUsd: budget(env),
  } as const;
  const descriptor = transformerExecutorDescriptor(new Date().toISOString(), external);
  const campaignId = `transformer-live-${trial}`;
  const clock = options.now ?? Date.now;
  const started = clock();
  let objective = Object.freeze({
    passed: false,
    paths: Object.freeze([] as string[]),
    observed: "planner did not run" as unknown,
  });
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  const routed = await runRoutedTransformerAttempt({
    db,
    registry: buildRoutedExecutorRegistry(new Date().toISOString(), external),
    tenantId,
    jobId: campaignId,
    runId: `${campaignId}-run`,
    sessionId: `${campaignId}-run`,
    goal: syntheticPlannerInput().goal,
    routingRequest: transformerRoutingRequest({
      taskId: campaignId,
      tenantId,
      campaignId,
      idempotencyKey: `${campaignId}-route`,
      sourceArtifactIds: [SYNTHETIC_DIGEST, "fixture:synthetic-node20"],
      goal: syntheticPlannerInput().goal,
      verifyCommand: "synthetic:node-engine",
      classification: adapter.policy.maximumDataClassification,
      budgetUsd: budget(env),
      externalProcessingAllowed: true,
      allowedExecutionRegion: adapter.policy.executionRegion,
    }),
    outcomeIdempotencyKey: `${campaignId}-outcome`,
    providerId: descriptor.providerId,
    executorId: descriptor.executorId,
    runAttempt: async () => {
      const output = await adapter.planner(syntheticPlannerInput(), {
        externalModelAccounting: accounting,
      });
      objective = verifySyntheticObjective(output.plan);
      usage = {
        promptTokens: output.usage?.promptTokens ?? 0,
        completionTokens: output.usage?.completionTokens ?? 0,
        totalTokens: output.usage?.totalTokens ?? 0,
        costUsd: output.usage?.costUsd ?? 0,
      };
      return Object.freeze({
        status: objective.passed ? "completed" : "failed",
        summary: objective.passed
          ? "Synthetic Node 20 objective verified"
          : "Synthetic Node 20 objective failed",
        nextActions: Object.freeze(objective.passed
          ? ["Record live evaluation evidence"]
          : ["Inspect failed objective grades"]),
        artifacts: Object.freeze([]),
        ...(objective.passed
          ? {}
          : { recoveryCode: "verification_failed", errorCode: "transformer_live_objective_failed" }),
        adaptive: {
          usage: {
            measured: true,
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            costUsd: usage.costUsd,
          },
        },
      }) as unknown as TransformerAttemptRunResult;
    },
  });
  const provenance = adapter.provenance();
  const ledger = getRoutingLedgerForJob(db, campaignId, tenantId)[0];
  const grades = [
    ...provenanceGrades(provenance, {
      provider: adapter.policy.provider,
      model: adapter.policy.model,
      deployment: adapter.policy.deployment,
      region: adapter.policy.executionRegion,
      policyDigest: adapter.policy.policyDigest,
    }),
    grade("objective.verified", objective.passed, "Node 20 engine with other fields unchanged", objective.observed),
    grade("accounting.reserved", accounting.reservations.length === 1, 1, accounting.reservations.length),
    grade("accounting.settled", accounting.settlements.length === 1 && accounting.settlements[0]?.status === "succeeded", "one successful settlement", accounting.settlements),
    grade("router.executed", routed.status === (objective.passed ? "completed" : "failed"), objective.passed ? "completed" : "failed", routed.status),
    grade("router.provider", ledger?.provider_id === adapter.policy.provider, adapter.policy.provider, ledger?.provider_id ?? null),
    grade("router.tokens", ledger?.total_tokens === usage.totalTokens, usage.totalTokens, ledger?.total_tokens ?? null),
    grade("router.cost", ledger?.cost_usd === usage.costUsd, usage.costUsd, ledger?.cost_usd ?? null),
  ];
  return Object.freeze({
    trial,
    passed: grades.every((candidate) => candidate.passed),
    objectiveVerified: objective.passed,
    filesChanged: objective.paths,
    ...usage,
    latencyMs: Math.max(0, clock() - started),
    provider: adapter.policy.provider,
    model: adapter.policy.model,
    deployment: adapter.policy.deployment,
    executionRegion: adapter.policy.executionRegion,
    policyDigest: adapter.policy.policyDigest,
    provenance,
    grades: Object.freeze(grades),
  });
}

/**
 * Runs repeated live calls using only the compiled synthetic fixture above.
 * Both the explicit opt in and the production adapter's exact tenant policy
 * must pass before a provider request can occur.
 */
export async function runTransformerLiveEval(
  options: RunTransformerLiveEvalOptions = {},
): Promise<TransformerLiveEvalReport> {
  const env = options.env ?? process.env;
  if (env.MENDPOINT_EVAL_LIVE_TRANSFORMER !== "1") {
    throw new Error("transformer_live_eval_opt_in_required");
  }
  if (!env.MENDPOINT_TRANSFORMER_LIVE_EVAL_TENANT?.trim()) {
    throw new Error("transformer_live_eval_configuration_required");
  }
  const count = repetitions(options.repetitions);
  const maximumBudget = budget(env);
  const minimumPassRate = rate(
    env.MENDPOINT_TRANSFORMER_LIVE_MIN_PASS_RATE,
    DEFAULT_TRANSFORMER_LIVE_MIN_PASS_RATE,
    "transformer_live_eval_pass_threshold_invalid",
  );
  const minimumConsistencyRate = rate(
    env.MENDPOINT_TRANSFORMER_LIVE_MIN_CONSISTENCY,
    DEFAULT_TRANSFORMER_LIVE_MIN_CONSISTENCY,
    "transformer_live_eval_consistency_threshold_invalid",
  );
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-live-synthetic-"));
  const db = createDb(join(root, "routing.sqlite"));
  const trials: TransformerLiveEvalTrial[] = [];
  let spentUsd = 0;
  try {
    for (let trial = 1; trial <= count; trial += 1) {
      if (spentUsd >= maximumBudget) throw new Error("transformer_live_eval_budget_exceeded");
      const result = await runTrial(db, trial, env, options, () => spentUsd);
      trials.push(result);
      spentUsd += result.costUsd;
      if (spentUsd > maximumBudget) throw new Error("transformer_live_eval_budget_exceeded");
    }
  } finally {
    db.raw.close();
    rmSync(root, { recursive: true, force: true });
  }
  const passRate = trials.filter((trial) => trial.passed).length / trials.length;
  const signatures = trials.map((trial) => JSON.stringify({
    objectiveVerified: trial.objectiveVerified,
    filesChanged: trial.filesChanged,
    provider: trial.provider,
    model: trial.model,
  }));
  const signatureCounts = new Map<string, number>();
  for (const signature of signatures) {
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  const consistencyRate = Math.max(...signatureCounts.values()) / trials.length;
  return Object.freeze({
    schemaVersion: 1,
    caseId: TRANSFORMER_LIVE_EVAL_CASE_ID,
    lane: "live_model",
    repetitions: count,
    passed: passRate >= minimumPassRate && consistencyRate >= minimumConsistencyRate,
    passRate,
    consistencyRate,
    thresholds: Object.freeze({ minimumPassRate, minimumConsistencyRate }),
    budgetUsd: maximumBudget,
    spentUsd,
    totalTokens: trials.reduce((sum, trial) => sum + trial.totalTokens, 0),
    trials: Object.freeze(trials),
  });
}
