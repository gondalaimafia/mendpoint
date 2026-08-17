/**
 * Phase 13 / 14 — scenario families expanded by mutation, and their
 * counterfactuals.
 *
 * Each family converts ONE discovered defect class into a set of sibling
 * scenarios by MUTATING a seeded healthy repo (never by hand-copying), and emits
 * the answer key automatically from what the mutation changed. Families are
 * grounded in defects the suite actually found:
 *
 *   - `$ref` blindness           -> ref nested two deep, through allOf, ref-to-ref
 *   - ambiguity                  -> two / three successors, two with a decoy type
 *   - generated / vendored code  -> generated only, vendored only, both, and a
 *                                   file that merely LOOKS generated (must flag)
 *   - dependency runtime bump    -> supported bump, unsupported bump (coverage
 *                                   gap), and an already-migrated counterfactual
 *
 * Every significant Fettler family also gets a COUNTERFACTUAL (Phase 14): a
 * near-identical repo where the issue is absent, so a finding there is a scored
 * false positive.
 */
import type { CorrectBehavior, DatasetSplit, Difficulty, GroundTruth, Product } from "../ground-truth/schema.js";
import {
  ambiguousApiRename,
  bumpNodeRuntime,
  counterfactualNoRename,
  renameApiRequestField,
  type MutationGroundTruth,
  type RefStyle,
  type SyntheticRepo,
} from "../mutations/engine.js";
import { tsPaymentsService } from "./templates.js";
import type { GeneratedScenario } from "./types.js";

interface ScenarioMeta {
  scenario_id: string;
  product: Product;
  repo_family: string;
  difficulty: Difficulty;
  difficulty_rationale: string;
  dataset_split: DatasetSplit;
  tags: string[];
  notes: string;
  slug?: string;
}

/** Assemble a full, schema-valid GroundTruth from a mutation's answer key. */
function assembleGt(meta: ScenarioMeta, m: MutationGroundTruth): GroundTruth {
  return {
    scenario_id: meta.scenario_id,
    repo_family: meta.repo_family,
    difficulty: meta.difficulty,
    difficulty_rationale: meta.difficulty_rationale,
    intended_product: [meta.product],
    dataset_split: meta.dataset_split,
    correct_behavior: m.correct_behavior as CorrectBehavior,
    faults: m.faults,
    expected_findings: m.expected_findings,
    acceptable_findings: m.acceptable_findings,
    false_positive_traps: m.false_positive_traps,
    blast_radius_truth: m.blast_radius_truth,
    ...(m.recipe_expectation ? { recipe_expectation: m.recipe_expectation } : {}),
    tags: meta.tags,
    notes: meta.notes,
  };
}

const RENAME = { from: "source", to: "payment_method", example: "pm_card_visa" } as const;

// ---------------------------------------------------------------------------
// Family: $ref blindness (field rename reached through varying ref indirection)
// ---------------------------------------------------------------------------

const REF_STYLE_META: Record<RefStyle, { difficulty: Difficulty; why: string }> = {
  flat: { difficulty: 3, why: "inline request schema; the rename is one hop from the operation" },
  ref: { difficulty: 3, why: "request schema behind a single $ref component" },
  nested2: { difficulty: 4, why: "field reached through a $ref whose target is an allOf of another $ref (two-deep indirection)" },
  allOf: { difficulty: 4, why: "field contributed by an allOf branch; must union members to see it" },
  refToRef: { difficulty: 4, why: "request schema is a $ref pointing at another $ref before the object" },
};

