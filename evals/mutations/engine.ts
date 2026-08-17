/**
 * Phase 2 / 12 — mutation engine.
 *
 * Applies controlled, reversible, SEEDED defects to an otherwise healthy
 * in-memory repository and emits the exact ground truth needed to score the
 * result. Nothing here touches disk or the shared corpus — a mutation takes a
 * {@link SyntheticRepo} value and returns a new one plus its answer key, so a
 * family can expand without hand-authoring a repo per case.
 *
 * Two mutation CLASSES are implemented, matching the spec's "API and dependency
 * mutation classes":
 *
 *   API mutations (drive Fettler via an OpenAPI v1/v2 diff):
 *     - request-field rename (with selectable $ref indirection style)
 *     - request-field rename made AMBIGUOUS (>=2 plausible successors)
 *     - request-field removal
 *
 *   Dependency mutations (drive ReGauge via the recipe engine):
 *     - Node runtime major bump across package.json / .nvmrc / Dockerfile
 *
 * Invariants every mutation upholds:
 *   1. Deterministic + seeded: same (base, seed, opts) -> byte-identical output.
 *   2. Reversible: `inverse(mutated)` reproduces the pre-mutation repo exactly, so
 *      a mutation can never corrupt the source. (The Phase-14 COUNTERFACTUAL — a
 *      near-identical repo where the defect is ABSENT — is a separate, explicit
 *      generator, `counterfactualNoRename`, not the inverse.)
 *   3. Self-describing answer key: `changeLog` records exactly what changed, and
 *      `groundTruth` states the impacted set and the false-positive traps. A
 *      mutation that cannot state its own answer key is not allowed.
 */
import type {
  BlastRadiusTruth,
  CorrectBehavior,
  Fault,
  RecipeExpectation,
} from "../ground-truth/schema.js";

/** In-memory synthetic repository: repo-relative posix path -> file content. */
export interface SyntheticRepo {
  files: Record<string, string>;
  /** OpenAPI "before" spec (Fettler scenarios). */
  specV1?: unknown;
  /** OpenAPI "after" spec (Fettler scenarios). */
  specV2?: unknown;
}

/** The answer-key fragment a mutation contributes to a scenario's ground truth. */
export interface MutationGroundTruth {
  correct_behavior: CorrectBehavior;
  expected_findings: string[];
  false_positive_traps: string[];
  acceptable_findings: string[];
  faults: Fault[];
  blast_radius_truth: BlastRadiusTruth;
  recipe_expectation?: RecipeExpectation;
}

export interface MutationResult {
  mutated: SyntheticRepo;
  groundTruth: MutationGroundTruth;
  /** Reverse the mutation, reproducing the pre-mutation repo exactly. */
  inverse: () => SyntheticRepo;
  /** Exactly what the mutation changed — the answer key's provenance. */
  changeLog: string[];
}

/** Deterministic 32-bit RNG (mulberry32). Seeded so a family is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable deep clone via structured JSON (specs and file maps are JSON-safe). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// OpenAPI spec builders
// ---------------------------------------------------------------------------

/** How the request-body schema references the object carrying the field. */
export type RefStyle =
  | "flat" // inline schema on the operation
  | "ref" // requestBody -> $ref Component
  | "nested2" // requestBody -> $ref A, A = allOf[$ref B], B carries the field
  | "allOf" // requestBody -> allOf[$ref Base, { field }]
  | "refToRef"; // requestBody -> $ref A, A = $ref B, B carries the field

export interface RenameSpecOptions {
  path: string;
  method: string;
  from: string;
  to: string;
  /** Shared example keeps `isPlausibleSuccessor` firing for lexically-far names. */
  example: string;
  refStyle: RefStyle;
  title?: string;
}

/** Build the object schema that declares a single required string `field`. */
function fieldObjectSchema(field: string, example: string): Record<string, unknown> {
  return {
    type: "object",
    required: [field, "amount"],
    properties: {
      amount: { type: "integer", example: 1000 },
      [field]: { type: "string", example },
    },
  };
}

