/**
 * The benchmark cohort. Deliberately mixed so the harness cannot flatter
 * persistent context.
 *
 * WHY THE SCENARIOS LOOK THE WAY THEY DO (the discriminating-fact redesign).
 * -------------------------------------------------------------------------
 * An earlier cohort encoded decisions that were good engineering DEFAULTS
 * (internal-auth-client over direct-oauth, the adapter pattern over an inline
 * switch, a retry wrapper over a circuit breaker). A capable model reaches those
 * unaided, so the live run measured the model's PRIORS, not the value of
 * inherited context: the stateless arm repeated 0 of 3 previously-resolved
 * mistakes, collapsing the headline (docs research §5.2).
 *
 * These scenarios instead turn on ARBITRARY organizational conventions. For each
 * headline hazard, both options are real, roughly equally defensible engineering
 * choices, and only the organization's prior decision separates them. The
 * distinguishing fact is not recoverable from the immediate context: calibration
 * (evals/context-benchmark/calibrate.ts) put each stateless prompt to the real
 * model `muse-spark-1.2-contributor` eight times and recorded how often it picked
 * the option the organization actually chose:
 *
 *   primary-id-format   -> ulid       stateless P(resolved) 0.000 (model prefers uuid-v7)
 *   json-field-naming   -> snake_case stateless P(resolved) 0.000 (model prefers camelCase)
 *   default-cloud-region-> eu-west-1  stateless P(resolved) 0.000 (model prefers us-east-1)
 *   uuid-db-storage     -> text-36    stateless P(resolved) 0.125 (model prefers binary-16)
 *   service-config-format-> toml      stateless P(resolved) 0.250 (model prefers yaml)
 *
 * In every case the persistent prompt (the convention rendered by the real
 * compiler) was followed 8/8 (P(resolved) 1.000), so the persistent arm is not
 * itself guessing. The model tracked option POPULARITY, not the organization's
 * decision, which is exactly why a stateless agent cannot recover an arbitrary
 * convention and why inheriting it has value. Candidates the model already
 * recovered unaided (timestamp iso 0.875, enum string-label 0.875, soft-delete
 * timestamp 1.000, api-version url-path 1.000) were DISCARDED as non-arbitrary /
 * non-discriminating; see the research doc for the full calibration table.
 *
 *   1. regauge-convention-migration — a ReGauge internal modernization. Stage 1
 *      establishes five arbitrary conventions via immediate reviewer corrections,
 *      mission decisions, and a residency policy (both arms see them). Stage 2
 *      re-applies the SAME five conventions downstream, where the resolving
 *      knowledge lives ONLY in the persistent envelope. A stateless agent
 *      re-decides from its priors and, for an arbitrary convention, picks the
 *      option the organization did not choose.
 *   2. memory-convention-controlled — the memory-specific controlled case:
 *      Mission 1 a reviewer records the id-format convention (ulid); Mission 2,
 *      same organization, a similar task. Without org memory vs with confirmed
 *      org memory, isolated to one hazard.
 *   3. context-inflation-control — one real hazard buried in irrelevant, stale,
 *      and duplicated persistent items. Persistent context changes no outcome
 *      here but inflates tokens: "more context" must look like cost, not benefit.
 *   4. conflicting-context-harm — a confirmed-but-wrong org memory. The persistent
 *      arm follows it and does WORSE than the stateless arm. Kept unchanged: the
 *      real compiler applies that memory too, so it is faithful behaviour, not an
 *      artifact.
 *
 * The naive default for every persistent-only hazard is a WRONG option (the
 * option the organization did NOT choose): that is what a stateless agent does
 * when the resolving knowledge is not in front of it. It is not a tuning knob; it
 * is the definition of the cost of statelessness. The correct options and the
 * previously-resolved flags live in TRUTH below, which the agent never sees.
 */
import {
  cohortDigest,
  type BenchmarkScenario,
  type Hazard,
  type KnowledgeItem,
  type HazardTruth,
  type SealedKey,
} from "./context-benchmark.js";

const TENANT = "tenant-northwind";