function refRenameScenario(
  refStyle: RefStyle,
  seed: number,
  split: DatasetSplit,
  idSuffix = "",
): GeneratedScenario {
  const t = tsPaymentsService({ seed, field: RENAME.from });
  const mut = renameApiRequestField(t.repo, {
    path: t.path,
    method: t.method,
    from: RENAME.from,
    to: RENAME.to,
    example: RENAME.example,
    refStyle,
    impactedFiles: t.roles.impacted,
    decoyFiles: t.roles.decoys,
  });
  const meta = REF_STYLE_META[refStyle];
  const scenario_id = `gen-fettler-ref-${refStyle}${idSuffix}`;
  return {
    scenario_id,
    product: "fettler",
    slug: t.slug,
    repo: mut.mutated,
    gt: assembleGt(
      {
        scenario_id,
        product: "fettler",
        repo_family: "typescript-service-generated",
        difficulty: meta.difficulty,
        difficulty_rationale: `Ref-blindness family: ${meta.why}. The impacted field is threaded through relative imports; ${t.roles.decoys.length} same-token decoys keep it from being grep-able.`,
        dataset_split: split,
        tags: ["generated", "fettler", "field-rename", "ref-blindness", refStyle, split],
        notes: `Auto-generated (seed=${seed}). ${mut.changeLog.join(" | ")}`,
        slug: t.slug,
      },
      mut.groundTruth,
    ),
  };
}

/** Counterfactual partner: identical repo, no rename -> nothing to flag. */
function refCounterfactual(seed: number, split: DatasetSplit): GeneratedScenario {
  const t = tsPaymentsService({ seed, field: RENAME.from });
  const mut = counterfactualNoRename(t.repo, {
    path: t.path,
    method: t.method,
    from: RENAME.from,
    to: RENAME.to,
    example: RENAME.example,
    refStyle: "ref",
    impactedFiles: t.roles.impacted,
    decoyFiles: t.roles.decoys,
  });
  const scenario_id = "gen-fettler-ref-counterfactual";
  return {
    scenario_id,
    product: "fettler",
    slug: t.slug,
    repo: mut.mutated,
    gt: assembleGt(
      {
        scenario_id,
        product: "fettler",
        repo_family: "typescript-service-generated",
        difficulty: 4,
        difficulty_rationale:
          "Counterfactual for the ref-rename family: v1 and v2 are identical, so a correct engine flags nothing. Every field-bearing file is a false-positive trap.",
        dataset_split: split,
        tags: ["generated", "fettler", "counterfactual", "no-op", split],
        notes: `Auto-generated (seed=${seed}). ${mut.changeLog.join(" | ")}`,
        slug: t.slug,
      },
      mut.groundTruth,
    ),
  };
}

// ---------------------------------------------------------------------------
// Family: ambiguity (>=2 plausible successors -> must abstain)
// ---------------------------------------------------------------------------

function ambiguityScenario(
  variant: "two" | "three" | "two-decoy",
  seed: number,
  split: DatasetSplit,
): GeneratedScenario {
  const successors =
    variant === "three"
      ? ["payment_method", "payment_source", "pay_method"]
      : ["payment_method", "payment_source"];
  const t = tsPaymentsService({ seed, field: RENAME.from });
  const mut = ambiguousApiRename(t.repo, {
    path: t.path,
    method: t.method,
    from: RENAME.from,
    successors,
    example: RENAME.example,
    fieldFiles: [...t.roles.impacted, ...t.roles.decoys],
  });
  const scenario_id = `gen-fettler-ambiguous-${variant}`;
  return {
    scenario_id,
    product: "fettler",
    slug: t.slug,
    repo: mut.mutated,
    gt: assembleGt(
      {
        scenario_id,
        product: "fettler",
        repo_family: "typescript-service-generated",
        difficulty: 5,
        difficulty_rationale: `Adversarial ambiguity: field \`${RENAME.from}\` has ${successors.length} plausible successors [${successors.join(", ")}]. No single mapping is safe without a human; the correct output is abstention, and any confident finding is a P0 abstention failure.`,
        dataset_split: split,
        tags: ["generated", "fettler", "ambiguity", "abstain", variant, split],
        notes: `Auto-generated (seed=${seed}). ${mut.changeLog.join(" | ")}`,
        slug: t.slug,
      },
      mut.groundTruth,
    ),
  };
}

// ---------------------------------------------------------------------------
// Family: generated / vendored code
// ---------------------------------------------------------------------------

