import { createHash } from "node:crypto";
import { posix } from "node:path";

export type RecipeReference = Readonly<{
  id: string;
  version: number;
  digest: string;
}>;

export type RecipePrecondition =
  | Readonly<{
      kind: "json_string_in";
      path: string;
      pointer: "/engines/node";
      allowedValues: readonly string[];
    }>
  | Readonly<{
      kind: "optional_node_version";
      path: string;
      major: number;
    }>
  | Readonly<{
      kind: "optional_docker_node_major";
      path: string;
      major: number;
    }>;

export type RecipeTransform =
  | Readonly<{
      kind: "json_string_set";
      path: string;
      pointer: "/engines/node";
      value: string;
    }>
  | Readonly<{
      kind: "node_version_set";
      path: string;
      value: string;
    }>
  | Readonly<{
      kind: "docker_node_major_set";
      path: string;
      fromMajor: number;
      toMajor: number;
    }>;

export type RecipeVerificationCommand = Readonly<{
  id: string;
  command: string;
  successCriteria: string;
}>;

export type MigrationRecipeContract = Readonly<{
  id: string;
  version: number;
  digest: string;
  title: string;
  source: string;
  target: string;
  allowedPaths: readonly string[];
  preconditions: readonly RecipePrecondition[];
  transforms: readonly RecipeTransform[];
  verificationCommands: readonly RecipeVerificationCommand[];
  rollback: Readonly<{
    strategy: "inverse_operations";
    requireCurrentDigest: true;
  }>;
}>;

export type RecipeFiles = Readonly<Record<string, string>>;

export type RecipeOperation = Readonly<{
  kind: "replace_file";
  path: string;
  before: string;
  after: string;
  beforeDigest: string;
  afterDigest: string;
}>;

export type RecipeApplication = Readonly<{
  recipe: RecipeReference;
  inputDigest: string;
  outputDigest: string;
  files: RecipeFiles;
  operations: readonly RecipeOperation[];
  verificationCommands: readonly RecipeVerificationCommand[];
}>;

type RecipeDefinition = Omit<MigrationRecipeContract, "digest">;

