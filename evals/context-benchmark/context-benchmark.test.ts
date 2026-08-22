/**
 * Controls for the stateless-versus-persistent context benchmark. Every test
 * here guards one property the benchmark's integrity depends on, and names the
 * control that dies if it is removed. The comment "// CONTROL:" marks which line
 * of production code the test is protecting, so a reviewer can revert that line,
 * watch this test fail, and restore it.
 */
import { describe, it, expect } from "vitest";
import {
  stageBenchmark,
  gradeBenchmark,
  evaluateGates,
  availableItems,
  chooseOption,
  cohortDigest,
  rate,
  ARM_IDS,
  type BenchmarkScenario,
  type BenchmarkReport,
  type SealedKey,
  type StagedBenchmark,
  type HazardTruth,
  type KnowledgeItem,
} from "./context-benchmark.js";
import {
  COHORT,
  SEALED_KEY,
  sealedKeyFor,
  MIGRATION_SCENARIO,
  MEMORY_CONTROLLED_SCENARIO,
  CONTEXT_INFLATION_SCENARIO,
  CONFLICTING_CONTEXT_SCENARIO,
} from "./scenarios.js";

const TENANT = "tenant-northwind";

function run(scenarios: readonly BenchmarkScenario[], key: SealedKey): BenchmarkReport {
  const staged = stageBenchmark(scenarios);
  return gradeBenchmark(scenarios, staged, key);
}

// ---------------------------------------------------------------------------
// Not-measured on a zero denominator, never a flattering value.
// ---------------------------------------------------------------------------

describe("zero-denominator metrics are not-measured, never 1 or 0", () => {
  it("rate() returns not-measured with a reason on a zero denominator", () => {
    // CONTROL: rate() `denominator === 0` -> notMeasured. If it returned 1 or 0
    // an arm that measured nothing would read as perfect or as a real zero.
    const r = rate(0, 0, "empty");
    expect(r.measured).toBe(false);
    if (!r.measured) expect(r.reason).toBe("empty");
    expect(rate(3, 0, "x").measured).toBe(false);
  });

  it("an arm with no previously-resolved mistakes reports repeated-mistake rate not-measured", () => {
    // The inflation scenario has zero priorMistakeResolved hazards, so the
    // headline denominator is zero for BOTH arms and must be not-measured.
    const report = run([CONTEXT_INFLATION_SCENARIO], sealedKeyFor([CONTEXT_INFLATION_SCENARIO]));
    expect(report.arms.stateless.repeatedMistakeRate.measured).toBe(false);
    expect(report.arms.persistent.repeatedMistakeRate.measured).toBe(false);
    expect(report.headline.repeatsAvoidedByPersistentContext.measured).toBe(false);
  });

  it("an empty cohort throws rather than grading cleanly to a flattering zero", () => {
    // CONTROL: gradeBenchmark `context_benchmark_empty_cohort`.
    const staged = stageBenchmark([]);
    expect(() => gradeBenchmark([], staged, { cohortDigest: cohortDigest([]), truth: [] })).toThrow(/empty_cohort/);
  });
});

// ---------------------------------------------------------------------------
// An arm that produces nothing scores not-measured, never flattering (gate G1).
// ---------------------------------------------------------------------------

