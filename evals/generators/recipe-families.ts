/**
 * Procedurally-materialized ReGauge recipe-family scenarios.
 *
 * Every shipped ReGauge recipe family (runtime, SDK, framework, internal-API)
 * gets three cases so the readiness gate can score it, built on the SAME
 * committed consumer fixtures the transformer's own recipe tests use
 * (`fixtures/consumers/<family>/{before,out-of-scope}`):
 *
 *   - positive       an in-scope repo (`before/`) the recipe must recognize and
 *                    (would) apply cleanly           -> correct_behavior apply_recipe
 *   - residual       the in-scope repo PLUS one extra consumer, outside the
 *                    recipe's allowedPaths, still on the old surface. A correct
 *                    engine must REFUSE (status=incomplete), never ship a partial
 *                    migration                        -> correct_behavior refuse_partial
 *   - abstention     an out-of-scope repo (`out-of-scope/`) no shipped recipe
 *                    should match                     -> correct_behavior abstain
 *
 * The residual case is the one the SDK/framework/internal-API families FAIL
 * today: residual detection in `packages/transformer/src/recipe.ts` is scoped to
 * the runtime precondition kinds only, so an extra SDK/react/internal consumer is
 * not detected and the recipe reports `status=applicable` — it would strip/bump a
 * dependency while a residual consumer stays on the old surface. The runtime
 * residual case DOES pass today (its detection exists) and is the positive
 * control that proves the gate can tell a ready family from an unready one.
 *
 * Repos are read from the committed fixtures at generate time and carried IN
 * MEMORY; the driver materializes them to scratch and stages them exactly like
 * every other generated scenario (answer-key isolation preserved — a fixture
 * `before/`/`out-of-scope/` tree contains only source files, no ground truth).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import type { Difficulty, GroundTruth } from "../ground-truth/schema.js";
import type { SyntheticRepo } from "../mutations/engine.js";
import type { GeneratedScenario } from "./types.js";

const FIXTURES_ROOT = fileURLToPath(new URL("../../fixtures/consumers/", import.meta.url));

/** Read one fixture subtree into a posix-keyed file map. */
function loadFixture(family: string, sub: "before" | "out-of-scope"): Record<string, string> {
  const root = join(FIXTURES_ROOT, family, sub);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}

interface FamilySpec {
  /** Fixture subdirectory under fixtures/consumers/. */
  fixture: string;
  /** Shipped recipe id the runner will observe (the recipe's own id). */
  recipeId: string;
  /** recipe_expectation.family — the string the readiness gate aggregates on. */
  family: string;
  /** Short id fragment used in scenario ids. */
  slug: string;
  repo_family: string;
  applyDifficulty: Difficulty;
  /** The extra residual consumer (path outside allowedPaths + its content). */
  residual: { path: string; content: string };
}

const AWS_RESIDUAL = `import AWS from "aws-sdk";

const s3 = new AWS.S3({ region: "us-east-1" });

export async function fetchThumb(Bucket, Key) {
  const data = await s3.getObject({ Bucket, Key }).promise();
  return data.Body;
}
`;

const STRIPE_RESIDUAL = `const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
stripe.setApiVersion("2019-08-08");
stripe.setTimeout(20000);

async function createCharge(amount) {
  return stripe.charges.create({ amount, currency: "usd" });
}

module.exports = { createCharge };
`;

const GOOGLE_RESIDUAL = `const google = require("googleapis");

async function listMessages(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const response = await gmail.users.messages.list({ userId: "me" });
  return response.data.messages;
}

module.exports = { listMessages };
`;

const REACT_RESIDUAL = `import React from "react";
import ReactDOM from "react-dom";
import Admin from "./Admin";

ReactDOM.render(<Admin />, document.getElementById("admin"));
`;

const INTERNAL_RESIDUAL = `import { getUser } from "@acme/user-service";

export async function loadDashboard(id: string): Promise<string> {
  const user = await getUser(id);
  return user.id;
}
`;

const SDK_SPECS: FamilySpec[] = [
  {
    fixture: "aws-sdk-v2-to-v3",
    recipeId: "aws-sdk-js-v2-to-v3",
    family: "sdk-upgrade",
    slug: "aws",
    repo_family: "node-service",
    applyDifficulty: 3,
    residual: { path: "src/upload.js", content: AWS_RESIDUAL },
  },
  {
    fixture: "stripe-node-v10-to-v11",
    recipeId: "stripe-node-v10-to-v11",
    family: "sdk-upgrade",
    slug: "stripe",
    repo_family: "node-service",
    applyDifficulty: 3,
    residual: { path: "src/billing.js", content: STRIPE_RESIDUAL },
  },
  {
    fixture: "googleapis-v25-to-v26",
    recipeId: "googleapis-v25-to-v26",
    family: "sdk-upgrade",
    slug: "googleapis",
    repo_family: "node-service",
    applyDifficulty: 3,
    residual: { path: "src/mail.js", content: GOOGLE_RESIDUAL },
  },
];