function generatedVendoredScenario(
  variant: "generated-only" | "vendored-only" | "both" | "looks-generated",
  seed: number,
  split: DatasetSplit,
): GeneratedScenario {
  const t = tsPaymentsService({
    seed,
    field: RENAME.from,
    withGenerated: variant === "generated-only" || variant === "both",
    withVendored: variant === "vendored-only" || variant === "both",
    withLooksGenerated: variant === "looks-generated",
  });
  // Header-marked generated files and vendored SDK copies are traps; a file that
  // merely looks generated (no header) is hand source and is already in impacted.
  const trapFiles = [...t.roles.generated, ...t.roles.vendored];
  const mut = renameApiRequestField(t.repo, {
    path: t.path,
    method: t.method,
    from: RENAME.from,
    to: RENAME.to,
    example: RENAME.example,
    refStyle: "ref",
    impactedFiles: t.roles.impacted,
    decoyFiles: [...t.roles.decoys, ...trapFiles],
  });
  const scenario_id = `gen-fettler-genvendor-${variant}`;
  const why: Record<typeof variant, string> = {
    "generated-only": "a header-marked generated file carries the field but must never be edited (regeneration overwrites it)",
    "vendored-only": "a vendored SDK copy carries the field but is not the customer's to edit",
    both: "both a generated file and a vendored SDK copy carry the field; neither may be flagged",
    "looks-generated": "a hand-maintained file lives under generated/ but has no codegen header, so it MUST be flagged (path is not a generated signal)",
  } as const;
  return {
    scenario_id,
    product: "fettler",
    slug: t.slug,
    repo: mut.mutated,
    gt: assembleGt(
      {
        scenario_id,
        product: "fettler",
        repo_family: "typescript-service-generated",
        difficulty: 4,
        difficulty_rationale: `Generated/vendored discrimination: ${why[variant]}.`,
        dataset_split: split,
        tags: ["generated", "fettler", "generated-vendored", variant, split],
        notes: `Auto-generated (seed=${seed}). ${mut.changeLog.join(" | ")}`,
        slug: t.slug,
      },
      mut.groundTruth,
    ),
  };
}

// ---------------------------------------------------------------------------
// Family: dependency runtime bump (ReGauge)
// ---------------------------------------------------------------------------

function runtimeBumpBaseRepo(): SyntheticRepo {
  return {
    files: {
      "src/index.ts": `export function main(): void {\n  console.log("service up");\n}\n`,
      "README.md": "# synthetic runtime service\n",
    },
  };
}

function runtimeScenario(
  variant: "supported-18-20" | "supported-20-22" | "unsupported-21-23" | "already-migrated",
  seed: number,
  split: DatasetSplit,
): GeneratedScenario {
  const base = runtimeBumpBaseRepo();
  const files = [".nvmrc", "package.json"];
  let repo: SyntheticRepo;
  let gt: MutationGroundTruth;
  let notes: string;
  let difficulty: Difficulty;
  let behavior: CorrectBehavior;

  if (variant === "already-migrated") {
    // Pin at Node 22 — the terminal version no shipped recipe has as its SOURCE
    // (18->20 and 20->22 are the only runtime recipes). A repo already at 22 is a
    // true global no-op; pinning at 20 would not be, because the 20->22 recipe
    // legitimately matches it. We reuse bumpNodeRuntime only to WRITE the node-22
    // pins; the manual ground truth below is what scores it.
    const m = bumpNodeRuntime(base, { fromMajor: 22, toMajor: 24, files, shippedRecipeId: null });
    repo = m.mutated;
    difficulty = 3;
    behavior = "no_op";
    gt = {
      correct_behavior: "no_op",
      expected_findings: [],
      false_positive_traps: [],
      acceptable_findings: [],
      faults: [
        {
          id: "runtime-already-migrated",
          description: "Repository already pins Node 22 (the terminal supported version); no runtime migration remains. Any recipe match is a false positive.",
          family: "runtime-upgrade",
        },
      ],
      blast_radius_truth: { affectedFiles: 0 },
      recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: null },
    };
    notes = "Auto-generated counterfactual: pins already at Node 22 (inverse of the 20->22 bump); no shipped recipe applies.";
  } else {
    const spec =
      variant === "supported-18-20"
        ? { fromMajor: 18, toMajor: 20, shippedRecipeId: "node-runtime-18-to-20" as string | null, d: 2 as Difficulty }
        : variant === "supported-20-22"
          ? { fromMajor: 20, toMajor: 22, shippedRecipeId: "node-runtime-20-to-22" as string | null, d: 2 as Difficulty }
          : { fromMajor: 21, toMajor: 23, shippedRecipeId: null as string | null, d: 4 as Difficulty };
    const m = bumpNodeRuntime(base, { fromMajor: spec.fromMajor, toMajor: spec.toMajor, files, shippedRecipeId: spec.shippedRecipeId });
    repo = m.mutated;
    gt = m.groundTruth;
    difficulty = spec.d;
    behavior = gt.correct_behavior as CorrectBehavior;
    notes = `Auto-generated (seed=${seed}). ${m.changeLog.join(" | ")}`;
  }

  const scenario_id = `gen-regauge-runtime-${variant}`;
  return {
    scenario_id,
    product: "regauge",
    repo,
    gt: assembleGt(
      {
        scenario_id,
        product: "regauge",
        repo_family: "node-service-generated",
        difficulty,
        difficulty_rationale:
          behavior === "coverage_gap"
            ? "No shipped recipe covers this Node major bump; correct shipped behavior is abstention-by-absence."
            : behavior === "no_op"
              ? "Runtime already at target; the engine must not match (any match is a false positive)."
              : "A shipped runtime recipe covers this exact bump; the engine should recognize and (would) apply it.",
        dataset_split: split,
        tags: ["generated", "regauge", "runtime-upgrade", variant, split],
        notes,
      },
      gt,
    ),
  };
}