describe("an arm that graded nothing fails the gate as not-measured", () => {
  it("G1 reports NOT_MEASURED (which is FAIL) when an arm graded zero hazards", () => {
    const staged = stageBenchmark(COHORT);
    const report = gradeBenchmark(COHORT, staged, SEALED_KEY);
    // Force one arm to have graded nothing, as a truncated run would.
    const holed: BenchmarkReport = {
      ...report,
      arms: { ...report.arms, stateless: { ...report.arms.stateless, hazardsGraded: 0 } },
    };
    const verdict = evaluateGates(COHORT, holed, staged);
    // CONTROL: evaluateGates G1 `hazardsGraded > 0` and the not-measured->FAIL fold.
    const g1 = verdict.gates.find((g) => g.id === "arm_measured_something:stateless");
    expect(g1?.status).toBe("NOT_MEASURED");
    expect(verdict.overall).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Leak-proofing: Arm A cannot recover Arm B's inherited context by any route.
// ---------------------------------------------------------------------------

describe("the stateless arm cannot recover persistent context by any route", () => {
  it("availableItems(stateless) never returns a persistent item", () => {
    // CONTROL: availableItems stateless filter `bucket === "immediate"`.
    for (const scenario of COHORT) {
      for (const task of scenario.tasks) {
        const items = availableItems(task, "stateless");
        expect(items.every((i) => i.bucket === "immediate")).toBe(true);
      }
    }
  });

  it("stateless choices are identical whether or not a persistent bucket exists", () => {
    // The definitive test: strip every persistent item from the cohort and the
    // stateless staged choices are byte-identical. So the stateless arm's output
    // depends only on the immediate bucket; persistent context is unreachable.
    const stripped = COHORT.map((s) => ({
      ...s,
      tasks: s.tasks.map((t) => ({ ...t, context: t.context.filter((i) => i.bucket === "immediate") })),
    }));
    const withPersistent = stageBenchmark(COHORT).choices.filter((c) => c.arm === "stateless").map((c) => `${c.scenarioId}/${c.hazardId}=${c.chosenOption}`);
    const withoutPersistent = stageBenchmark(stripped).choices.filter((c) => c.arm === "stateless").map((c) => `${c.scenarioId}/${c.hazardId}=${c.chosenOption}`);
    expect(withoutPersistent).toEqual(withPersistent);
  });

  it("the leak gate (G3) FAILS on a staged artifact where a stateless choice reached a persistent item", () => {
    const staged = stageBenchmark(COHORT);
    const report = gradeBenchmark(COHORT, staged, SEALED_KEY);
    // Forge a leak: give a stateless choice a persistent item id in its reach.
    const persistentId = "s2-p-id"; // a known persistent item from scenario 1 (stage 2)
    const forged: StagedBenchmark = {
      ...staged,
      choices: staged.choices.map((c, idx) =>
        idx === staged.choices.findIndex((x) => x.arm === "stateless")
          ? { ...c, reachableItemIds: [...c.reachableItemIds, persistentId] }
          : c,
      ),
    };
    // CONTROL: evaluateGates G3 recomputes the persistent-id set and checks reach.
    const verdict = evaluateGates(COHORT, report, forged);
    const g3 = verdict.gates.find((g) => g.id === "leak_proof");
    expect(g3?.status).toBe("FAIL");
    expect(verdict.overall).toBe("FAIL");
  });

  it("the leak gate PASSES on the honest staged artifact", () => {
    const staged = stageBenchmark(COHORT);
    const report = gradeBenchmark(COHORT, staged, SEALED_KEY);
    const verdict = evaluateGates(COHORT, report, staged);
    expect(verdict.gates.find((g) => g.id === "leak_proof")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// The agent is arm-blind and truth-blind.
// ---------------------------------------------------------------------------

describe("the agent conditions only on reachable context, never on the arm or the answer", () => {
  it("staged choices do not depend on the sealed key (staging never sees it)", () => {
    // Grade the same staged artifact with the true key and with a key whose
    // correct options are all flipped. The staged CHOICES are identical; only
    // the grade changes. So the agent cannot have peeked at the answer.
    const staged = stageBenchmark(COHORT);
    const flipped: SealedKey = {
      cohortDigest: SEALED_KEY.cohortDigest,
      truth: SEALED_KEY.truth.map((t) => ({ ...t, correctOption: `${t.correctOption}-FLIPPED` })),
    };
    const a = gradeBenchmark(COHORT, staged, SEALED_KEY);
    const b = gradeBenchmark(COHORT, staged, flipped);
    // Same staged artifact underlies both, and staging is deterministic.
    expect(a.stagedDigest).toBe(b.stagedDigest);
    // With every answer flipped, the stateless arm's correctness must change,
    // proving the grade reads the key while the staged choices do not.
    expect(a.arms.stateless.taskCorrectness).not.toEqual(b.arms.stateless.taskCorrectness);
  });

  it("identical reachable context yields the identical choice regardless of arm", () => {
    // On a task with only immediate items both arms reach the same set, so both
    // must choose identically — the arm name changes nothing.
    const task = MIGRATION_SCENARIO.tasks[0]!; // stage1: immediate-only
    const stateless = availableItems(task, "stateless");
    const persistent = availableItems(task, "persistent");
    for (const hazard of task.hazards) {
      expect(chooseOption(TENANT, hazard, stateless)).toBe(chooseOption(TENANT, hazard, persistent));
    }
  });

  it("uses the real precedence resolver: a hard policy beats a conflicting confirmed memory", () => {
    // CONTROL: chooseOption delegates to resolveOrganizationDecision. A hazard
    // with a correct hard policy AND a wrong confirmed memory must resolve to
    // the policy — memory can never override policy.
    const items: KnowledgeItem[] = [
      { itemId: "pol", resolutionKey: "k", recommends: "correct", layer: "hard_policy", bucket: "persistent", status: "active", tokens: 1 },
      { itemId: "mem", resolutionKey: "k", recommends: "wrong", layer: "confirmed_org_memory", bucket: "persistent", status: "active", tokens: 1 },
    ];
    const hazard = { hazardId: "h", resolutionKey: "k", options: ["correct", "wrong"], naiveDefault: "wrong", consistencyGroup: "" };
    expect(chooseOption(TENANT, hazard, items)).toBe("correct");
  });

  it("excludes stale items from resolution", () => {
    // CONTROL: precedenceInputFor filters `status === "active"`.
    const items: KnowledgeItem[] = [
      { itemId: "stale", resolutionKey: "k", recommends: "stale-says", layer: "confirmed_org_memory", bucket: "persistent", status: "stale", tokens: 1 },
    ];
    const hazard = { hazardId: "h", resolutionKey: "k", options: ["stale-says", "default"], naiveDefault: "default", consistencyGroup: "" };
    // With only a stale item, nothing governs, so the agent falls to the default.
    expect(chooseOption(TENANT, hazard, items)).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Case identifiers carry no signal.
// ---------------------------------------------------------------------------

describe("case identifiers and ordering carry no signal", () => {
  it("renaming every id and reordering everything leaves the arm metrics identical", () => {
    // Deterministically remap every scenario/task/hazard/item id, and reverse
    // all orderings. The report's numbers must not move: the grader joins by id
    // and canonicalizes, so parity/ordering of ids cannot encode an answer (the
    // Graphify case-id-parity leak).
    const remap = (id: string): string => `z-${id.split("").reverse().join("")}-z`;
    const remapped: BenchmarkScenario[] = [...COHORT].reverse().map((s) => ({
      ...s,
      scenarioId: remap(s.scenarioId),
      tasks: [...s.tasks].reverse().map((t) => ({
        ...t,
        taskId: remap(t.taskId),
        hazards: [...t.hazards].reverse().map((h) => ({ ...h, hazardId: remap(h.hazardId) })),
        context: [...t.context].reverse().map((i) => ({ ...i, itemId: remap(i.itemId) })),
      })),
    }));
    // Rebuild the sealed key by the same id remap.
    const remappedTruth: HazardTruth[] = SEALED_KEY.truth.map((t) => ({ ...t, hazardId: remap(t.hazardId) }));
    const remappedKey: SealedKey = { cohortDigest: cohortDigest(remapped), truth: remappedTruth };

    const original = run(COHORT, SEALED_KEY);
    const shuffled = run(remapped, remappedKey);
    for (const arm of ARM_IDS) {
      expect(shuffled.arms[arm].taskCorrectness).toEqual(original.arms[arm].taskCorrectness);
      expect(shuffled.arms[arm].repeatedMistakeCount).toBe(original.arms[arm].repeatedMistakeCount);
      expect(shuffled.arms[arm].humanCorrections).toBe(original.arms[arm].humanCorrections);
      expect(shuffled.arms[arm].contextQuality).toEqual(original.arms[arm].contextQuality);
    }
    expect(shuffled.headline.repeatsAvoidedByPersistentContext).toEqual(original.headline.repeatsAvoidedByPersistentContext);
  });
});

// ---------------------------------------------------------------------------
// The anti-Graphify control: equalize context and the advantage goes to zero.
// ---------------------------------------------------------------------------

describe("equalizing context drives the advantage to exactly zero", () => {
  it("moving every persistent item to the immediate bucket makes the arms identical", () => {
    // If the migration scenario's persistent context is made visible to BOTH
    // arms, the stateless advantage must vanish: no repeats avoided, equal
    // correctness. This proves the measured delta is caused by context
    // PLACEMENT and nothing else — the Graphify failure cannot be hiding here.
    const equalized: BenchmarkScenario[] = [MIGRATION_SCENARIO].map((s) => ({
      ...s,
      tasks: s.tasks.map((t) => ({ ...t, context: t.context.map((i) => ({ ...i, bucket: "immediate" as const })) })),
    }));
    const report = run(equalized, sealedKeyFor(equalized));
    expect(report.headline.repeatsAvoidedByPersistentContext).toEqual({ measured: true, value: 0 });
    expect(report.arms.stateless.taskCorrectness).toEqual(report.arms.persistent.taskCorrectness);
    expect(report.arms.stateless.repeatedMistakeCount).toBe(report.arms.persistent.repeatedMistakeCount);
  });
});

// ---------------------------------------------------------------------------
// Inflated / stale / conflicting context is COUNTED, not ignored.
// ---------------------------------------------------------------------------

describe("more context is measured as cost or harm, never neutral-by-omission", () => {
  it("irrelevant persistent context is counted as irrelevant and inflates tokens without changing the outcome", () => {
    // CONTROL: classifyContextQuality irrelevant branch.
    const report = run([CONTEXT_INFLATION_SCENARIO], sealedKeyFor([CONTEXT_INFLATION_SCENARIO]));
    const q = report.arms.persistent.contextQuality;
    expect(q.irrelevant).toBe(5);
    expect(q.relevant).toBe(1);
    // Big token inflation for one real item: persistent pays far more than stateless.
    expect(report.arms.persistent.contextTokens).toBeGreaterThan(report.arms.stateless.contextTokens * 5);
    // Yet the headline is not-measured here (no previously-resolved mistakes),
    // so the inflation buys no headline improvement.
    expect(report.headline.repeatsAvoidedByPersistentContext.measured).toBe(false);
  });

  it("conflicting persistent context makes the persistent arm WORSE than the stateless arm", () => {
    // CONTROL: classifyContextQuality conflicting branch + real precedence use.
    const report = run([CONFLICTING_CONTEXT_SCENARIO], sealedKeyFor([CONFLICTING_CONTEXT_SCENARIO]));
    expect(report.arms.persistent.contextQuality.conflicting).toBe(1);
    // Stateless got it right (naive default), persistent followed the wrong memory.
    expect(report.arms.stateless.taskCorrectness).toEqual({ measured: true, value: 1 });
    expect(report.arms.persistent.taskCorrectness).toEqual({ measured: true, value: 0 });
  });

  it("stale and conflicting are counted as DISTINCT categories on one scenario", () => {
    // A single hazard carrying both a stale item and a conflicting item must
    // report stale>0 AND conflicting>0 separately, never merged into one bucket.
    const both: BenchmarkScenario = {
      scenarioId: "stale-and-conflicting",
      tenantId: TENANT,
      description: "one hazard with a stale item and a conflicting item",
      tasks: [
        {
          taskId: "t",
          stage: 1,
          instructionTokens: 100,
          hazards: [{ hazardId: "sc-h", resolutionKey: "k", options: ["right", "wrong"], naiveDefault: "right", consistencyGroup: "" }],
          context: [
            { itemId: "sc-stale", resolutionKey: "k", recommends: "wrong", layer: "confirmed_org_memory", bucket: "persistent", status: "stale", tokens: 10 },
            { itemId: "sc-conflict", resolutionKey: "k", recommends: "wrong", layer: "user_preference", bucket: "persistent", status: "active", tokens: 10 },
          ],
        },
      ],
    };
    const key: SealedKey = { cohortDigest: cohortDigest([both]), truth: [{ hazardId: "sc-h", correctOption: "right", priorMistakeResolved: false, policyGoverned: false }] };
    const report = run([both], key);
    const q = report.arms.persistent.contextQuality;
    expect(q.stale).toBe(1);
    expect(q.conflicting).toBe(1);
    expect(q.stale + q.conflicting).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Gate G4 (context accounting) can fail; cohort/key digests are bound.
// ---------------------------------------------------------------------------

describe("the accounting gate can fail, and the cohort/key are cryptographically bound", () => {
  it("G4 FAILS when the context categories do not partition the total", () => {
    const staged = stageBenchmark(COHORT);
    const report = gradeBenchmark(COHORT, staged, SEALED_KEY);
    const broken: BenchmarkReport = {
      ...report,
      arms: {
        ...report.arms,
        persistent: {
          ...report.arms.persistent,
          contextQuality: { ...report.arms.persistent.contextQuality, irrelevant: report.arms.persistent.contextQuality.irrelevant + 3 },
        },
      },
    };
    const verdict = evaluateGates(COHORT, broken, staged);
    expect(verdict.gates.find((g) => g.id === "context_quality_reconciles")?.status).toBe("FAIL");
    expect(verdict.overall).toBe("FAIL");
  });

  it("grading a truncated cohort against the full key throws a digest mismatch", () => {
    // CONTROL: gradeBenchmark cohort/key digest binding. Dropping a scenario
    // changes the cohort digest, so the full key no longer pairs.
    const truncated = COHORT.slice(0, COHORT.length - 1);
    const staged = stageBenchmark(truncated);
    expect(() => gradeBenchmark(truncated, staged, SEALED_KEY)).toThrow(/cohort_mismatch/);
  });

  it("a key missing a hazard's truth throws a key mismatch, not a silent skip", () => {
    // CONTROL: gradeBenchmark `key.truth.length !== allHazards.length` check.
    const staged = stageBenchmark([MEMORY_CONTROLLED_SCENARIO]);
    const shortKey: SealedKey = {
      cohortDigest: cohortDigest([MEMORY_CONTROLLED_SCENARIO]),
      truth: sealedKeyFor([MEMORY_CONTROLLED_SCENARIO]).truth.slice(0, 1),
    };
    expect(() => gradeBenchmark([MEMORY_CONTROLLED_SCENARIO], staged, shortKey)).toThrow(/key_mismatch/);
  });
});

// ---------------------------------------------------------------------------
// The full-cohort result the doc reports.
// ---------------------------------------------------------------------------

describe("the full-cohort result is stable and honest", () => {
  it("reproduces the headline the research doc records", () => {
    const report = run(COHORT, SEALED_KEY);
    // The deterministic ceiling: the modeled stateless agent repeats every one of
    // the six previously-resolved arbitrary conventions; the persistent arm repeats
    // none. (Headline denominator: 5 in scenario 1 stage 2 + 1 in scenario 2.)
    expect(report.headline.statelessRepeatedMistakeRate).toEqual({ measured: true, value: 1 });
    expect(report.headline.persistentRepeatedMistakeRate).toEqual({ measured: true, value: 0 });
    expect(report.headline.repeatsAvoidedByPersistentContext).toEqual({ measured: true, value: 6 });
    // Persistent is better overall but NOT perfect: it loses the conflicting scenario.
    // 14 hazards total: persistent gets 13 (loses only conflicting-context-harm);
    // stateless gets 7 (the six established/immediate hazards + the conflicting
    // scenario's naive default, which happens to be correct).
    expect(report.arms.persistent.taskCorrectness).toEqual({ measured: true, value: 13 / 14 });
    expect(report.arms.stateless.taskCorrectness).toEqual({ measured: true, value: 7 / 14 });
    // Persistent pays for it in tokens.
    expect(report.arms.persistent.contextTokens).toBeGreaterThan(report.arms.stateless.contextTokens);
    // The full-cohort gates pass.
    const staged = stageBenchmark(COHORT);
    expect(evaluateGates(COHORT, report, staged).overall).toBe("PASS");
  });

  it("time and cost are always not-measured with a stated reason (no live model)", () => {
    const report = run(COHORT, SEALED_KEY);
    for (const arm of ARM_IDS) {
      expect(report.arms[arm].timeToCompletionMs.measured).toBe(false);
      expect(report.arms[arm].costUsd.measured).toBe(false);
      expect(report.arms[arm].modelCalls).toBe(0);
    }
  });
});