const NODE_18_SELECTORS = ["18", "18.x", "^18.0.0", ">=18 <19"] as const;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown, pretty = false): string {
  return JSON.stringify(stableValue(value), null, pretty ? 2 : undefined);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function validatePath(path: string): string {
  if (!path || path.includes("\\") || posix.isAbsolute(path)) {
    throw new Error(`recipe_path_invalid:${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`recipe_path_invalid:${path}`);
  }
  return path;
}

function definitionDigest(definition: RecipeDefinition): string {
  return sha256(stableJson(definition));
}

function createRecipe(definition: RecipeDefinition): MigrationRecipeContract {
  const recipe = {
    ...definition,
    digest: definitionDigest(definition),
  } satisfies MigrationRecipeContract;
  validateRecipe(recipe);
  return deepFreeze(recipe);
}

const NODE_RUNTIME_18_TO_20 = createRecipe({
  id: "node-runtime-18-to-20",
  version: 1,
  title: "Node runtime 18 to 20",
  source: "node@18",
  target: "node@20",
  allowedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
  preconditions: [
    {
      kind: "json_string_in",
      path: "package.json",
      pointer: "/engines/node",
      allowedValues: NODE_18_SELECTORS,
    },
    { kind: "optional_node_version", path: ".nvmrc", major: 18 },
    { kind: "optional_node_version", path: ".node-version", major: 18 },
    { kind: "optional_docker_node_major", path: "Dockerfile", major: 18 },
  ],
  transforms: [
    {
      kind: "json_string_set",
      path: "package.json",
      pointer: "/engines/node",
      value: ">=20 <21",
    },
    { kind: "node_version_set", path: ".nvmrc", value: "20" },
    { kind: "node_version_set", path: ".node-version", value: "20" },
    {
      kind: "docker_node_major_set",
      path: "Dockerfile",
      fromMajor: 18,
      toMajor: 20,
    },
  ],
  verificationCommands: [
    {
      id: "node-major",
      command:
        "node -e \"if (Number(process.versions.node.split('.')[0]) !== 20) process.exit(1)\"",
      successCriteria: "The verifier executes on Node 20",
    },
    {
      id: "package-engine",
      command:
        "node -e \"const p=require('./package.json'); if(p.engines?.node !== '>=20 <21') process.exit(1)\"",
      successCriteria: "package.json requires Node 20",
    },
  ],
  rollback: {
    strategy: "inverse_operations",
    requireCurrentDigest: true,
  },
});

const RECIPE_REGISTRY = new Map<string, MigrationRecipeContract>([
  [`${NODE_RUNTIME_18_TO_20.id}@${NODE_RUNTIME_18_TO_20.version}`, NODE_RUNTIME_18_TO_20],
]);

export const NODE_RUNTIME_18_TO_20_RECIPE = NODE_RUNTIME_18_TO_20;

export function validateRecipe(recipe: MigrationRecipeContract): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipe.id)) throw new Error("recipe_id_invalid");
  if (!Number.isSafeInteger(recipe.version) || recipe.version < 1) {
    throw new Error("recipe_version_invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(recipe.digest)) throw new Error("recipe_digest_invalid");
  if (!recipe.allowedPaths.length || new Set(recipe.allowedPaths).size !== recipe.allowedPaths.length) {
    throw new Error("recipe_allowed_paths_invalid");
  }
  const allowedPaths = new Set(recipe.allowedPaths.map(validatePath));
  for (const item of [...recipe.preconditions, ...recipe.transforms]) {
    if (!allowedPaths.has(validatePath(item.path))) {
      throw new Error(`recipe_path_not_allowed:${item.path}`);
    }
  }
  if (!recipe.preconditions.length) throw new Error("recipe_preconditions_required");
  if (!recipe.transforms.length) throw new Error("recipe_transforms_required");
  if (!recipe.verificationCommands.length) throw new Error("recipe_verification_required");
  if (new Set(recipe.verificationCommands.map((command) => command.id)).size !== recipe.verificationCommands.length) {
    throw new Error("recipe_verification_id_duplicate");
  }
  const { digest: _digest, ...definition } = recipe;
  if (definitionDigest(definition) !== recipe.digest) throw new Error("recipe_digest_mismatch");
}

export function getRecipe(id: string, version: number): MigrationRecipeContract {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("recipe_version_invalid");
  const recipe = RECIPE_REGISTRY.get(`${id}@${version}`);
  if (!recipe) throw new Error(`recipe_not_found:${id}@${version}`);
  return recipe;
}

export function resolveRecipe(reference: RecipeReference): MigrationRecipeContract {
  const recipe = getRecipe(reference.id, reference.version);
  if (reference.digest !== recipe.digest) throw new Error("recipe_digest_mismatch");
  return recipe;
}

export function recipeReference(recipe: MigrationRecipeContract): RecipeReference {
  validateRecipe(recipe);
  return deepFreeze({ id: recipe.id, version: recipe.version, digest: recipe.digest });
}

export function assertRecipePathAllowed(recipe: MigrationRecipeContract, path: string): void {
  const safePath = validatePath(path);
  if (!recipe.allowedPaths.includes(safePath)) throw new Error(`recipe_path_not_allowed:${safePath}`);
}

function normalizeFiles(files: RecipeFiles): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    validatePath(path);
    if (typeof content !== "string") throw new Error(`recipe_file_content_invalid:${path}`);
    normalized[path] = content;
  }
  return normalized;
}

export function recipeFilesDigest(files: RecipeFiles): string {
  const normalized = normalizeFiles(files);
  const framed = Object.entries(normalized)
    .map(([path, content]) => `${path.length}:${path}${content.length}:${content}`)
    .join("");
  return sha256(framed);
}

function readPackageJson(files: Record<string, string>, path: string): Record<string, unknown> {
  const content = files[path];
  if (content === undefined) throw new Error(`recipe_precondition_missing:${path}`);
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`recipe_precondition_invalid_json:${path}`);
  }
}

function nodeEngineValue(value: Record<string, unknown>): unknown {
  const engines = value.engines;
  return engines && typeof engines === "object" && !Array.isArray(engines)
    ? (engines as Record<string, unknown>).node
    : undefined;
}

function assertPreconditions(recipe: MigrationRecipeContract, files: Record<string, string>): void {
  for (const precondition of recipe.preconditions) {
    if (precondition.kind === "json_string_in") {
      const value = nodeEngineValue(readPackageJson(files, precondition.path));
      if (typeof value !== "string" || !precondition.allowedValues.includes(value)) {
        throw new Error(`recipe_precondition_failed:${precondition.path}:${precondition.pointer}`);
      }
      continue;
    }
    const content = files[precondition.path];
    if (content === undefined) continue;
    if (precondition.kind === "optional_node_version") {
      const major = content.trim().replace(/^v/, "").split(".")[0];
      if (major !== String(precondition.major)) {
        throw new Error(`recipe_precondition_failed:${precondition.path}:node_major`);
      }
      continue;
    }
    const majors = [...content.matchAll(/^\s*FROM\s+node:(\d+)(?=[.\-\s]|$)/gim)].map(
      (match) => Number(match[1]),
    );
    if (majors.some((major) => major !== precondition.major)) {
      throw new Error(`recipe_precondition_failed:${precondition.path}:node_major`);
    }
  }
}

function setNodeEngine(content: string, value: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const engines = parsed.engines as Record<string, unknown>;
  parsed.engines = { ...engines, node: value };
  return `${stableJson(parsed, true)}\n`;
}

function applyTransform(transform: RecipeTransform, files: Record<string, string>): void {
  const before = files[transform.path];
  if (before === undefined && transform.kind !== "json_string_set") return;
  if (transform.kind === "json_string_set") {
    files[transform.path] = setNodeEngine(before!, transform.value);
  } else if (transform.kind === "node_version_set") {
    files[transform.path] = `${transform.value}\n`;
  } else {
    const marker = new RegExp(`^(\\s*FROM\\s+node:)${transform.fromMajor}(?=[.\\-\\s]|$)`, "gim");
    files[transform.path] = before!.replace(marker, `$1${transform.toMajor}`);
  }
}

export function applyRecipe(reference: RecipeReference, input: RecipeFiles): RecipeApplication {
  const recipe = resolveRecipe(reference);
  const original = normalizeFiles(input);
  assertPreconditions(recipe, original);
  const output = { ...original };
  for (const transform of recipe.transforms) {
    assertRecipePathAllowed(recipe, transform.path);
    applyTransform(transform, output);
  }
  const operations: RecipeOperation[] = [];
  for (const path of recipe.allowedPaths) {
    const before = original[path];
    const after = output[path];
    if (before === undefined || after === undefined || before === after) continue;
    operations.push(
      deepFreeze({
        kind: "replace_file" as const,
        path,
        before,
        after,
        beforeDigest: sha256(before),
        afterDigest: sha256(after),
      }),
    );
  }
  if (!operations.length) throw new Error("recipe_no_changes");
  const files = deepFreeze(normalizeFiles(output));
  return deepFreeze({
    recipe: recipeReference(recipe),
    inputDigest: recipeFilesDigest(original),
    outputDigest: recipeFilesDigest(files),
    files,
    operations,
    verificationCommands: recipe.verificationCommands,
  });
}

export function applyInverseOperations(
  reference: RecipeReference,
  input: RecipeFiles,
  operations: readonly RecipeOperation[],
): RecipeFiles {
  const recipe = resolveRecipe(reference);
  const output = normalizeFiles(input);
  for (const operation of [...operations].reverse()) {
    assertRecipePathAllowed(recipe, operation.path);
    const current = output[operation.path];
    if (current === undefined || sha256(current) !== operation.afterDigest || current !== operation.after) {
      throw new Error(`recipe_inverse_drift:${operation.path}`);
    }
    if (sha256(operation.before) !== operation.beforeDigest) {
      throw new Error(`recipe_inverse_invalid:${operation.path}`);
    }
    output[operation.path] = operation.before;
  }
  return deepFreeze(normalizeFiles(output));
}
