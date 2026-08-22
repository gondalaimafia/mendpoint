/**
 * Controls for the LIVE-MODEL context-benchmark arm. Each test guards one
 * property the arm's integrity or safety depends on and names the control that
 * dies if it is removed, so a reviewer can revert that line, watch the test fail,
 * and restore it. The live arm changes ONLY the agent (a real model in place of
 * the modeled chooser); these tests prove nothing else changed, that the
 * stateless arm cannot see persistent context in the rendered prompt text, that
 * the dollar cap is enforced before any call, that model output is untrusted, and
 * that an unconfigured lane skips cleanly rather than passing.
 */
import { describe, it, expect } from "vitest";
import {
  resolveLiveContextArmConfig,
  missionContextInputForTaskArm,
  inheritedContextPromptBody,
  hazardMessages,
  parseModelChoice,
  planLiveCalls,
  estimatePlanCostUsd,
  stageLiveContextBenchmark,
  runLiveContextBenchmark,
  LiveContextAccounting,
  NO_VALID_CHOICE,
  type LiveModelCall,
  type LiveModelCallResult,
} from "./live-arm.js";
import {
  stageBenchmark,
  gradeBenchmark,
  chooseOption,
  availableItems,
  ARM_IDS,
  type ArmId,
  type BenchmarkScenario,
} from "./context-benchmark.js";
import {
  COHORT,
  SEALED_KEY,
  sealedKeyFor,
  MIGRATION_SCENARIO,
  CONFLICTING_CONTEXT_SCENARIO,
} from "./scenarios.js";

const APPROVED_MODEL = "muse-spark-1.2-contributor";

/** A fully-configured env whose endpoint host matches the pinned approved host. */
function readyEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    OPENAI_API_KEY: "test-key",
    LLM_AGENT_URL: "http://127.0.0.1:9999/v1",
    LLM_AGENT_MODEL: APPROVED_MODEL,
    MENDPOINT_LIVE_APPROVED_HOST: "127.0.0.1:9999",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

/** The synthetic per-scenario cost we hand the fake so the accounting settles a real,
 * priced, measured charge (muse-spark-1.2-contributor: prompt $0.1/M, completion $0.2/M). */
function pricedUsage(): Pick<
  Extract<LiveModelCallResult, { ok: true }>,
  "inputTokens" | "outputTokens" | "totalTokens" | "costUsd"
> {
  const inputTokens = 400;
  const outputTokens = 10;
  const costUsd = (inputTokens * 0.1 + outputTokens * 0.2) / 1_000_000;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd };
}

/**
 * A fake perfect-attention model. It replays, in plan order, the option the
 * DETERMINISTIC agent would choose for each (arm, hazard). This is how we prove
 * the live arm reproduces the deterministic ceiling when the model attends
 * perfectly — i.e. the arms differ ONLY by the agent, nothing else.
 */
function perfectAttentionCall(scenarios: readonly BenchmarkScenario[]): {
  call: LiveModelCall;
  count: () => number;
} {
  const planned = planLiveCalls(scenarios);
  const expected = planned.map((plan) => {
    const scenario = scenarios.find((s) => s.scenarioId === plan.scenarioId)!;
    const task = scenario.tasks.find((t) => t.taskId === plan.taskId)!;
    const hazard = task.hazards.find((h) => h.hazardId === plan.hazardId)!;
    return chooseOption(scenario.tenantId, hazard, availableItems(task, plan.arm));
  });
  let i = 0;
  const usage = pricedUsage();
  const call: LiveModelCall = async () => {
    const choice = expected[i++]!;
    return {
      ok: true,
      content: JSON.stringify({ choice }),
      echoedModel: APPROVED_MODEL,
      endpointHost: "127.0.0.1:9999",
      ...usage,
    };
  };
  return { call, count: () => i };
}

// ---------------------------------------------------------------------------
// Configuration: fail-closed, out-of-band host pin.
// ---------------------------------------------------------------------------

