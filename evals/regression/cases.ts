/**
 * Failure -> eval: the catalog of validated failures, as machine-readable cases.
 *
 * Every entry here is a REAL failure that was validated against a real commit,
 * reduced to a deterministic synthetic reproduction, and certified safe to
 * commit. Two sources feed it today:
 *
 *   - The OSS validation (`C:/Users/Talal/dev/oss-kinked/VALIDATION-REPORT.md`),
 *     which built kinked clones of express / react-tutorial / next.js and found
 *     12 cases where the product was wrong and the eval was green. The residual
 *     idioms it isolated — a `--platform` build flag, an `@sha256` digest pin, a
 *     nested non-canonical `engines.node` range, a vendored consumer, an
 *     un-renamed internal-API consumer — are reproduced here from the SAME
 *     committed consumer fixtures the transformer's own tests use, so no cloned
 *     OSS tree is ever committed.
 *   - The readiness run itself (`evals/reports/readiness-scorecard.md`), whose
 *     internal-api family residual gate fails honestly today.
 *
 * PR #174 ("Detect partial migrations in all repo-global recipe families") closed
 * the runtime-idiom and SDK/framework residual gaps. The `fixed` cases here are
 * the regression guards for that fix: each would report `applicable` (ship a
 * partial migration) on the pre-#174 engine and reports `incomplete` (refuse)
 * now. PR #199 ("Detect residual sites in the internal-API rename family and
 * fail closed on unhandled kinds") then closed the internal-API residual gap
 * #174 did not cover: the internal-API case below was recorded `open` (it failed
 * honestly, shipping a partial rename) and flipped to `fixed` the day #199's
 * residual detection landed in `packages/transformer/src/recipe.ts`.
 *
 * Reproductions never touch the shared corpus and never contain an answer-key
 * file (the governance gate asserts both).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import type { RegressionCase } from "./schema.js";

const FIXTURES_ROOT = fileURLToPath(new URL("../../fixtures/consumers/", import.meta.url));

/** Read one committed fixture subtree into a posix-keyed file map. */
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

const sortedKeys = (files: Record<string, string>): string[] => Object.keys(files).sort();

/** Common OSS-validation provenance, one line per case in `note`. */
function ossProvenance(note: string): RegressionCase["provenance"] {
  return {
    source: "oss-validation:C:/Users/Talal/dev/oss-kinked/VALIDATION-REPORT.md",
    validatedAtCommit: "1d3ae5a",
    validatedOn: "2026-08-17",
    note,
  };
}

/** Synthetic governance certification shared by every case in this catalog. */
const SYNTHETIC_GOVERNANCE: RegressionCase["governance"] = {
  dataProvenance: "synthetic",
  containsCustomerData: false,
  rationale:
    "Reproduction is materialized from the committed synthetic consumer fixtures plus a hand-authored residual file that encodes the idiom only; no cloned OSS tree, customer code, secret, or PII is present.",
};

// The residual files that encode each idiom. Each sits OUTSIDE its recipe's
// allowedPaths but still on the old surface, so a complete migration cannot leave
// it behind.

const DOCKERFILE_PLATFORM_RESIDUAL = `FROM --platform=linux/amd64 node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci
`;

const DOCKERFILE_DIGEST_RESIDUAL = `FROM node:20@sha256:0000000000000000000000000000000000000000000000000000000000000000
WORKDIR /app
COPY . .
RUN npm ci
`;

const NESTED_ENGINE_RESIDUAL = `${JSON.stringify(
  { name: "svc", private: true, engines: { node: "^20" } },
  null,
  2,
)}\n`;

const AWS_VENDORED_RESIDUAL = `// vendored v2 consumer kept under vendor/ and still on the removed dependency
const AWS = require("aws-sdk");

const s3 = new AWS.S3({ region: "us-east-1" });

exports.getLegacyObject = async function getLegacyObject(Bucket, Key) {
  const data = await s3.getObject({ Bucket, Key }).promise();
  return data.Body;
};
`;

const INTERNAL_ACME_RESIDUAL = `import { getUser } from "@acme/user-service";

// Not in the recipe's allowedPaths; still calls the renamed-away export.
export async function buildReport(id: string): Promise<string> {
  const user = await getUser(id);
  return \`report for \${user.id}\`;
}
`;

