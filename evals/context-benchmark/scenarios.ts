/**
 * The benchmark cohort. Deliberately mixed so the harness cannot flatter
 * persistent context:
 *
 *   1. regauge-multistage-migration  — a 4-stage ReGauge migration carrying all
 *      six required elements (initial architecture decision, an exception found
 *      partway, a reviewer correction, a stage dependency, a verification result
 *      that gates the next stage, and an organization rule). Prior resolutions
 *      naturally live in mission history, so persistent context helps here.
 *   2. memory-oauth-controlled       — the memory-specific controlled case:
 *      Mission 1 a reviewer corrects direct OAuth to the internal auth client;
 *      Mission 2, same organization, similar task. Without org memory vs with
 *      confirmed org memory.
 *   3. context-inflation-control     — one real hazard buried in irrelevant,
 *      stale, and duplicated persistent items. Persistent context changes no
 *      outcome here but inflates tokens: "more context" must look like cost,
 *      not benefit.
 *   4. conflicting-context-harm      — a confirmed-but-wrong org memory. The
 *      persistent arm follows it and does WORSE than the stateless arm. The
 *      harness must be able to show persistent context being harmful.
 *
 * The naive default for every persistent-only hazard is a WRONG option: that is
 * what a stateless agent actually does when the resolving knowledge is not in
 * front of it. It is not a tuning knob; it is the definition of the cost of
 * statelessness. The correct options and the previously-resolved flags live in
 * TRUTH below, which the agent never sees.
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
// Scenario 1: regauge-multistage-migration
// ---------------------------------------------------------------------------

const MIGRATION_SCENARIO: BenchmarkScenario = {
  scenarioId: "regauge-multistage-migration",
  tenantId: TENANT,
  description:
    "A ReGauge internal modernization migrated across four stages. The architecture decision was set by a reviewer correction in stage 1; an exemption exception was found in stage 2; a reviewer corrected the auth abstraction in stage 2; stage 3 depends on the stage-1 architecture and on a stage-2 verification result; stage 4 must honor an organization timestamp rule.",
  tasks: [
    {
      // Stage 1: the architecture decision is ESTABLISHED via a reviewer
      // correction (inline-switch -> adapter-per-provider). Both arms resolve it
      // because the correction is immediate to this stage.
      taskId: "stage1-establish-architecture",
      stage: 1,
      instructionTokens: 220,
      hazards: [hazard("h1-arch-decision", "arch-adapter-pattern", ["adapter-per-provider", "inline-switch"], "inline-switch", "adapter")],
      context: [immediate("s1-i-arch", "arch-adapter-pattern", "adapter-per-provider", "mission_decision", 60)],
    },
    {
      // Stage 2: an exemption exception is discovered, and a reviewer corrects
      // the auth abstraction. Both immediate to this stage, so both arms resolve.
      taskId: "stage2-exception-and-correction",
      stage: 2,
      instructionTokens: 240,
      hazards: [
        hazard("h2-exempt-discovery", "legacy-module-exempt", ["migrate-billing-legacy", "skip-billing-legacy"], "migrate-billing-legacy"),
        hazard("h3-auth-correction", "oauth-abstraction", ["internal-auth-client", "direct-oauth"], "direct-oauth"),
      ],
      context: [
        immediate("s2-i-exempt", "legacy-module-exempt", "skip-billing-legacy", "mission_decision", 55),
        immediate("s2-i-auth", "oauth-abstraction", "internal-auth-client", "confirmed_org_memory", 58),
      ],
    },
    {
      // Stage 3: depends on the stage-1 architecture, on the stage-2 auth
      // correction, and on a stage-2 verification result. All of that lives ONLY
      // in the persistent envelope. A stateless agent re-decides from scratch.
      taskId: "stage3-depends-on-prior",
      stage: 3,
      instructionTokens: 260,
      hazards: [
        hazard("h4-auth-repeat", "oauth-abstraction", ["internal-auth-client", "direct-oauth"], "direct-oauth"),
        hazard("h5-arch-repeat", "arch-adapter-pattern", ["adapter-per-provider", "inline-switch"], "inline-switch", "adapter"),
        hazard("h6-verified-variant", "retry-wrapper-verified", ["use-retry-wrapper", "use-circuit-breaker"], "use-circuit-breaker"),
      ],
      context: [
        persistent("s3-p-auth", "oauth-abstraction", "internal-auth-client", "confirmed_org_memory", 62),
        persistent("s3-p-arch", "arch-adapter-pattern", "adapter-per-provider", "mission_decision", 60),
        persistent("s3-p-verify", "retry-wrapper-verified", "use-retry-wrapper", "mission_decision", 64),
      ],
    },
    {
      // Stage 4: must honor the stage-2 exemption exception and an organization
      // timestamp rule (a hard policy). Both live only in the persistent
      // envelope; a stateless agent re-migrates the exempt module and violates
      // the policy it never saw.
      taskId: "stage4-exception-and-policy",
      stage: 4,
      instructionTokens: 250,
      hazards: [
        hazard("h7-exempt-repeat", "legacy-module-exempt", ["migrate-billing-legacy", "skip-billing-legacy"], "migrate-billing-legacy"),
        hazard("h8-timestamp-policy", "timestamp-storage-format", ["text-iso", "epoch-int"], "epoch-int"),
      ],
      context: [
        persistent("s4-p-exempt", "legacy-module-exempt", "skip-billing-legacy", "mission_decision", 56),
        persistent("s4-p-timestamp", "timestamp-storage-format", "text-iso", "hard_policy", 66),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 2: memory-oauth-controlled (the memory-specific controlled case)
// ---------------------------------------------------------------------------

const MEMORY_CONTROLLED_SCENARIO: BenchmarkScenario = {
  scenarioId: "memory-oauth-controlled",
  tenantId: TENANT,
  description:
    "Mission 1: a reviewer corrects a direct OAuth implementation to the internal auth client. Mission 2: the same organization, a similar task. The persistent arm carries the Mission-1 correction as confirmed Organization Memory; the stateless arm does not.",
  tasks: [
    {
      // Mission 1: the correction is made here (immediate to the mission).
      taskId: "mission1-correction",
      stage: 1,
      instructionTokens: 210,
      hazards: [hazard("m1-auth", "auth-abstraction", ["internal-auth-client", "direct-oauth"], "direct-oauth")],
      context: [immediate("m1-i-auth", "auth-abstraction", "internal-auth-client", "confirmed_org_memory", 57)],
    },
    {
      // Mission 2: same hazard. Without org memory (stateless) the agent repeats
      // the direct-OAuth mistake and needs the same correction again. With
      // confirmed org memory (persistent) it chooses the internal auth client.
      taskId: "mission2-similar-task",
      stage: 2,
      instructionTokens: 205,
      hazards: [hazard("m2-auth", "auth-abstraction", ["internal-auth-client", "direct-oauth"], "direct-oauth")],
      context: [persistent("m2-p-auth", "auth-abstraction", "internal-auth-client", "confirmed_org_memory", 59)],
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
// ---------------------------------------------------------------------------

const TRUTH: Record<string, Omit<HazardTruth, "hazardId">> = {
  // Scenario 1.
  "h1-arch-decision": { correctOption: "adapter-per-provider", priorMistakeResolved: false, policyGoverned: false },
  "h2-exempt-discovery": { correctOption: "skip-billing-legacy", priorMistakeResolved: false, policyGoverned: false },
  "h3-auth-correction": { correctOption: "internal-auth-client", priorMistakeResolved: false, policyGoverned: false },
  "h4-auth-repeat": { correctOption: "internal-auth-client", priorMistakeResolved: true, policyGoverned: false },
  "h5-arch-repeat": { correctOption: "adapter-per-provider", priorMistakeResolved: true, policyGoverned: false },
  "h6-verified-variant": { correctOption: "use-retry-wrapper", priorMistakeResolved: false, policyGoverned: false },
  "h7-exempt-repeat": { correctOption: "skip-billing-legacy", priorMistakeResolved: false, policyGoverned: false },
  "h8-timestamp-policy": { correctOption: "text-iso", priorMistakeResolved: false, policyGoverned: true },
  // Scenario 2.
  "m1-auth": { correctOption: "internal-auth-client", priorMistakeResolved: false, policyGoverned: false },
  "m2-auth": { correctOption: "internal-auth-client", priorMistakeResolved: true, policyGoverned: false },
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