describe("live context arm configuration", () => {
  it("skips with a not-measured reason when the approved host is not pinned", () => {
    // CONTROL: the out-of-band MENDPOINT_LIVE_APPROVED_HOST requirement.
    const config = resolveLiveContextArmConfig(readyEnv({ MENDPOINT_LIVE_APPROVED_HOST: undefined }));
    expect(config.status).toBe("skipped");
    if (config.status === "skipped") expect(config.reason).toContain("MENDPOINT_LIVE_APPROVED_HOST");
  });

  it("skips when the resolved endpoint host is not the approved host", () => {
    // CONTROL: the endpoint-host-equals-approved-host comparison.
    const config = resolveLiveContextArmConfig(readyEnv({ MENDPOINT_LIVE_APPROVED_HOST: "other.example" }));
    expect(config.status).toBe("skipped");
    if (config.status === "skipped") expect(config.reason).toContain("not the approved host");
  });

  it("skips when the configured model is not the approved model", () => {
    const config = resolveLiveContextArmConfig(readyEnv({ LLM_AGENT_MODEL: "some-other-model" }));
    expect(config.status).toBe("skipped");
    if (config.status === "skipped") expect(config.reason).toContain("not the approved model");
  });

  it("skips when no API key is configured", () => {
    const config = resolveLiveContextArmConfig(readyEnv({ OPENAI_API_KEY: undefined, XAI_API_KEY: undefined }));
    expect(config.status).toBe("skipped");
    if (config.status === "skipped") expect(config.reason).toContain("API key");
  });

  it("skips when the budget is present but not a positive number", () => {
    const config = resolveLiveContextArmConfig(readyEnv({ MENDPOINT_LIVE_EVAL_MAX_USD: "-1" }));
    expect(config.status).toBe("skipped");
  });

  it("is ready and defaults the cap to five dollars when fully configured", () => {
    const config = resolveLiveContextArmConfig(readyEnv());
    expect(config.status).toBe("ready");
    if (config.status === "ready") {
      expect(config.approved).toEqual({ host: "127.0.0.1:9999", model: APPROVED_MODEL });
      expect(config.budgetUsd).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Leak-proofing over rendered prompt TEXT.
// ---------------------------------------------------------------------------

describe("live context arm leak-proofing", () => {
  it("a stateless live prompt contains no persistent item's content", () => {
    // CONTROL: prompts are compiled from availableItems(task, arm) alone, so the
    // stateless bucket carries no persistent content. Migration stage 3 has three
    // persistent items whose recommendations only the persistent arm should see.
    const scenario = MIGRATION_SCENARIO;
    const stage3 = scenario.tasks.find((t) => t.taskId === "stage3-depends-on-prior")!;
    const persistentItems = stage3.context.filter((i) => i.bucket === "persistent");
    expect(persistentItems.length).toBeGreaterThan(0);

    const statelessPrompt = inheritedContextPromptBody(scenario, stage3, "stateless");
    for (const item of persistentItems) {
      expect(statelessPrompt).not.toContain(item.itemId);
      expect(statelessPrompt).not.toContain(item.recommends);
    }

    // The persistent arm DOES carry them (proving the difference is real, not that
    // the compiler simply drops everything).
    const persistentPrompt = inheritedContextPromptBody(scenario, stage3, "persistent");
    for (const item of persistentItems) {
      expect(persistentPrompt).toContain(item.recommends);
    }
  });

  it("the option enum handed to the model is only the public options, never the answer", () => {
    // CONTROL: hazardMessages builds the enum from hazard.options; the sealed key
    // is never in scope here. If the correct option leaked into the enum it would
    // still only be one of the public options, so the answer cannot be encoded.
    const scenario = CONFLICTING_CONTEXT_SCENARIO;
    const task = scenario.tasks[0]!;
    const hazard = task.hazards[0]!;
    const messages = hazardMessages(inheritedContextPromptBody(scenario, task, "persistent"), hazard);
    expect([...messages.optionEnum].sort()).toEqual([...hazard.options].sort());
    // The sealed truth for this hazard (eu-region) is not singled out anywhere.
    expect(messages.optionEnum).toContain("eu-region");
    expect(messages.optionEnum).toContain("us-region");
  });

  it("the persistent arm faithfully injects a confirmed-but-wrong memory (can be worse)", () => {
    // The compiler renders the confirmed memory recommending the WRONG option, so
    // a context-following model is misled exactly as §1.1 of the research doc says.
    const scenario = CONFLICTING_CONTEXT_SCENARIO;
    const task = scenario.tasks[0]!;
    const prompt = inheritedContextPromptBody(scenario, task, "persistent");
    expect(prompt).toContain("us-region"); // the wrong, confirmed recommendation
  });

  it("staged live choices have the same shape and reachable sets as the deterministic stager", () => {
    // CONTROL: the live stager reuses availableItems for reachableItemIds and the
    // same staged schema, so the grader and its leak gate treat both identically.
    const { call } = perfectAttentionCall(COHORT);
    return (async () => {
      const accounting = new LiveContextAccounting(APPROVED_MODEL, "127.0.0.1:9999", 5);
      const planned = planLiveCalls(COHORT);
      const staged = await stageLiveContextBenchmark(COHORT, planned, call, accounting, {
        approved: { host: "127.0.0.1:9999", model: APPROVED_MODEL },
        maxOutputTokens: 64,
      });
      expect(staged.status).toBe("staged");
      const deterministic = stageBenchmark(COHORT);
      if (staged.status !== "staged") return;
      expect(staged.staged.cohortDigest).toBe(deterministic.cohortDigest);
      const keyOf = (c: { arm: string; scenarioId: string; hazardId: string }) => `${c.arm} ${c.scenarioId} ${c.hazardId}`;
      const liveReach = new Map(staged.staged.choices.map((c) => [keyOf(c), [...c.reachableItemIds].sort().join(",")]));
      for (const d of deterministic.choices) {
        expect(liveReach.get(keyOf(d))).toBe([...d.reachableItemIds].sort().join(","));
      }
    })();
  });
});

// ---------------------------------------------------------------------------
// Same grader, same sealed truth: only the agent changes.
// ---------------------------------------------------------------------------

describe("live context arm reproduces the ceiling under perfect attention", () => {
  it("a perfect-attention model yields the SAME graded report as the deterministic arm", async () => {
    const { call, count } = perfectAttentionCall(COHORT);
    const accounting = new LiveContextAccounting(APPROVED_MODEL, "127.0.0.1:9999", 5);
    const planned = planLiveCalls(COHORT);
    const staged = await stageLiveContextBenchmark(COHORT, planned, call, accounting, {
      approved: { host: "127.0.0.1:9999", model: APPROVED_MODEL },
      maxOutputTokens: 64,
    });
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") return;

    const liveReport = gradeBenchmark(COHORT, staged.staged, SEALED_KEY);
    const deterministicReport = gradeBenchmark(COHORT, stageBenchmark(COHORT), SEALED_KEY);

    // Identical headline and per-arm outcome metrics: with a perfect-attention
    // model the live arm reproduces the deterministic ceiling exactly, so any real
    // shortfall later is attributable to imperfect attention and nothing else.
    expect(liveReport.headline).toEqual(deterministicReport.headline);
    for (const arm of ARM_IDS) {
      expect(liveReport.arms[arm].taskCorrectness).toEqual(deterministicReport.arms[arm].taskCorrectness);
      expect(liveReport.arms[arm].repeatedMistakeRate).toEqual(deterministicReport.arms[arm].repeatedMistakeRate);
      expect(liveReport.arms[arm].verificationSuccess).toEqual(deterministicReport.arms[arm].verificationSuccess);
    }
    // One call per (arm, hazard): 14 hazards x 2 arms = 28.
    expect(count()).toBe(28);
  });
});

// ---------------------------------------------------------------------------
// Untrusted model output.
// ---------------------------------------------------------------------------

describe("live context arm treats model output as untrusted", () => {
  it("maps a valid in-set choice through and anything else to the no-valid-choice sentinel", () => {
    // CONTROL: parseModelChoice validates against the option set; it never trusts
    // an out-of-set string and never executes content.
    const options = ["eu-region", "us-region"] as const;
    expect(parseModelChoice(JSON.stringify({ choice: "eu-region" }), options)).toBe("eu-region");
    expect(parseModelChoice(JSON.stringify({ choice: "mars-region" }), options)).toBe(NO_VALID_CHOICE);
    expect(parseModelChoice("not json at all", options)).toBe(NO_VALID_CHOICE);
    expect(parseModelChoice(JSON.stringify({ notChoice: "eu-region" }), options)).toBe(NO_VALID_CHOICE);
    // A payload that looks like code is data only: it never runs and is not an option.
    expect(parseModelChoice('{"choice":"process.exit(1)"}', options)).toBe(NO_VALID_CHOICE);
  });

  it("grades a no-valid-choice sentinel as wrong, never as a correct answer", async () => {
    const scenario = CONFLICTING_CONTEXT_SCENARIO;
    const usage = pricedUsage();
    const junkCall: LiveModelCall = async () => ({
      ok: true,
      content: "this is not json",
      echoedModel: APPROVED_MODEL,
      endpointHost: "127.0.0.1:9999",
      ...usage,
    });
    const accounting = new LiveContextAccounting(APPROVED_MODEL, "127.0.0.1:9999", 5);
    const planned = planLiveCalls([scenario]);
    const staged = await stageLiveContextBenchmark([scenario], planned, junkCall, accounting, {
      approved: { host: "127.0.0.1:9999", model: APPROVED_MODEL },
      maxOutputTokens: 64,
    });
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") return;
    for (const choice of staged.staged.choices) expect(choice.chosenOption).toBe(NO_VALID_CHOICE);
    const report = gradeBenchmark([scenario], staged.staged, sealedKeyFor([scenario]));
    // No sentinel choice can equal a correct option, so correctness is 0.
    expect(report.arms.persistent.taskCorrectness).toEqual({ measured: true, value: 0 });
  });
});

// ---------------------------------------------------------------------------
// Reserve-and-settle accounting under a hard cap.
// ---------------------------------------------------------------------------

describe("live context arm accounting and hard cap", () => {
  it("refuses a reservation that would exceed the dollar cap", () => {
    // CONTROL: reserve() rejects before any call when consumed+reserved+worst>cap.
    const accounting = new LiveContextAccounting(APPROVED_MODEL, "127.0.0.1:9999", 0.0000001);
    expect(() =>
      accounting.reserve({
        reservationId: "r1",
        endpointHost: "127.0.0.1:9999",
        configuredModel: APPROVED_MODEL,
        maximumInputTokens: 100_000,
        maximumOutputTokens: 1_000,
      }),
    ).toThrow("context_live_budget_exceeded");
    expect(accounting.spentUsd()).toBe(0);
  });

  it("rejects a reservation whose model or host is not the approved identity", () => {
    const accounting = new LiveContextAccounting(APPROVED_MODEL, "127.0.0.1:9999", 5);
    expect(() =>
      accounting.reserve({
        reservationId: "r1",
        endpointHost: "evil.example",
        configuredModel: APPROVED_MODEL,
        maximumInputTokens: 100,
        maximumOutputTokens: 10,
      }),
    ).toThrow("context_live_reservation_identity_mismatch");
  });

  it("charges the measured cost on settle and never more than the worst case", () => {
    const accounting = new LiveContextAccounting(APPROVED_MODEL, "127.0.0.1:9999", 5);
    accounting.reserve({
      reservationId: "r1",
      endpointHost: "127.0.0.1:9999",
      configuredModel: APPROVED_MODEL,
      maximumInputTokens: 1_000,
      maximumOutputTokens: 100,
    });
    const usage = pricedUsage();
    const charged = accounting.settle({
      reservationId: "r1",
      status: "succeeded",
      endpointHost: "127.0.0.1:9999",
      echoedModel: APPROVED_MODEL,
      ...usage,
    });
    expect(charged).toBeCloseTo(usage.costUsd!, 12);
    expect(accounting.spentUsd()).toBeCloseTo(usage.costUsd!, 12);
  });

  it("charges the conservative worst case when the provider reports no usable usage", () => {
    const accounting = new LiveContextAccounting(APPROVED_MODEL, "127.0.0.1:9999", 5);
    const worst = accounting.reserve({
      reservationId: "r1",
      endpointHost: "127.0.0.1:9999",
      configuredModel: APPROVED_MODEL,
      maximumInputTokens: 1_000,
      maximumOutputTokens: 100,
    });
    const charged = accounting.settle({
      reservationId: "r1",
      status: "succeeded",
      endpointHost: "127.0.0.1:9999",
      echoedModel: APPROVED_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: null,
    });
    expect(charged).toBe(worst);
  });

  it("the plan cost estimate is positive and priced for the approved model", () => {
    const planned = planLiveCalls(COHORT);
    const estimate = estimatePlanCostUsd(planned, APPROVED_MODEL, 64);
    expect(estimate).not.toBeNull();
    expect(estimate!).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The runner: skipped vs measured are distinct, spend is always reported.
// ---------------------------------------------------------------------------

describe("live context arm runner", () => {
  it("skips cleanly (not measured, zero spend) when unconfigured", async () => {
    const lines: string[] = [];
    const result = await runLiveContextBenchmark(readyEnv({ MENDPOINT_LIVE_APPROVED_HOST: undefined }), {
      log: (line) => lines.push(line),
    });
    expect(result.status).toBe("not_measured");
    if (result.status === "not_measured") {
      expect(result.spentUsd).toBe(0);
      expect(result.reason).toContain("MENDPOINT_LIVE_APPROVED_HOST");
    }
    expect(lines.join("\n")).toContain("not measured");
  });

  it("measures with a fake model, prints the estimate BEFORE the spend, and reports actual spend", async () => {
    const lines: string[] = [];
    const { call } = perfectAttentionCall(COHORT);
    const result = await runLiveContextBenchmark(readyEnv(), { call, log: (line) => lines.push(line) });
    expect(result.status).toBe("measured");
    if (result.status !== "measured") return;

    // Distinct from the skip case: a real graded report with the reused grader.
    expect(result.report.headline.repeatsAvoidedByPersistentContext.measured).toBe(true);
    expect(result.spentUsd).toBeGreaterThan(0);
    expect(result.spentUsd).toBeLessThanOrEqual(5);
    expect(result.estimateUsd).toBeGreaterThanOrEqual(result.spentUsd);

    const joined = lines.join("\n");
    const estimateIdx = joined.indexOf("estimated worst-case spend");
    const spendIdx = joined.indexOf("Actual spend");
    expect(estimateIdx).toBeGreaterThanOrEqual(0);
    expect(spendIdx).toBeGreaterThan(estimateIdx);
    // The synthetic confirmation is stated before any call.
    expect(joined).toContain("synthetic");
    expect(joined).toContain("tenant-northwind");
  });

  it("reports not-measured with the captured spend when delivery fails", async () => {
    const failingCall: LiveModelCall = async () => ({ ok: false, reason: "transport_error", endpointHost: "127.0.0.1:9999" });
    const result = await runLiveContextBenchmark(readyEnv(), { call: failingCall, log: () => {} });
    expect(result.status).toBe("not_measured");
    if (result.status === "not_measured") {
      expect(result.reason).toContain("live delivery failed");
      // A failed first call charges the conservative worst case, so spend is captured.
      expect(result.spentUsd).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The compiler input is built only from reachable, synthetic items.
// ---------------------------------------------------------------------------

describe("live context arm builds a synthetic, tenant-scoped compiler input", () => {
  it("carries only the arm's reachable items and the synthetic tenant", () => {
    const scenario = MIGRATION_SCENARIO;
    const stage3 = scenario.tasks.find((t) => t.taskId === "stage3-depends-on-prior")!;
    const input = missionContextInputForTaskArm(scenario, stage3, "persistent");
    expect(input.tenantId).toBe("tenant-northwind");
    // Org memory records only ever carry this tenant.
    if (input.organizationMemory.consulted) {
      for (const record of input.organizationMemory.records) {
        expect(record.record.tenantId).toBe("tenant-northwind");
      }
    }
    // The stateless input for the same task has strictly fewer reachable items.
    const statelessInput = missionContextInputForTaskArm(scenario, stage3, "stateless");
    const countItems = (arm: ArmId) => availableItems(stage3, arm).length;
    expect(countItems("persistent")).toBeGreaterThan(countItems("stateless"));
    // Sanity: the stateless compiler input has no organization memory (stage 3's
    // memory is persistent-only).
    if (statelessInput.organizationMemory.consulted) {
      expect(statelessInput.organizationMemory.records.length).toBe(0);
    }
  });
});