// Small builders keep the scenarios readable and prevent field-order mistakes.
function immediate(itemId: string, resolutionKey: string, recommends: string, layer: KnowledgeItem["layer"], tokens: number): KnowledgeItem {
  return { itemId, resolutionKey, recommends, layer, bucket: "immediate", status: "active", tokens };
}
function persistent(itemId: string, resolutionKey: string, recommends: string, layer: KnowledgeItem["layer"], tokens: number, status: KnowledgeItem["status"] = "active"): KnowledgeItem {
  return { itemId, resolutionKey, recommends, layer, bucket: "persistent", status, tokens };
}
function hazard(hazardId: string, resolutionKey: string, options: string[], naiveDefault: string, consistencyGroup = ""): Hazard {
  return { hazardId, resolutionKey, options, naiveDefault, consistencyGroup };
}

// ---------------------------------------------------------------------------
// Scenario 1: regauge-convention-migration
//
// Five arbitrary conventions, each established immediately in stage 1 (both arms
// resolve) and re-applied in stage 2 where the resolving item is persistent-only
// (only the persistent arm resolves; the stateless arm falls to the wrong naive
// default). Every stage-2 hazard is a previously-resolved mistake (the headline
// denominator). Options are calibrated to be arbitrary — see the header table.
// ---------------------------------------------------------------------------