// ---------------------------------------------------------------------------
// Holdout growth: unseen ref-rename variations from fresh seeds
// ---------------------------------------------------------------------------

/**
 * Procedurally emit `count` UNSEEN ref-rename scenarios from fresh seeds. These
 * were never inspected while fixing, so they are the honest measure of whether a
 * change improved the product or just the benchmark. Seeds are deterministic so
 * the holdout set is reproducible run-to-run.
 */
export function holdoutRefVariations(count: number, seedBase = 90_000): GeneratedScenario[] {
  const styles: RefStyle[] = ["flat", "ref", "nested2", "allOf", "refToRef"];
  const out: GeneratedScenario[] = [];
  for (let i = 0; i < count; i++) {
    const style = styles[i % styles.length]!;
    out.push(refRenameScenario(style, seedBase + i * 7, "holdout", `-holdout-${i}`));
  }
  return out;
}

/** Every generated scenario across all families, with splits assigned. */
export function generateAllScenarios(): GeneratedScenario[] {
  const scenarios: GeneratedScenario[] = [
    // Ref-blindness family (development + validation) + counterfactual.
    refRenameScenario("flat", 1001, "development"),
    refRenameScenario("ref", 1002, "development"),
    refRenameScenario("allOf", 1003, "validation"),
    refRenameScenario("nested2", 1004, "validation"),
    refRenameScenario("refToRef", 1005, "validation"),
    refCounterfactual(1006, "development"),

    // Ambiguity family.
    ambiguityScenario("two", 2001, "development"),
    ambiguityScenario("three", 2002, "validation"),
    ambiguityScenario("two-decoy", 2003, "validation"),

    // Generated / vendored family.
    generatedVendoredScenario("generated-only", 3001, "development"),
    generatedVendoredScenario("vendored-only", 3002, "validation"),
    generatedVendoredScenario("both", 3003, "validation"),
    generatedVendoredScenario("looks-generated", 3004, "development"),

    // Dependency runtime family (ReGauge).
    runtimeScenario("supported-18-20", 4001, "development"),
    runtimeScenario("supported-20-22", 4002, "validation"),
    runtimeScenario("unsupported-21-23", 4003, "validation"),
    runtimeScenario("already-migrated", 4004, "development"),
  ];
  // Holdout: unseen procedural variations.
  scenarios.push(...holdoutRefVariations(4));
  return scenarios;
}