const FRAMEWORK_SPEC: FamilySpec = {
  fixture: "react-dom-17-to-18",
  recipeId: "react-dom-17-to-18",
  family: "framework-upgrade",
  slug: "react-dom",
  repo_family: "react-spa",
  applyDifficulty: 3,
  residual: { path: "src/legacy.jsx", content: REACT_RESIDUAL },
};

const INTERNAL_SPEC: FamilySpec = {
  fixture: "internal-api-acme-user-rename",
  recipeId: "internal-api-acme-user-getuser-to-fetchuser",
  family: "internal-api-rename",
  slug: "acme-user",
  repo_family: "typescript-service",
  applyDifficulty: 4,
  residual: { path: "src/dashboard.ts", content: INTERNAL_RESIDUAL },
};

const sortedKeys = (files: Record<string, string>): string[] => Object.keys(files).sort();

function gt(over: Partial<GroundTruth> & Pick<GroundTruth, "scenario_id" | "correct_behavior">): GroundTruth {
  return {
    repo_family: "node-service",
    difficulty: 3,
    difficulty_rationale: "recipe-family scenario",
    intended_product: ["regauge"],
    dataset_split: "development",
    faults: [],
    expected_findings: [],
    acceptable_findings: [],
    false_positive_traps: [],
    blast_radius_truth: { affectedFiles: 0 },
    tags: [],
    ...over,
  };
}

/** The three cases for one recipe family, built from its committed fixtures. */
function familyScenarios(spec: FamilySpec): GeneratedScenario[] {
  const before = loadFixture(spec.fixture, "before");
  const oos = loadFixture(spec.fixture, "out-of-scope");
  const inScope = sortedKeys(before);
  const out: GeneratedScenario[] = [];

  // Positive — in-scope repo the recipe must recognize and (would) apply.
  const posId = `gen-regauge-${spec.slug}-apply`;
  out.push({
    scenario_id: posId,
    product: "regauge",
    repo: { files: before },
    gt: gt({
      scenario_id: posId,
      repo_family: spec.repo_family,
      difficulty: spec.applyDifficulty,
      difficulty_rationale: `In-scope ${spec.family} repo (the committed '${spec.fixture}/before' consumer). The shipped recipe ${spec.recipeId} recognizes its source preconditions and would apply to exactly its allowlisted files.`,
      correct_behavior: "apply_recipe",
      faults: [{ id: `${spec.slug}-in-scope`, description: `Consumer on the old ${spec.family} surface; a shipped recipe covers it.`, family: spec.family }],
      expected_findings: inScope,
      blast_radius_truth: { affectedFiles: inScope.length },
      recipe_expectation: { family: spec.family, shippedRecipeId: spec.recipeId },
      tags: ["generated", "regauge", spec.family, "apply", "development"],
      notes: `Auto-materialized from fixtures/consumers/${spec.fixture}/before. Expected match: recipe ${spec.recipeId}, matchedPaths=${inScope.join(", ")}.`,
    }),
  });

  // Residual — in-scope repo PLUS a consumer outside allowedPaths still on the
  // old surface. Correct behaviour is refusal (status=incomplete).
  const resId = `gen-regauge-${spec.slug}-residual`;
  out.push({
    scenario_id: resId,
    product: "regauge",
    repo: { files: { ...before, [spec.residual.path]: spec.residual.content } },
    gt: gt({
      scenario_id: resId,
      repo_family: spec.repo_family,
      difficulty: 5,
      difficulty_rationale: `Level 5 (partial-migration safety, P0): '${spec.residual.path}' sits OUTSIDE recipe ${spec.recipeId}'s allowedPaths but still uses the old ${spec.family} surface. Applying the recipe would migrate the allowlisted files and sign an evidence record while a residual consumer keeps importing the stripped/old module — a repo that no longer installs. The only safe outcome is refusal (status=incomplete).`,
      correct_behavior: "refuse_partial",
      faults: [{ id: `${spec.slug}-residual`, description: `A consumer at ${spec.residual.path} (outside allowedPaths) still uses the old ${spec.family} surface; migrating only the allowlisted files leaves it broken.`, family: spec.family }],
      // The in-scope files are what WOULD migrate; grading keys on the analyze
      // status (incomplete), so these are informational and kept present in-repo.
      expected_findings: inScope,
      blast_radius_truth: { affectedFiles: inScope.length },
      recipe_expectation: { family: spec.family, shippedRecipeId: spec.recipeId },
      tags: ["generated", "regauge", spec.family, "refuse-partial", "residual", "P0", "development"],
      notes: `Auto-materialized from fixtures/consumers/${spec.fixture}/before + residual ${spec.residual.path}. Correct: recipe ${spec.recipeId} matches with status=incomplete (refuses). Until residual detection covers this precondition kind in recipe.ts, the engine reports status=applicable and this scenario FAILS P0 — the honest signal.`,
    }),
  });

  // Abstention — out-of-scope repo no shipped recipe should match.
  const absId = `gen-regauge-${spec.slug}-abstain`;
  out.push({
    scenario_id: absId,
    product: "regauge",
    repo: { files: oos },
    gt: gt({
      scenario_id: absId,
      repo_family: spec.repo_family,
      difficulty: 4,
      difficulty_rationale: `Out-of-scope ${spec.family} repo (the committed '${spec.fixture}/out-of-scope' consumer): superficially similar but outside every shipped recipe's supported surface. No recipe may match; any match is a false positive.`,
      correct_behavior: "abstain",
      faults: [{ id: `${spec.slug}-out-of-scope`, description: `Consumer uses a surface no shipped ${spec.family} recipe supports.`, family: spec.family }],
      expected_findings: [],
      false_positive_traps: sortedKeys(oos),
      blast_radius_truth: { affectedFiles: 0 },
      recipe_expectation: { family: spec.family, shippedRecipeId: null },
      tags: ["generated", "regauge", spec.family, "abstain", "out-of-scope", "development"],
      notes: `Auto-materialized from fixtures/consumers/${spec.fixture}/out-of-scope. Correct: no shipped recipe matches.`,
    }),
  });

  return out;
}