const MIGRATION_SCENARIO: BenchmarkScenario = {
  scenarioId: "regauge-convention-migration",
  tenantId: TENANT,
  description:
    "A ReGauge internal modernization migrated across two stages. Stage 1 establishes five arbitrary organizational conventions (id format, JSON field naming, config format, UUID column storage, and a data-residency region policy) via immediate reviewer corrections, mission decisions, and a hard policy. Stage 2 re-applies the same five conventions downstream, where the resolving knowledge lives only in the persistent envelope; a stateless agent re-decides from its priors and picks the option the organization did not choose.",
  tasks: [
    {
      // Stage 1: the five conventions are ESTABLISHED via immediate context, so
      // BOTH arms resolve them here. None is a previously-resolved mistake yet.
      taskId: "stage1-establish-conventions",
      stage: 1,
      instructionTokens: 240,
      hazards: [
        hazard("h1-id", "primary-id-format", ["ulid", "uuid-v7"], "uuid-v7", "id-scheme"),
        hazard("h2-jsoncase", "json-field-naming", ["camelCase", "snake_case"], "camelCase"),
        hazard("h3-config", "service-config-format", ["toml", "yaml"], "yaml"),
        hazard("h4-uuidstore", "uuid-db-storage", ["binary-16", "text-36"], "binary-16"),
        hazard("h5-region", "default-cloud-region", ["eu-west-1", "us-east-1"], "us-east-1"),
      ],
      context: [
        immediate("s1-i-id", "primary-id-format", "ulid", "confirmed_org_memory", 58),
        immediate("s1-i-jsoncase", "json-field-naming", "snake_case", "mission_decision", 56),
        immediate("s1-i-config", "service-config-format", "toml", "mission_decision", 55),
        immediate("s1-i-uuidstore", "uuid-db-storage", "text-36", "confirmed_org_memory", 57),
        immediate("s1-i-region", "default-cloud-region", "eu-west-1", "hard_policy", 62),
      ],
    },
    {
      // Stage 2: the SAME five conventions re-appear downstream. The resolving
      // items live ONLY in the persistent envelope, so a stateless agent
      // re-decides from scratch. Each is a previously-resolved mistake (headline).
      // The id hazard shares the "id-scheme" consistency group with stage 1.
      taskId: "stage3-depends-on-prior",
      stage: 2,
      instructionTokens: 260,
      hazards: [
        hazard("h6-id-repeat", "primary-id-format", ["ulid", "uuid-v7"], "uuid-v7", "id-scheme"),
        hazard("h7-jsoncase-repeat", "json-field-naming", ["camelCase", "snake_case"], "camelCase"),
        hazard("h8-config-repeat", "service-config-format", ["toml", "yaml"], "yaml"),
        hazard("h9-uuidstore-repeat", "uuid-db-storage", ["binary-16", "text-36"], "binary-16"),
        hazard("h10-region-repeat", "default-cloud-region", ["eu-west-1", "us-east-1"], "us-east-1"),
      ],
      context: [
        persistent("s2-p-id", "primary-id-format", "ulid", "confirmed_org_memory", 60),
        persistent("s2-p-jsoncase", "json-field-naming", "snake_case", "mission_decision", 58),
        persistent("s2-p-config", "service-config-format", "toml", "mission_decision", 57),
        persistent("s2-p-uuidstore", "uuid-db-storage", "text-36", "confirmed_org_memory", 59),
        persistent("s2-p-region", "default-cloud-region", "eu-west-1", "hard_policy", 64),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 2: memory-convention-controlled (the memory-specific controlled case)
// ---------------------------------------------------------------------------

const MEMORY_CONTROLLED_SCENARIO: BenchmarkScenario = {
  scenarioId: "memory-convention-controlled",
  tenantId: TENANT,
  description:
    "Mission 1: a reviewer records the organization's id-format convention (ulid, chosen over the more common uuid-v7). Mission 2: the same organization, a similar task. The persistent arm carries the Mission-1 decision as confirmed Organization Memory; the stateless arm does not and re-decides from its priors.",
  tasks: [
    {
      // Mission 1: the convention is recorded here (immediate to the mission).
      taskId: "mission1-correction",
      stage: 1,
      instructionTokens: 210,
      hazards: [hazard("m1-id", "primary-id-format", ["ulid", "uuid-v7"], "uuid-v7")],
      context: [immediate("m1-i-id", "primary-id-format", "ulid", "confirmed_org_memory", 57)],
    },
    {
      // Mission 2: same hazard. Without org memory (stateless) the agent re-decides
      // from its priors (uuid-v7) and needs the convention re-issued. With
      // confirmed org memory (persistent) it chooses ulid.
      taskId: "mission2-similar-task",
      stage: 2,
      instructionTokens: 205,
      hazards: [hazard("m2-id", "primary-id-format", ["ulid", "uuid-v7"], "uuid-v7")],
      context: [persistent("m2-p-id", "primary-id-format", "ulid", "confirmed_org_memory", 59)],
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 3: context-inflation-control (more context is not better)
// ---------------------------------------------------------------------------

const CONTEXT_INFLATION_SCENARIO: BenchmarkScenario = {
  scenarioId: "context-inflation-control",
  tenantId: TENANT,
  description:
    "One real naming-convention hazard whose resolution lives in a confirmed memory, surrounded by irrelevant, stale, and duplicated persistent items. The persistent arm gets the one hazard right but pays a large token cost for context that changes no outcome.",
  tasks: [
    {
      taskId: "inflation-single-hazard",
      stage: 1,
      instructionTokens: 200,
      hazards: [hazard("i1-naming", "naming-convention", ["snake-case", "camel-case"], "camel-case")],
      context: [
        // The one item that matters.
        persistent("inf-p-real", "naming-convention", "snake-case", "confirmed_org_memory", 60),
        // Irrelevant: keys that match no hazard in this task. Large tokens.
        persistent("inf-p-irr-1", "unused-topic-a", "whatever-a", "confirmed_org_memory", 480),
        persistent("inf-p-irr-2", "unused-topic-b", "whatever-b", "user_preference", 520),
        persistent("inf-p-irr-3", "unused-topic-c", "whatever-c", "inferred_candidate", 500),
        // Stale: right key, but stale, so excluded from resolution.
        persistent("inf-p-stale-1", "naming-convention", "snake-case", "confirmed_org_memory", 300, "stale"),
        persistent("inf-p-stale-2", "naming-convention", "camel-case", "user_preference", 320, "stale"),
        // Duplicated: exact fingerprint of inf-p-irr-1 (same key+layer+recommends+status).
        persistent("inf-p-dup-1", "unused-topic-a", "whatever-a", "confirmed_org_memory", 480),
        persistent("inf-p-dup-2", "unused-topic-a", "whatever-a", "confirmed_org_memory", 480),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 4: conflicting-context-harm (persistent context can be worse)
// ---------------------------------------------------------------------------

const CONFLICTING_CONTEXT_SCENARIO: BenchmarkScenario = {
  scenarioId: "conflicting-context-harm",
  tenantId: TENANT,
  description:
    "A confirmed Organization Memory that is wrong for this task. The stateless arm's naive default happens to be correct; the persistent arm follows the confirmed-but-wrong memory and is corrected. Persistent context makes the outcome worse here.",
  tasks: [
    {
      taskId: "conflicting-single-hazard",
      stage: 1,
      instructionTokens: 200,
      hazards: [hazard("c1-region", "region-routing", ["eu-region", "us-region"], "eu-region")],
      context: [
        // A confirmed memory that recommends the WRONG option for this task.
        persistent("conf-p-wrong", "region-routing", "us-region", "confirmed_org_memory", 61),
      ],
    },
  ],
};

export const COHORT: readonly BenchmarkScenario[] = [
  MIGRATION_SCENARIO,
  MEMORY_CONTROLLED_SCENARIO,
  CONTEXT_INFLATION_SCENARIO,
  CONFLICTING_CONTEXT_SCENARIO,
];

export {
  MIGRATION_SCENARIO,
  MEMORY_CONTROLLED_SCENARIO,
  CONTEXT_INFLATION_SCENARIO,
  CONFLICTING_CONTEXT_SCENARIO,
};

// ---------------------------------------------------------------------------
// The sealed answer key. Held separate from the cohort so the cohort carries no
// answer material. `priorMistakeResolved` marks the hazards that make up the
// headline denominator (a mistake the organization already paid to resolve).
// The correctOption is always the organization's ACTUAL decision (a calibrated
// arbitrary convention), never "the option we prefer".
// ---------------------------------------------------------------------------

const TRUTH: Record<string, Omit<HazardTruth, "hazardId">> = {
  // Scenario 1 stage 1 (established immediately; both arms resolve; not headline).
  "h1-id": { correctOption: "ulid", priorMistakeResolved: false, policyGoverned: false },
  "h2-jsoncase": { correctOption: "snake_case", priorMistakeResolved: false, policyGoverned: false },
  "h3-config": { correctOption: "toml", priorMistakeResolved: false, policyGoverned: false },
  "h4-uuidstore": { correctOption: "text-36", priorMistakeResolved: false, policyGoverned: false },
  "h5-region": { correctOption: "eu-west-1", priorMistakeResolved: false, policyGoverned: false },
  // Scenario 1 stage 2 (resolved only in the persistent envelope; HEADLINE).
  "h6-id-repeat": { correctOption: "ulid", priorMistakeResolved: true, policyGoverned: false },
  "h7-jsoncase-repeat": { correctOption: "snake_case", priorMistakeResolved: true, policyGoverned: false },
  "h8-config-repeat": { correctOption: "toml", priorMistakeResolved: true, policyGoverned: false },
  "h9-uuidstore-repeat": { correctOption: "text-36", priorMistakeResolved: true, policyGoverned: false },
  "h10-region-repeat": { correctOption: "eu-west-1", priorMistakeResolved: true, policyGoverned: true },
  // Scenario 2.
  "m1-id": { correctOption: "ulid", priorMistakeResolved: false, policyGoverned: false },
  "m2-id": { correctOption: "ulid", priorMistakeResolved: true, policyGoverned: false },
  // Scenario 3.
  "i1-naming": { correctOption: "snake-case", priorMistakeResolved: false, policyGoverned: false },
  // Scenario 4.
  "c1-region": { correctOption: "eu-region", priorMistakeResolved: false, policyGoverned: false },
};

/**
 * Build a sealed key for exactly the hazards in `scenarios`, stamped with the
 * matching cohort digest. Grading any subset (for example the controlled case
 * alone) uses this so the key and cohort always pair by digest.
 */
export function sealedKeyFor(scenarios: readonly BenchmarkScenario[]): SealedKey {
  const truth: HazardTruth[] = [];
  for (const s of scenarios) {
    for (const t of s.tasks) {
      for (const h of t.hazards) {
        const row = TRUTH[h.hazardId];
        if (!row) throw new Error(`missing_truth_for_hazard:${h.hazardId}`);
        truth.push({ hazardId: h.hazardId, ...row });
      }
    }
  }
  return { cohortDigest: cohortDigest(scenarios), truth };
}

export const SEALED_KEY: SealedKey = sealedKeyFor(COHORT);