export const REGRESSION_CASES: readonly RegressionCase[] = [
  // --- Runtime family (source major 20; guards the #174 Dockerfile-parser fixes) ---
  {
    id: "reg-regauge-runtime-platform-residual",
    capability: "regauge-runtime-migration",
    product: "regauge",
    provenance: ossProvenance(
      "K3: a residual Dockerfile.prod pins `FROM --platform=linux/amd64 node:20` outside the recipe's allowedPaths; the pre-#174 parser was blind to the build flag and shipped a partial migration.",
    ),
    governance: SYNTHETIC_GOVERNANCE,
    status: "fixed",
    fixedBy: "#174",
    build: () => {
      const before = loadFixture("node-runtime-20-to-22", "before");
      const files = { ...before, "Dockerfile.prod": DOCKERFILE_PLATFORM_RESIDUAL };
      const inScope = sortedKeys(before);
      return {
        repo: { files },
        groundTruth: {
          repo_family: "node-service",
          difficulty: 5,
          intended_product: ["regauge"],
          correct_behavior: "refuse_partial",
          faults: [
            {
              id: "runtime-platform-residual",
              description:
                "Dockerfile.prod uses a `--platform` build flag before `node:20`; migrating only the root files leaves it on the old major.",
              family: "runtime-upgrade",
            },
          ],
          expected_findings: inScope,
          acceptable_findings: [],
          false_positive_traps: [],
          blast_radius_truth: { affectedFiles: inScope.length },
          recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: "node-runtime-20-to-22" },
          notes:
            "Correct: node-runtime-20-to-22 matches with status=incomplete (residual Dockerfile.prod). Guards #174's shared Dockerfile major parser (--platform tolerance).",
        },
      };
    },
  },
  {
    id: "reg-regauge-runtime-digest-residual",
    capability: "regauge-runtime-migration",
    product: "regauge",
    provenance: ossProvenance(
      "K4: a residual ci/Dockerfile pins `FROM node:20@sha256:...` outside allowedPaths; the pre-#174 lookahead rejected `@` and shipped a partial migration.",
    ),
    governance: SYNTHETIC_GOVERNANCE,
    status: "fixed",
    fixedBy: "#174",
    build: () => {
      const before = loadFixture("node-runtime-20-to-22", "before");
      const files = { ...before, "ci/Dockerfile": DOCKERFILE_DIGEST_RESIDUAL };
      const inScope = sortedKeys(before);
      return {
        repo: { files },
        groundTruth: {
          repo_family: "node-service",
          difficulty: 5,
          intended_product: ["regauge"],
          correct_behavior: "refuse_partial",
          faults: [
            {
              id: "runtime-digest-residual",
              description:
                "ci/Dockerfile pins node:20 by `@sha256` digest; migrating only the root files leaves the CI image on the old major.",
              family: "runtime-upgrade",
            },
          ],
          expected_findings: inScope,
          acceptable_findings: [],
          false_positive_traps: [],
          blast_radius_truth: { affectedFiles: inScope.length },
          recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: "node-runtime-20-to-22" },
          notes:
            "Correct: node-runtime-20-to-22 matches with status=incomplete (residual ci/Dockerfile). Guards #174's digest-pin tolerance.",
        },
      };
    },
  },
  {
    id: "reg-regauge-runtime-nested-engine-residual",
    capability: "regauge-runtime-migration",
    product: "regauge",
    provenance: ossProvenance(
      "K5: a nested packages/svc/package.json pins `engines.node: ^20` (a non-canonical selector) outside allowedPaths; the pre-#174 guard required exact selector membership and shipped a partial migration.",
    ),
    governance: SYNTHETIC_GOVERNANCE,
    status: "fixed",
    fixedBy: "#174",
    build: () => {
      const before = loadFixture("node-runtime-20-to-22", "before");
      const files = { ...before, "packages/svc/package.json": NESTED_ENGINE_RESIDUAL };
      const inScope = sortedKeys(before);
      return {
        repo: { files },
        groundTruth: {
          repo_family: "node-service",
          difficulty: 5,
          intended_product: ["regauge"],
          correct_behavior: "refuse_partial",
          faults: [
            {
              id: "runtime-nested-engine-residual",
              description:
                "A nested manifest pins engines.node to `^20` (same source major, non-canonical selector); the config-only root bump leaves it behind.",
              family: "runtime-upgrade",
            },
          ],
          expected_findings: inScope,
          acceptable_findings: [],
          false_positive_traps: [],
          blast_radius_truth: { affectedFiles: inScope.length },
          recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: "node-runtime-20-to-22" },
          notes:
            "Correct: node-runtime-20-to-22 matches with status=incomplete (residual nested manifest). Guards #174's pinned-major (not exact-selector) nested-engine detection.",
        },
      };
    },
  },
  // --- SDK family (guards the #174 source-state residual detection) ---
  {
    id: "reg-regauge-aws-vendored-residual",
    capability: "regauge-sdk-migration",
    product: "regauge",
    provenance: ossProvenance(
      "K7-vendored: a vendored v2 consumer under vendor/ still requires the removed `aws-sdk` after the manifest transform drops it repo-wide; pre-#174 the SDK families reported residual []. ",
    ),
    governance: SYNTHETIC_GOVERNANCE,
    status: "fixed",
    fixedBy: "#174",
    build: () => {
      const before = loadFixture("aws-sdk-v2-to-v3", "before");
      const files = { ...before, "vendor/legacy-s3.js": AWS_VENDORED_RESIDUAL };
      const inScope = sortedKeys(before);
      return {
        repo: { files },
        groundTruth: {
          repo_family: "node-service",
          difficulty: 5,
          intended_product: ["regauge"],
          correct_behavior: "refuse_partial",
          faults: [
            {
              id: "aws-vendored-residual",
              description:
                "vendor/legacy-s3.js still requires aws-sdk; the manifest transform removes the package repo-wide, so the vendored consumer no longer resolves.",
              family: "sdk-upgrade",
            },
          ],
          expected_findings: inScope,
          acceptable_findings: [],
          false_positive_traps: [],
          blast_radius_truth: { affectedFiles: inScope.length },
          recipe_expectation: { family: "sdk-upgrade", shippedRecipeId: "aws-sdk-js-v2-to-v3" },
          notes:
            "Correct: aws-sdk-js-v2-to-v3 matches with status=incomplete (surviving aws-sdk import under vendor/). Guards #174's whole-snapshot source-state residual scan.",
        },
      };
    },
  },
  // --- Internal-API family (CLOSED by #199; #174 did not cover the internal-api kinds) ---
  {
    id: "reg-regauge-internal-api-acme-residual",
    capability: "regauge-internal-api-migration",
    product: "regauge",
    provenance: ossProvenance(
      "case 6: a residual src/reports.ts still calls the renamed-away `getUser` export outside the recipe's allowedPaths. Before #199 the internal-API kinds had no residual detection (isResidualSite fell through to `return false`), so analyze returned applicable and the engine would have shipped a partial rename; #199 adds that detection and the engine now refuses with status=incomplete.",
    ),
    governance: SYNTHETIC_GOVERNANCE,
    status: "fixed",
    fixedBy: "#199",
    build: () => {
      const before = loadFixture("internal-api-acme-user-rename", "before");
      const files = { ...before, "src/reports.ts": INTERNAL_ACME_RESIDUAL };
      const inScope = sortedKeys(before);
      return {
        repo: { files },
        groundTruth: {
          repo_family: "typescript-service",
          difficulty: 5,
          intended_product: ["regauge"],
          correct_behavior: "refuse_partial",
          faults: [
            {
              id: "internal-api-acme-residual",
              description:
                "src/reports.ts still imports and calls getUser from @acme/user-service after the rename; migrating only the allowlisted consumers leaves a call to a symbol that no longer exists.",
              family: "internal-api-rename",
            },
          ],
          expected_findings: inScope,
          acceptable_findings: [],
          false_positive_traps: [],
          blast_radius_truth: { affectedFiles: inScope.length },
          recipe_expectation: {
            family: "internal-api-rename",
            shippedRecipeId: "internal-api-acme-user-getuser-to-fetchuser",
          },
          notes:
            "FIXED by #199: internal-API residual detection now flags src/reports.ts (isResidualSite classifies the internal_api_rename_source kind instead of falling through), so analyze reports status=incomplete and the engine refuses the partial rename. On the pre-#199 engine this reported status=applicable and FAILED P0 — the honest signal this case was recorded to catch.",
        },
      };
    },
  },
];