/**
 * Build one OpenAPI document whose request body carries `field` through the
 * chosen `$ref` indirection style. The component names are stable so v1 and v2
 * differ only in the field name (a clean rename diff).
 */
function buildSpec(field: string, opts: RenameSpecOptions, version: string): unknown {
  const { path, method, example, refStyle, title } = opts;
  const schemas: Record<string, unknown> = {};
  let requestSchema: Record<string, unknown>;

  switch (refStyle) {
    case "flat":
      requestSchema = fieldObjectSchema(field, example);
      break;
    case "ref":
      schemas.ChargeCreate = fieldObjectSchema(field, example);
      requestSchema = { $ref: "#/components/schemas/ChargeCreate" };
      break;
    case "nested2":
      schemas.ChargeInner = fieldObjectSchema(field, example);
      schemas.ChargeCreate = { allOf: [{ $ref: "#/components/schemas/ChargeInner" }] };
      requestSchema = { $ref: "#/components/schemas/ChargeCreate" };
      break;
    case "allOf":
      schemas.ChargeBase = {
        type: "object",
        required: ["amount"],
        properties: { amount: { type: "integer", example: 1000 } },
      };
      requestSchema = {
        allOf: [
          { $ref: "#/components/schemas/ChargeBase" },
          {
            type: "object",
            required: [field],
            properties: { [field]: { type: "string", example } },
          },
        ],
      };
      break;
    case "refToRef":
      schemas.ChargeConcrete = fieldObjectSchema(field, example);
      schemas.ChargeCreate = { $ref: "#/components/schemas/ChargeConcrete" };
      requestSchema = { $ref: "#/components/schemas/ChargeCreate" };
      break;
  }

  return {
    openapi: "3.0.3",
    info: { title: title ?? "Synthetic Payments API", version },
    paths: {
      [path]: {
        [method.toLowerCase()]: {
          operationId: "createCharge",
          requestBody: {
            required: true,
            content: { "application/json": { schema: requestSchema } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    ...(Object.keys(schemas).length ? { components: { schemas } } : {}),
  };
}

// ---------------------------------------------------------------------------
// API mutation: request-field rename
// ---------------------------------------------------------------------------

export interface RenameFieldMutationOptions extends RenameSpecOptions {
  /** Repo-relative files that carry the field and must be flagged. */
  impactedFiles: string[];
  /** Repo-relative decoy files that must NOT be flagged. */
  decoyFiles: string[];
  /** Repo-relative files a run may flag without penalty (e.g. downstream tests). */
  acceptableFiles?: string[];
  /** Directory-prefix traps (generated/, vendor/) — trailing "/" honored by grader. */
  trapPrefixes?: string[];
}

/**
 * Rename an API request field between spec v1 and v2. The repository code stays
 * on v1 (the consumer is behind the provider), which is exactly the impact
 * Fettler must surface. The impacted/decoy roles are declared by the caller (the
 * template that planted them); the mutation records them verbatim as the key.
 */
export function renameApiRequestField(
  base: SyntheticRepo,
  opts: RenameFieldMutationOptions,
): MutationResult {
  const mutated = clone(base);
  mutated.specV1 = buildSpec(opts.from, opts, "1.0.0");
  mutated.specV2 = buildSpec(opts.to, opts, "2.0.0");

  const traps = [...opts.decoyFiles, ...(opts.trapPrefixes ?? [])].sort();
  const groundTruth: MutationGroundTruth = {
    correct_behavior: "flag_files",
    expected_findings: [...opts.impactedFiles].sort(),
    false_positive_traps: traps,
    acceptable_findings: [...(opts.acceptableFiles ?? [])].sort(),
    faults: [
      {
        id: "provider-field-rename",
        description: `Provider renamed request field \`${opts.from}\` -> \`${opts.to}\` (${opts.method} ${opts.path}); consumer is on v1. Ref style: ${opts.refStyle}.`,
        family: "api-field-rename",
      },
    ],
    blast_radius_truth: { affectedFiles: opts.impactedFiles.length },
  };

  return {
    mutated,
    groundTruth,
    inverse: () => clone(base), // restore the pre-mutation repo exactly
    changeLog: [
      `spec: renamed request field '${opts.from}' -> '${opts.to}' at ${opts.method} ${opts.path} (refStyle=${opts.refStyle})`,
      `impacted (must flag): ${opts.impactedFiles.join(", ")}`,
      `decoys (must not flag): ${traps.join(", ") || "(none)"}`,
    ],
  };
}

/**
 * Produce the COUNTERFACTUAL of a rename: a near-identical repo where the field
 * did NOT change (v2 == v1). Correct behavior is no-op; any confident finding is
 * a scored false positive. This is the Phase-14 partner of every rename case.
 */
export function counterfactualNoRename(
  base: SyntheticRepo,
  opts: RenameFieldMutationOptions,
): MutationResult {
  const mutated = clone(base);
  mutated.specV1 = buildSpec(opts.from, opts, "1.0.0");
  mutated.specV2 = buildSpec(opts.from, opts, "2.0.0"); // same field name -> no diff

  const traps = [
    ...opts.impactedFiles, // in the counterfactual, the "impacted" files are traps
    ...opts.decoyFiles,
    ...(opts.trapPrefixes ?? []),
  ].sort();
  const groundTruth: MutationGroundTruth = {
    correct_behavior: "no_op",
    expected_findings: [],
    false_positive_traps: traps,
    acceptable_findings: [],
    faults: [
      {
        id: "no-change-counterfactual",
        description: `Counterfactual: request field \`${opts.from}\` is unchanged between v1 and v2 (${opts.method} ${opts.path}). Nothing to flag; any confident finding is a false positive.`,
        family: "api-field-rename-counterfactual",
      },
    ],
    blast_radius_truth: { affectedFiles: 0 },
  };

  return {
    mutated,
    groundTruth,
    inverse: () => clone(base), // restore the pre-mutation repo exactly
    changeLog: [
      `spec: NO field change (counterfactual) at ${opts.method} ${opts.path}`,
      `all field-bearing files are traps: ${traps.join(", ") || "(none)"}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// API mutation: ambiguous rename (>=2 plausible successors)
// ---------------------------------------------------------------------------

export interface AmbiguousMutationOptions {
  path: string;
  method: string;
  from: string;
  /** Two or more added fields that all look like plausible successors of `from`. */
  successors: string[];
  example: string;
  /** Field-bearing files: none should be confidently flagged (abstain). */
  fieldFiles: string[];
  title?: string;
}

/** Build a spec whose v2 replaces `from` with several plausible successors. */
function buildAmbiguousSpec(
  fields: string[],
  opts: AmbiguousMutationOptions,
  version: string,
): unknown {
  const properties: Record<string, unknown> = { amount: { type: "integer", example: 1000 } };
  for (const f of fields) properties[f] = { type: "string", example: opts.example };
  return {
    openapi: "3.0.3",
    info: { title: opts.title ?? "Synthetic Payments API", version },
    paths: {
      [opts.path]: {
        [opts.method.toLowerCase()]: {
          operationId: "createCharge",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: [fields[0]!, "amount"], properties },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

/**
 * Rename `from` to one of several plausible successors — but leave it genuinely
 * ambiguous. Change Intelligence must classify this `request_field_ambiguous`
 * and emit NO impact surface; the correct product behavior is abstention, and
 * any confident finding is a P0 abstention failure.
 */
export function ambiguousApiRename(
  base: SyntheticRepo,
  opts: AmbiguousMutationOptions,
): MutationResult {
  if (opts.successors.length < 2) {
    throw new Error("ambiguousApiRename requires >=2 successors");
  }
  const mutated = clone(base);
  mutated.specV1 = buildAmbiguousSpec([opts.from], opts, "1.0.0");
  mutated.specV2 = buildAmbiguousSpec(opts.successors, opts, "2.0.0");

  const groundTruth: MutationGroundTruth = {
    correct_behavior: "abstain",
    expected_findings: [],
    false_positive_traps: [...opts.fieldFiles].sort(),
    acceptable_findings: [],
    faults: [
      {
        id: "ambiguous-field-rename",
        description: `Field \`${opts.from}\` could map to any of [${opts.successors.join(", ")}] in v2 (${opts.method} ${opts.path}). No single successor is correct without a human; the engine must abstain.`,
        family: "api-field-ambiguous",
      },
    ],
    blast_radius_truth: { affectedFiles: 0 },
  };

  return {
    mutated,
    groundTruth,
    inverse: () => clone(base), // restore the pre-mutation repo exactly
    changeLog: [
      `spec: replaced '${opts.from}' with ambiguous successors [${opts.successors.join(", ")}] at ${opts.method} ${opts.path}`,
      `correct behavior: abstain (flag nothing); field-bearing files are traps`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Dependency mutation: Node runtime major bump (drives ReGauge)
// ---------------------------------------------------------------------------

export interface RuntimeBumpOptions {
  fromMajor: number;
  toMajor: number;
  /** Runtime-pinning files present in the repo, e.g. ["package.json", ".nvmrc"]. */
  files: string[];
  /** The shipped recipe id that covers this exact bump, or null (coverage gap). */
  shippedRecipeId: string | null;
}

const NODE_ENGINE_SELECTOR: Record<number, string> = {
  18: ">=18 <19",
  20: ">=20 <21",
  22: ">=22 <23",
};

/**
 * Bump the Node runtime major across the repo's runtime-pinning files. The
 * mutation writes v1 (fromMajor) content; the "migration" the product must
 * perform is moving every pin to toMajor. Because the files it wrote ARE the
 * sites that must change, the answer key is exactly the set of files touched.
 */
export function bumpNodeRuntime(base: SyntheticRepo, opts: RuntimeBumpOptions): MutationResult {
  const mutated = clone(base);
  const changed: string[] = [];

  for (const file of opts.files) {
    if (file === "package.json") {
      const pkg = mutated.files["package.json"]
        ? (JSON.parse(mutated.files["package.json"]) as Record<string, unknown>)
        : { name: "synthetic-runtime-svc" };
      pkg.engines = { node: NODE_ENGINE_SELECTOR[opts.fromMajor] ?? `>=${opts.fromMajor}` };
      mutated.files["package.json"] = JSON.stringify(pkg, null, 2) + "\n";
      changed.push("package.json");
    } else if (file === ".nvmrc" || file === ".node-version") {
      mutated.files[file] = `${opts.fromMajor}\n`;
      changed.push(file);
    } else if (file === "Dockerfile") {
      mutated.files.Dockerfile = `FROM node:${opts.fromMajor}-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "index.js"]\n`;
      changed.push("Dockerfile");
    }
  }

  const isCoverageGap = opts.shippedRecipeId === null;
  const groundTruth: MutationGroundTruth = {
    correct_behavior: isCoverageGap ? "coverage_gap" : "apply_recipe",
    expected_findings: [...changed].sort(),
    false_positive_traps: [],
    acceptable_findings: [],
    faults: [
      {
        id: "node-runtime-bump",
        description: `Repository pins Node ${opts.fromMajor}; the migration under test moves it to Node ${opts.toMajor}.`,
        family: "runtime-upgrade",
      },
    ],
    blast_radius_truth: { affectedFiles: changed.length, importChain: [] },
    recipe_expectation: {
      family: "runtime-upgrade",
      shippedRecipeId: opts.shippedRecipeId,
    },
  };

  return {
    mutated,
    groundTruth,
    inverse: () => clone(base), // restore the pre-mutation repo exactly
    changeLog: [
      `runtime: pinned Node ${opts.fromMajor} across ${changed.join(", ")}`,
      `migration target: Node ${opts.toMajor}`,
      `shipped recipe: ${opts.shippedRecipeId ?? "(none — coverage gap)"}`,
    ],
  };
}
