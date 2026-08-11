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
    }>
  | Readonly<{
      kind: "json_dependency_present";
      path: string;
      dependencies: readonly string[];
    }>
  | Readonly<{
      kind: "aws_sdk_v2_source";
      path: string;
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
    }>
  | Readonly<{
      kind: "aws_dependency_swap";
      path: string;
      remove: readonly string[];
      add: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      kind: "aws_sdk_source_v2_to_v3";
      path: string;
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

export type GitBlobMode = "100644" | "100755";

export type RecipeFileModes = Readonly<Record<string, GitBlobMode>>;

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
  analysis: RecipeAnalysis;
  inputDigest: string;
  outputDigest: string;
  files: RecipeFiles;
  operations: readonly RecipeOperation[];
  verificationCommands: readonly RecipeVerificationCommand[];
}>;

export type RecipeApplicability = "applicable" | "already_applied" | "unsupported";

export type RecipeAnalysis = Readonly<{
  recipe: RecipeReference;
  sourceDigest: string;
  status: RecipeApplicability;
  matchedPaths: readonly string[];
  estimatedOperations: number;
  reasons: readonly string[];
  cacheHit: boolean;
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

const NODE_RUNTIME_18_TO_20_V1 = createRecipe({
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

const RUNTIME_DECLARATIONS_SCRIPT =
  "const fs=require('node:fs');const fail=()=>{throw new Error('runtime declaration mismatch')};for(const p of ['.nvmrc','.node-version']){if(!fs.existsSync(p))continue;const v=fs.readFileSync(p,'utf8').trim().replace(/^v/,'').split('.')[0];if(v!=='20')fail()}if(fs.existsSync('Dockerfile')){const d=fs.readFileSync('Dockerfile','utf8').split(/\\r?\\n/).filter(l=>/^\\s*FROM\\b/i.test(l)&&/\\bnode:/i.test(l));if(!d.length||d.some(l=>!/^\\s*FROM(?:\\s+--\\S+)?\\s+node:20(?=[.\\-@\\s]|$)/i.test(l)))fail()}";

const NODE_RUNTIME_18_TO_20_V2 = createRecipe({
  id: NODE_RUNTIME_18_TO_20_V1.id,
  version: 2,
  title: NODE_RUNTIME_18_TO_20_V1.title,
  source: NODE_RUNTIME_18_TO_20_V1.source,
  target: NODE_RUNTIME_18_TO_20_V1.target,
  allowedPaths: NODE_RUNTIME_18_TO_20_V1.allowedPaths,
  preconditions: NODE_RUNTIME_18_TO_20_V1.preconditions,
  transforms: NODE_RUNTIME_18_TO_20_V1.transforms,
  verificationCommands: [
    {
      id: "runtime-declarations",
      command: `node -e "${RUNTIME_DECLARATIONS_SCRIPT}"`,
      successCriteria: "Optional runtime declarations target Node 20",
    },
    NODE_RUNTIME_18_TO_20_V1.verificationCommands.find(
      (command) => command.id === "package-engine",
    )!,
  ],
  rollback: NODE_RUNTIME_18_TO_20_V1.rollback,
});

// ---------------------------------------------------------------------------
// AWS SDK for JavaScript v2 -> v3 (bounded, deterministic subset)
//
// Supported surface (everything else is reported out-of-scope by analysis, so
// the recipe abstains rather than producing a wrong edit):
//   - Module import of the default `aws-sdk` namespace, either
//     `const AWS = require("aws-sdk")` (CommonJS) or `import AWS from "aws-sdk"`
//     (ESM). Any other alias or import form is out-of-scope.
//   - Clients: `new AWS.S3(...)` and `new AWS.DynamoDB.DocumentClient(...)`.
//     Any other `new AWS.<Service>(...)` is out-of-scope.
//   - S3 operations getObject/putObject/deleteObject/headObject/listObjectsV2
//     and DocumentClient operations get/put/delete/query/update/scan, used in
//     `.<op>(<params>).promise()` call style with no nested parentheses in the
//     params. Callback style, unsupported operations, or nested-paren params
//     are out-of-scope.
//   - package.json: drops the `aws-sdk` dependency and adds the v3 packages for
//     the supported services.
// The edits are content-addressed replace_file operations over an allowlisted
// set of paths, mirroring the Node runtime recipe.
// ---------------------------------------------------------------------------

const AWS_S3_OPERATIONS: Readonly<Record<string, string>> = {
  getObject: "GetObjectCommand",
  putObject: "PutObjectCommand",
  deleteObject: "DeleteObjectCommand",
  headObject: "HeadObjectCommand",
  listObjectsV2: "ListObjectsV2Command",
};

const AWS_DOC_OPERATIONS: Readonly<Record<string, string>> = {
  get: "GetCommand",
  put: "PutCommand",
  delete: "DeleteCommand",
  query: "QueryCommand",
  update: "UpdateCommand",
  scan: "ScanCommand",
};

const AWS_OPERATION_COMMANDS: Readonly<Record<string, string>> = {
  ...AWS_S3_OPERATIONS,
  ...AWS_DOC_OPERATIONS,
};

const AWS_MODULE_SYMBOLS: readonly (readonly [string, readonly string[]])[] = [
  [
    "@aws-sdk/client-s3",
    [
      "S3Client",
      "GetObjectCommand",
      "PutObjectCommand",
      "DeleteObjectCommand",
      "HeadObjectCommand",
      "ListObjectsV2Command",
    ],
  ],
  ["@aws-sdk/client-dynamodb", ["DynamoDBClient"]],
  [
    "@aws-sdk/lib-dynamodb",
    [
      "DynamoDBDocumentClient",
      "GetCommand",
      "PutCommand",
      "DeleteCommand",
      "QueryCommand",
      "UpdateCommand",
      "ScanCommand",
    ],
  ],
];

const AWS_SDK_V3_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@aws-sdk/client-s3": "^3.658.0",
  "@aws-sdk/client-dynamodb": "^3.658.0",
  "@aws-sdk/lib-dynamodb": "^3.658.0",
};

const AWS_REQUIRE_LINE =
  /^([ \t]*)(?:const|let|var)\s+AWS\s*=\s*require\(\s*["']aws-sdk["']\s*\);?[ \t]*\r?$/m;
const AWS_IMPORT_LINE = /^([ \t]*)import\s+AWS\s+from\s+["']aws-sdk["'];?[ \t]*\r?$/m;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function awsConstructorArgs(args: string): string {
  const trimmed = args.trim();
  return trimmed.length ? trimmed : "{}";
}

function buildAwsImportBlock(source: string, syntax: "cjs" | "esm", indent: string): string {
  const lines: string[] = [];
  for (const [moduleName, symbols] of AWS_MODULE_SYMBOLS) {
    const used = symbols.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(source));
    if (!used.length) continue;
    const named = used.join(", ");
    lines.push(
      syntax === "esm"
        ? `${indent}import { ${named} } from "${moduleName}";`
        : `${indent}const { ${named} } = require("${moduleName}");`,
    );
  }
  return lines.join("\n");
}

function rewriteAwsSource(content: string): string {
  const requireMatch = AWS_REQUIRE_LINE.exec(content);
  const importMatch = requireMatch ? null : AWS_IMPORT_LINE.exec(content);
  const syntax: "cjs" | "esm" | undefined = requireMatch ? "cjs" : importMatch ? "esm" : undefined;
  if (!syntax) return content;
  const indent = (requireMatch ?? importMatch)![1] ?? "";

  let out = content;
  out = out.replace(
    /new\s+AWS\.DynamoDB\.DocumentClient\(([^()]*)\)/g,
    (_match, args: string) =>
      `DynamoDBDocumentClient.from(new DynamoDBClient(${awsConstructorArgs(args)}))`,
  );
  out = out.replace(
    /new\s+AWS\.S3\(([^()]*)\)/g,
    (_match, args: string) => `new S3Client(${awsConstructorArgs(args)})`,
  );
  out = out.replace(
    /\.(getObject|putObject|deleteObject|headObject|listObjectsV2|get|put|delete|query|update|scan)\(([^()]*)\)\.promise\(\)/g,
    (match, op: string, args: string) => {
      const command = AWS_OPERATION_COMMANDS[op];
      return command ? `.send(new ${command}(${args}))` : match;
    },
  );

  const importBlock = buildAwsImportBlock(out, syntax, indent);
  out = out.replace(syntax === "cjs" ? AWS_REQUIRE_LINE : AWS_IMPORT_LINE, () => importBlock);
  return out;
}

function swapAwsDependencies(
  content: string,
  remove: readonly string[],
  add: Readonly<Record<string, string>>,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return content;
  const record = parsed as Record<string, unknown>;
  const current = record.dependencies;
  const deps: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  let changed = false;
  for (const dependency of remove) {
    if (dependency in deps) {
      delete deps[dependency];
      changed = true;
    }
  }
  for (const [dependency, version] of Object.entries(add)) {
    if (deps[dependency] !== version) {
      deps[dependency] = version;
      changed = true;
    }
  }
  if (!changed) return content;
  record.dependencies = deps;
  return `${stableJson(record, true)}\n`;
}

function classifyAwsSource(content: string): PreconditionState {
  const hasV2Import = AWS_REQUIRE_LINE.test(content) || AWS_IMPORT_LINE.test(content);
  const hasAwsMember = /\bAWS\.[A-Za-z]/.test(content);
  const hasPromise = /\.promise\(\)/.test(content);
  const hasV3 = /@aws-sdk\//.test(content);
  const hasV2 = hasV2Import || hasAwsMember || hasPromise;
  if (!hasV2 && !hasV3) return { state: "neutral" };
  if (!hasV2) return { state: "target" };
  if (!hasV2Import) {
    return { state: "unsupported", reason: "recipe_aws_import_unrecognized" };
  }
  const unsupportedService = [...content.matchAll(/new\s+AWS\.([A-Za-z0-9_.]+)\s*\(/g)]
    .map((match) => match[1]!)
    .find((service) => service !== "S3" && service !== "DynamoDB.DocumentClient");
  if (unsupportedService) {
    return { state: "unsupported", reason: `recipe_aws_unsupported_service:${unsupportedService}` };
  }
  const clients: Array<readonly [string, Readonly<Record<string, string>>]> = [];
  for (const match of content.matchAll(
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*new\s+AWS\.S3\b/g,
  )) {
    clients.push([match[1]!, AWS_S3_OPERATIONS]);
  }
  for (const match of content.matchAll(
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*new\s+AWS\.DynamoDB\.DocumentClient\b/g,
  )) {
    clients.push([match[1]!, AWS_DOC_OPERATIONS]);
  }
  for (const [name, operations] of clients) {
    const escaped = escapeRegExp(name);
    const calls = [...content.matchAll(new RegExp(`\\b${escaped}\\.([A-Za-z0-9_]+)\\s*\\(`, "g"))];
    for (const call of calls) {
      if (!(call[1]! in operations)) {
        return {
          state: "unsupported",
          reason: `recipe_aws_unsupported_operation:${name}.${call[1]}`,
        };
      }
    }
    const promiseCalls = content.match(
      new RegExp(
        `\\b${escaped}\\.(?:${Object.keys(operations).join("|")})\\([^()]*\\)\\.promise\\(\\)`,
        "g",
      ),
    );
    if ((promiseCalls?.length ?? 0) !== calls.length) {
      return { state: "unsupported", reason: `recipe_aws_unsupported_call_style:${name}` };
    }
  }
  const transformed = rewriteAwsSource(content);
  if (
    /require\(\s*["']aws-sdk["']\s*\)/.test(transformed) ||
    /from\s+["']aws-sdk["']/.test(transformed) ||
    /\bAWS\.[A-Za-z]/.test(transformed) ||
    /\.promise\(\)/.test(transformed)
  ) {
    return { state: "unsupported", reason: "recipe_aws_residual_v2_surface" };
  }
  return { state: "source" };
}

function classifyAwsDependencies(
  content: string,
  removes: readonly string[],
  swap: Extract<RecipeTransform, { kind: "aws_dependency_swap" }> | undefined,
): PreconditionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { state: "unsupported", reason: "recipe_aws_manifest_invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "unsupported", reason: "recipe_aws_manifest_invalid" };
  }
  const dependencies = (parsed as Record<string, unknown>).dependencies;
  const deps: Record<string, unknown> =
    dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
      ? (dependencies as Record<string, unknown>)
      : {};
  if (removes.some((dependency) => deps[dependency] !== undefined)) return { state: "source" };
  const adds = swap ? Object.keys(swap.add) : [];
  if (adds.length && adds.every((dependency) => deps[dependency] !== undefined)) {
    return { state: "target" };
  }
  return { state: "neutral" };
}

const AWS_SDK_SOURCE_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const files=['src/s3.js','src/dynamo.js'];let migrated=0;" +
  "for(const f of files){if(!fs.existsSync(f))continue;const s=fs.readFileSync(f,'utf8');" +
  "if(/[\\x27\\x22]aws-sdk[\\x27\\x22]/.test(s))fail('aws_sdk_module_ref:'+f);" +
  "if(/\\bnew AWS\\./.test(s))fail('aws_v2_client:'+f);" +
  "if(/\\.promise\\(\\)/.test(s))fail('aws_v2_promise:'+f);" +
  "if(/@aws-sdk\\//.test(s))migrated++;}" +
  "if(migrated===0)fail('aws_v3_imports_missing');";

const AWS_SDK_MANIFEST_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const p=JSON.parse(fs.readFileSync('package.json','utf8'));" +
  "const d=Object.assign({},p.dependencies||{});" +
  "if(d['aws-sdk']!==undefined)fail('aws_sdk_dependency_present');" +
  "if(d['@aws-sdk/client-s3']===undefined&&d['@aws-sdk/client-dynamodb']===undefined)" +
  "fail('aws_v3_dependency_missing');";

const AWS_SDK_JS_V2_TO_V3_V1 = createRecipe({
  id: "aws-sdk-js-v2-to-v3",
  version: 1,
  title: "AWS SDK for JavaScript v2 to v3 (S3 and DynamoDB DocumentClient)",
  source: "aws-sdk-v2",
  target: "aws-sdk-v3",
  allowedPaths: ["package.json", "src/dynamo.js", "src/s3.js"],
  preconditions: [
    { kind: "json_dependency_present", path: "package.json", dependencies: ["aws-sdk"] },
    { kind: "aws_sdk_v2_source", path: "src/s3.js" },
    { kind: "aws_sdk_v2_source", path: "src/dynamo.js" },
  ],
  transforms: [
    {
      kind: "aws_dependency_swap",
      path: "package.json",
      remove: ["aws-sdk"],
      add: AWS_SDK_V3_DEPENDENCIES,
    },
    { kind: "aws_sdk_source_v2_to_v3", path: "src/s3.js" },
    { kind: "aws_sdk_source_v2_to_v3", path: "src/dynamo.js" },
  ],
  verificationCommands: [
    {
      id: "aws-sdk-v3-source",
      command: `node -e "${AWS_SDK_SOURCE_VERIFIER}"`,
      successCriteria:
        "Migrated sources import @aws-sdk v3 modules with no aws-sdk import, no new AWS. client, and no .promise() usage",
    },
    {
      id: "aws-sdk-v3-manifest",
      command: `node -e "${AWS_SDK_MANIFEST_VERIFIER}"`,
      successCriteria: "package.json drops aws-sdk and declares the v3 client packages",
    },
  ],
  rollback: {
    strategy: "inverse_operations",
    requireCurrentDigest: true,
  },
});

export const AWS_SDK_JS_V2_TO_V3_RECIPE = AWS_SDK_JS_V2_TO_V3_V1;

const RECIPE_REGISTRY = new Map<string, MigrationRecipeContract>([
  [
    `${NODE_RUNTIME_18_TO_20_V1.id}@${NODE_RUNTIME_18_TO_20_V1.version}`,
    NODE_RUNTIME_18_TO_20_V1,
  ],
  [
    `${NODE_RUNTIME_18_TO_20_V2.id}@${NODE_RUNTIME_18_TO_20_V2.version}`,
    NODE_RUNTIME_18_TO_20_V2,
  ],
  [
    `${AWS_SDK_JS_V2_TO_V3_V1.id}@${AWS_SDK_JS_V2_TO_V3_V1.version}`,
    AWS_SDK_JS_V2_TO_V3_V1,
  ],
]);

export const NODE_RUNTIME_18_TO_20_RECIPE = NODE_RUNTIME_18_TO_20_V2;

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

export function normalizeRecipeFileModes(
  files: RecipeFiles,
  fileModes: RecipeFileModes,
): RecipeFileModes {
  const filePaths = Object.keys(normalizeFiles(files)).sort();
  if (!fileModes || typeof fileModes !== "object" || Array.isArray(fileModes)) {
    throw new Error("recipe_file_modes_paths_mismatch");
  }
  const modePaths = Object.keys(fileModes).sort();
  if (
    filePaths.length !== modePaths.length ||
    filePaths.some((path, index) => path !== modePaths[index])
  ) {
    throw new Error("recipe_file_modes_paths_mismatch");
  }
  const normalized: Record<string, GitBlobMode> = {};
  for (const path of modePaths) {
    validatePath(path);
    const mode = fileModes[path];
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(`recipe_file_mode_unsupported:${path}`);
    }
    normalized[path] = mode;
  }
  return deepFreeze(normalized);
}

export function recipeFilesDigest(files: RecipeFiles): string {
  const normalized = normalizeFiles(files);
  const framed = Object.entries(normalized)
    .map(([path, content]) => `${path.length}:${path}${content.length}:${content}`)
    .join("");
  return sha256(framed);
}

type PreconditionState = Readonly<{
  state: "source" | "target" | "neutral" | "unsupported";
  reason?: string;
}>;

function preconditionFailure(precondition: RecipePrecondition): string {
  return precondition.kind === "json_string_in"
    ? `recipe_precondition_failed:${precondition.path}:${precondition.pointer}`
    : `recipe_precondition_failed:${precondition.path}:node_major`;
}

function expectedTransform(
  recipe: MigrationRecipeContract,
  precondition: RecipePrecondition,
): RecipeTransform | undefined {
  return recipe.transforms.find((transform) => transform.path === precondition.path);
}

function preconditionState(
  recipe: MigrationRecipeContract,
  files: Record<string, string>,
  precondition: RecipePrecondition,
): PreconditionState {
  const transform = expectedTransform(recipe, precondition);
  if (precondition.kind === "aws_sdk_v2_source") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyAwsSource(content);
  }
  if (precondition.kind === "json_dependency_present") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    const swap = transform?.kind === "aws_dependency_swap" ? transform : undefined;
    return classifyAwsDependencies(content, precondition.dependencies, swap);
  }
  if (precondition.kind === "json_string_in") {
    let value: unknown;
    try {
      value = nodeEngineValue(readPackageJson(files, precondition.path));
    } catch (error) {
      return {
        state: "unsupported",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (typeof value === "string" && precondition.allowedValues.includes(value)) {
      return { state: "source" };
    }
    if (transform?.kind === "json_string_set" && value === transform.value) {
      return { state: "target" };
    }
    return {
      state: "unsupported",
      reason: preconditionFailure(precondition),
    };
  }

  const content = files[precondition.path];
  if (content === undefined) return { state: "neutral" };
  if (precondition.kind === "optional_node_version") {
    const major = content.trim().replace(/^v/, "").split(".")[0];
    if (major === String(precondition.major)) return { state: "source" };
    if (
      transform?.kind === "node_version_set" &&
      major === transform.value.trim().replace(/^v/, "").split(".")[0]
    ) {
      return { state: "target" };
    }
    return {
      state: "unsupported",
      reason: preconditionFailure(precondition),
    };
  }

  const majors = [...content.matchAll(/^\s*FROM\s+node:(\d+)(?=[.\-\s]|$)/gim)].map(
    (match) => Number(match[1]),
  );
  if (!majors.length) return { state: "neutral" };
  if (majors.every((major) => major === precondition.major)) return { state: "source" };
  if (
    transform?.kind === "docker_node_major_set" &&
    majors.every((major) => major === transform.toMajor)
  ) {
    return { state: "target" };
  }
  return {
    state: "unsupported",
    reason: preconditionFailure(precondition),
  };
}

function analyzeRecipeUncached(
  reference: RecipeReference,
  input: RecipeFiles,
): RecipeAnalysis {
  const recipe = resolveRecipe(reference);
  const files = normalizeFiles(input);
  const sourceDigest = recipeFilesDigest(files);
  const states = recipe.preconditions.map((precondition) => ({
    path: precondition.path,
    ...preconditionState(recipe, files, precondition),
  }));
  const reasons = [...new Set(states.flatMap((item) => item.reason ? [item.reason] : []))];
  const hasSource = states.some((item) => item.state === "source");
  const targetStates = states.filter((item) => item.state === "target");
  if (!reasons.length && hasSource && targetStates.length) {
    reasons.push(...targetStates.map((item) => {
      const precondition = recipe.preconditions.find((entry) => entry.path === item.path)!;
      return preconditionFailure(precondition);
    }));
  }
  const matchedPaths = [...new Set(
    states.filter((item) => item.state === "source").map((item) => item.path),
  )].sort();
  const status: RecipeApplicability = reasons.length
    ? "unsupported"
    : hasSource
      ? "applicable"
      : "already_applied";
  return deepFreeze({
    recipe: recipeReference(recipe),
    sourceDigest,
    status,
    matchedPaths: status === "applicable" ? matchedPaths : [],
    estimatedOperations: status === "applicable" ? matchedPaths.length : 0,
    reasons,
    cacheHit: false,
  });
}

export function analyzeRecipe(
  reference: RecipeReference,
  input: RecipeFiles,
): RecipeAnalysis {
  return analyzeRecipeUncached(reference, input);
}

type CachedRecipeAnalysis = Omit<RecipeAnalysis, "cacheHit">;

export class RecipeAnalysisCache {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, CachedRecipeAnalysis>();
  #hits = 0;
  #misses = 0;

  constructor(maxEntries = 128) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) {
      throw new Error("recipe_analysis_cache_size_invalid");
    }
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
  }

  analyze(scope: string, reference: RecipeReference, input: RecipeFiles): RecipeAnalysis {
    if (!scope.trim()) throw new Error("recipe_analysis_scope_required");
    const sourceDigest = recipeFilesDigest(input);
    const key = sha256(`${scope.length}:${scope}${reference.digest}${sourceDigest}`);
    const cached = this.#entries.get(key);
    if (cached) {
      this.#hits++;
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return deepFreeze({ ...cached, cacheHit: true });
    }
    this.#misses++;
    const analysis = analyzeRecipeUncached(reference, input);
    const { cacheHit: _cacheHit, ...derived } = analysis;
    const entry = deepFreeze(derived);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
    return analysis;
  }

  apply(scope: string, reference: RecipeReference, input: RecipeFiles): RecipeApplication {
    const analysis = this.analyze(scope, reference, input);
    return applyRecipeWithAnalysis(
      reference,
      input,
      deepFreeze({ ...analysis, cacheHit: false }),
    );
  }

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
  } else if (transform.kind === "docker_node_major_set") {
    const marker = new RegExp(`^(\\s*FROM\\s+node:)${transform.fromMajor}(?=[.\\-\\s]|$)`, "gim");
    files[transform.path] = before!.replace(marker, `$1${transform.toMajor}`);
  } else if (transform.kind === "aws_dependency_swap") {
    files[transform.path] = swapAwsDependencies(before!, transform.remove, transform.add);
  } else {
    files[transform.path] = rewriteAwsSource(before!);
  }
}

function applyRecipeWithAnalysis(
  reference: RecipeReference,
  input: RecipeFiles,
  analysis: RecipeAnalysis,
): RecipeApplication {
  const recipe = resolveRecipe(reference);
  const original = normalizeFiles(input);
  if (
    analysis.recipe.id !== reference.id ||
    analysis.recipe.version !== reference.version ||
    analysis.recipe.digest !== reference.digest ||
    analysis.sourceDigest !== recipeFilesDigest(original)
  ) {
    throw new Error("recipe_analysis_binding_mismatch");
  }
  if (analysis.status === "unsupported") {
    throw new Error(analysis.reasons[0] ?? "recipe_precondition_failed");
  }
  if (analysis.status === "already_applied") throw new Error("recipe_already_applied");
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
    analysis,
    inputDigest: recipeFilesDigest(original),
    outputDigest: recipeFilesDigest(files),
    files,
    operations,
    verificationCommands: recipe.verificationCommands,
  });
}

export function applyRecipe(reference: RecipeReference, input: RecipeFiles): RecipeApplication {
  return applyRecipeWithAnalysis(reference, input, analyzeRecipeUncached(reference, input));
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