/**
 * A runtime residual scenario (the positive control). Built from the committed
 * node-runtime-20-to-22 'before' fixture plus a CI Dockerfile still pinned to
 * node:20 outside the recipe's allowedPaths. Runtime residual detection already
 * ships, so this refusal PASSES today — proving the gate distinguishes a family
 * whose residual detection works from the SDK families where it does not.
 */
function runtimeResidualScenario(): GeneratedScenario {
  const before = loadFixture("node-runtime-20-to-22", "before");
  const files = {
    ...before,
    "docker/Dockerfile.ci": "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\n",
  };
  const inScope = Object.keys(before).sort();
  const id = "gen-regauge-runtime-residual";
  return {
    scenario_id: id,
    product: "regauge",
    repo: { files },
    gt: gt({
      scenario_id: id,
      repo_family: "node-service",
      difficulty: 4,
      difficulty_rationale: "A CI Dockerfile (docker/Dockerfile.ci) pinned to node:20 sits outside node-runtime-20-to-22's allowedPaths while the root pins are on node 20. A complete migration cannot leave the CI image behind, so the engine must refuse (status=incomplete). Runtime residual detection ships, so this is the positive control that passes today.",
      correct_behavior: "refuse_partial",
      faults: [{ id: "runtime-residual", description: "A CI Dockerfile outside allowedPaths stays on the old Node major; a config-only bump of the root pins would leave it behind.", family: "runtime-upgrade" }],
      expected_findings: inScope,
      blast_radius_truth: { affectedFiles: inScope.length },
      recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: "node-runtime-20-to-22" },
      tags: ["generated", "regauge", "runtime-upgrade", "refuse-partial", "residual", "positive-control", "development"],
      notes: "Auto-materialized from fixtures/consumers/node-runtime-20-to-22/before + docker/Dockerfile.ci on node:20. Correct: node-runtime-20-to-22 matches with status=incomplete (refuses). Passes today (runtime residual detection ships).",
    }),
  };
}

/** Every ReGauge recipe-family scenario (positive + residual + abstention). */
export function recipeFamilyScenarios(): GeneratedScenario[] {
  return [
    ...SDK_SPECS.flatMap(familyScenarios),
    ...familyScenarios(FRAMEWORK_SPEC),
    ...familyScenarios(INTERNAL_SPEC),
    runtimeResidualScenario(),
  ];
}
