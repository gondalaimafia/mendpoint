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
    }>
  | Readonly<{
      kind: "json_dependency_version";
      path: string;
      dependency: string;
    }>
  | Readonly<{
      kind: "stripe_v10_setter_source";
      path: string;
    }>
  | Readonly<{
      kind: "googleapis_default_import_source";
      path: string;
    }>
  | Readonly<{
      kind: "react_dom_render_source";
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
    }>
  | Readonly<{
      kind: "json_dependency_version_set";
      path: string;
      dependency: string;
      version: string;
    }>
  | Readonly<{
      kind: "stripe_setter_to_config";
      path: string;
    }>
  | Readonly<{
      kind: "googleapis_default_import_to_named";
      path: string;
    }>
  | Readonly<{
      kind: "react_dom_render_to_root";
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
const NODE_20_SELECTORS = ["20", "20.x", "^20.0.0", ">=20 <21"] as const;

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
// Node runtime 20 -> 22 (language/runtime family, flagship)
//
// Bumps the Node major-version pins across the same allowlisted config surface
// the 18->20 recipe handles: the `.nvmrc`/`.node-version` runtime declarations,
// the `Dockerfile` base image tag, and the `package.json` `engines.node` range.
// It reuses the existing runtime precondition and transform kinds rather than
// inventing new ones.
//
// Supported surface (everything else is reported out-of-scope by analysis, so
// the recipe abstains rather than producing a wrong edit):
//   - `package.json` `engines.node` equal to one of the recognized Node 20
//     selectors (`20`, `20.x`, `^20.0.0`, `>=20 <21`). A non-numeric or ranged
//     value outside that set (for example `>=20`) is out-of-scope.
//   - `.nvmrc` / `.node-version` whose major reads `20` (optional files).
//   - `Dockerfile` `FROM node:20...` base image tags (optional file). A base
//     image at any other major (for example `node:21`) is out-of-scope.
// A repository whose pins already read Node 22 classifies as already applied.
// ---------------------------------------------------------------------------

const RUNTIME_DECLARATIONS_SCRIPT_22 =
  "const fs=require('node:fs');const fail=()=>{throw new Error('runtime declaration mismatch')};for(const p of ['.nvmrc','.node-version']){if(!fs.existsSync(p))continue;const v=fs.readFileSync(p,'utf8').trim().replace(/^v/,'').split('.')[0];if(v!=='22')fail()}if(fs.existsSync('Dockerfile')){const d=fs.readFileSync('Dockerfile','utf8').split(/\\r?\\n/).filter(l=>/^\\s*FROM\\b/i.test(l)&&/\\bnode:/i.test(l));if(!d.length||d.some(l=>!/^\\s*FROM(?:\\s+--\\S+)?\\s+node:22(?=[.\\-@\\s]|$)/i.test(l)))fail()}";

const NODE_RUNTIME_20_TO_22_V1 = createRecipe({
  id: "node-runtime-20-to-22",
  version: 1,
  title: "Node runtime 20 to 22",
  source: "node@20",
  target: "node@22",
  allowedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
  preconditions: [
    {
      kind: "json_string_in",
      path: "package.json",
      pointer: "/engines/node",
      allowedValues: NODE_20_SELECTORS,
    },
    { kind: "optional_node_version", path: ".nvmrc", major: 20 },
    { kind: "optional_node_version", path: ".node-version", major: 20 },
    { kind: "optional_docker_node_major", path: "Dockerfile", major: 20 },
  ],
  transforms: [
    {
      kind: "json_string_set",
      path: "package.json",
      pointer: "/engines/node",
      value: ">=22 <23",
    },
    { kind: "node_version_set", path: ".nvmrc", value: "22" },
    { kind: "node_version_set", path: ".node-version", value: "22" },
    {
      kind: "docker_node_major_set",
      path: "Dockerfile",
      fromMajor: 20,
      toMajor: 22,
    },
  ],
  verificationCommands: [
    {
      id: "runtime-declarations",
      command: `node -e "${RUNTIME_DECLARATIONS_SCRIPT_22}"`,
      successCriteria: "Optional runtime declarations target Node 22",
    },
    {
      id: "package-engine",
      command:
        "node -e \"const p=require('./package.json'); if(p.engines?.node !== '>=22 <23') process.exit(1)\"",
      successCriteria: "package.json requires Node 22",
    },
  ],
  rollback: {
    strategy: "inverse_operations",
    requireCurrentDigest: true,
  },
});

export const NODE_RUNTIME_20_TO_22_RECIPE = NODE_RUNTIME_20_TO_22_V1;

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

// ---------------------------------------------------------------------------
// Generic manifest dependency version bump (shared by the stripe-node and
// googleapis recipes). It only changes the version range of an existing
// dependency; it never adds or removes a package. Source/target classification
// mirrors the runtime-declaration transforms: a manifest whose dependency range
// already equals the target range classifies as `target` (already applied), a
// present-but-different range as `source`, and an absent dependency as neutral.
// ---------------------------------------------------------------------------

function readDependencies(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const dependencies = (parsed as Record<string, unknown>).dependencies;
  return dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
    ? (dependencies as Record<string, unknown>)
    : {};
}

function classifyDependencyVersion(
  content: string,
  dependency: string,
  transform: Extract<RecipeTransform, { kind: "json_dependency_version_set" }> | undefined,
): PreconditionState {
  const deps = readDependencies(content);
  if (!deps) return { state: "unsupported", reason: `recipe_manifest_invalid:${dependency}` };
  const value = deps[dependency];
  if (value === undefined) return { state: "neutral" };
  if (transform && value === transform.version) return { state: "target" };
  if (typeof value === "string") return { state: "source" };
  return { state: "unsupported", reason: `recipe_manifest_invalid:${dependency}` };
}

function setDependencyVersion(content: string, dependency: string, version: string): string {
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
  if (deps[dependency] === version) return content;
  deps[dependency] = version;
  record.dependencies = deps;
  return `${stableJson(record, true)}\n`;
}

// ---------------------------------------------------------------------------
// Stripe Node v10 -> v11 (bounded, deterministic subset)
//
// v11 removed the deprecated client configuration setter methods
// (https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v11). The
// supported values are moved into the options object passed as the second
// argument to the Stripe constructor.
//
// Supported surface (everything else is reported out-of-scope by analysis, so
// the recipe abstains rather than producing a wrong edit):
//   - Exactly one client construction that binds a variable, of the form
//     `const <var> = Stripe(<key>)`, `const <var> = new Stripe(<key>)`, or
//     `const <var> = require("stripe")(<key>)`. The `<key>` argument must be a
//     single expression with no nested parentheses, comma, or object literal
//     (an existing options object is out-of-scope).
//   - Setter calls `<var>.<setter>(<value>)` in `.setX(...).` statement style
//     with no nested parentheses in `<value>`, where `<setter>` is one of:
//     setApiVersion, setTimeout, setHost, setPort, setProtocol,
//     setMaxNetworkRetries, setTelemetryEnabled, setAppInfo, setHttpAgent.
//   - package.json: bumps the existing `stripe` dependency range to v11.
// `setApiKey` (which changes the first constructor argument), unrecognized
// setters, callback/nested-paren call styles, missing or multiple constructions,
// and an already-present options object are all out-of-scope.
// ---------------------------------------------------------------------------

const STRIPE_SETTER_CONFIG: Readonly<Record<string, string>> = {
  setApiVersion: "apiVersion",
  setTimeout: "timeout",
  setHost: "host",
  setPort: "port",
  setProtocol: "protocol",
  setMaxNetworkRetries: "maxNetworkRetries",
  setTelemetryEnabled: "telemetry",
  setAppInfo: "appInfo",
  setHttpAgent: "httpAgent",
};

const STRIPE_ALL_SETTERS =
  "ApiVersion|Timeout|Host|Port|Protocol|MaxNetworkRetries|TelemetryEnabled|AppInfo|HttpAgent|ApiKey";
const STRIPE_DOTTED_SETTER = new RegExp(`\\.set(?:${STRIPE_ALL_SETTERS})[ \\t]*\\(`);
const STRIPE_CONSTRUCTION_SOURCE =
  "^([ \\t]*)((?:const|let|var)[ \\t]+([A-Za-z0-9_$]+)[ \\t]*=[ \\t]*" +
  "(?:new[ \\t]+Stripe|Stripe|require\\([ \\t]*[\"']stripe[\"'][ \\t]*\\))[ \\t]*\\(([^()]*)\\))";

function stripeConstructions(content: string): RegExpMatchArray[] {
  return [...content.matchAll(new RegExp(STRIPE_CONSTRUCTION_SOURCE, "gm"))];
}

function stripeConstructionUsable(match: RegExpMatchArray): boolean {
  const keyArg = match[4] ?? "";
  return keyArg.trim().length > 0 && !/[,{}]/.test(keyArg);
}

function rewriteStripeSource(content: string): string {
  const constructions = stripeConstructions(content);
  if (constructions.length !== 1) return content;
  const match = constructions[0]!;
  const indent = match[1] ?? "";
  const body = match[2]!;
  const varName = match[3]!;
  const keyArg = match[4]!;
  if (!stripeConstructionUsable(match)) return content;
  const escaped = escapeRegExp(varName);
  const setterLine = new RegExp(
    `^[ \\t]*${escaped}\\.set([A-Za-z0-9]+)[ \\t]*\\(([^()]*)\\)[ \\t]*;?[ \\t]*\\r?\\n?`,
    "gm",
  );
  const entries: string[] = [];
  const withoutSetters = content.replace(setterLine, (whole, name: string, value: string) => {
    const key = STRIPE_SETTER_CONFIG[`set${name}`];
    if (!key) return whole;
    entries.push(`${indent}  ${key}: ${value.trim()},`);
    return "";
  });
  if (!entries.length) return content;
  const configObject = `{\n${entries.join("\n")}\n${indent}}`;
  const newBody = `${body.slice(0, body.lastIndexOf("("))}(${keyArg.trim()}, ${configObject})`;
  return withoutSetters.replace(body, () => newBody);
}

function classifyStripeSource(content: string): PreconditionState {
  const hasSetterSurface = STRIPE_DOTTED_SETTER.test(content);
  const constructions = stripeConstructions(content);
  if (!constructions.length) {
    return hasSetterSurface
      ? { state: "unsupported", reason: "recipe_stripe_construction_unrecognized" }
      : { state: "neutral" };
  }
  if (constructions.length > 1) {
    return { state: "unsupported", reason: "recipe_stripe_multiple_constructions" };
  }
  const match = constructions[0]!;
  if (!stripeConstructionUsable(match)) {
    // The construction already carries an options object. With no removed setters
    // remaining this is an already-migrated source (target); if setter calls are
    // still present it is a genuinely ambiguous mix, so abstain.
    return hasSetterSurface
      ? { state: "unsupported", reason: "recipe_stripe_constructor_options_present" }
      : { state: "target" };
  }
  const varName = match[3]!;
  const escaped = escapeRegExp(varName);
  const varSetters = [...content.matchAll(new RegExp(`\\b${escaped}\\.set([A-Za-z0-9]+)[ \\t]*\\(`, "g"))];
  if (!varSetters.length) {
    return hasSetterSurface
      ? { state: "unsupported", reason: "recipe_stripe_setter_unanchored" }
      : { state: "neutral" };
  }
  for (const setter of varSetters) {
    const name = `set${setter[1]}`;
    if (!(name in STRIPE_SETTER_CONFIG)) {
      return { state: "unsupported", reason: `recipe_stripe_unsupported_setter:${name}` };
    }
  }
  const supported = Object.keys(STRIPE_SETTER_CONFIG).map((setter) => setter.slice(3)).join("|");
  const cleanCalls = content.match(
    new RegExp(`\\b${escaped}\\.set(?:${supported})[ \\t]*\\([^()]*\\)`, "g"),
  );
  if ((cleanCalls?.length ?? 0) !== varSetters.length) {
    return { state: "unsupported", reason: "recipe_stripe_unsupported_call_style" };
  }
  const totalSurface = content.match(new RegExp(STRIPE_DOTTED_SETTER.source, "g"))?.length ?? 0;
  if (totalSurface !== varSetters.length) {
    return { state: "unsupported", reason: "recipe_stripe_setter_unanchored" };
  }
  if (STRIPE_DOTTED_SETTER.test(rewriteStripeSource(content))) {
    return { state: "unsupported", reason: "recipe_stripe_residual_setter" };
  }
  return { state: "source" };
}

// ---------------------------------------------------------------------------
// googleapis v25 -> v26 (bounded, deterministic subset)
//
// v26.0.0 optimized the package for es6 modules and made the default import a
// breaking change: `const google = require("googleapis")` must become the named
// import `const {google} = require("googleapis")`
// (https://github.com/googleapis/google-api-nodejs-client release notes for
// 26.0.0). This recipe rewrites the default import form to the named form and
// bumps the dependency range to v26. Consumer usages of `google.*` are byte
// identical before and after, so only the import line changes.
//
// Supported surface (everything else is out-of-scope, so the recipe abstains):
//   - CommonJS default require bound to an identifier:
//     `const <id> = require("googleapis")` becomes
//     `const {google} = require("googleapis")` when `<id>` is `google`, or
//     `const {google: <id>} = require("googleapis")` otherwise.
//   - ESM default import: `import <id> from "googleapis"` becomes
//     `import {google} from "googleapis"` (or `import {google as <id>}`).
//   - package.json: bumps the existing `googleapis` dependency range to v26.
// Namespace imports (`import * as x`), inline `require("googleapis").google`,
// and a default binding that already reads `<id>.google` (the v26 manual form)
// are out-of-scope.
// ---------------------------------------------------------------------------

const GOOGLEAPIS_DEFAULT_CJS =
  /(?:const|let|var)[ \t]+([A-Za-z0-9_$]+)[ \t]*=[ \t]*require\([ \t]*["']googleapis["'][ \t]*\)/;
const GOOGLEAPIS_DEFAULT_ESM = /import[ \t]+([A-Za-z0-9_$]+)[ \t]+from[ \t]*["']googleapis["']/;
const GOOGLEAPIS_NAMED_CJS =
  /(?:const|let|var)[ \t]*\{[^}]*\bgoogle\b[^}]*\}[ \t]*=[ \t]*require\([ \t]*["']googleapis["'][ \t]*\)/;
const GOOGLEAPIS_NAMED_ESM = /import[ \t]*\{[^}]*\bgoogle\b[^}]*\}[ \t]+from[ \t]*["']googleapis["']/;

function rewriteGoogleapisSource(content: string): string {
  let out = content.replace(
    /^([ \t]*)(const|let|var)[ \t]+([A-Za-z0-9_$]+)[ \t]*=[ \t]*require\([ \t]*["']googleapis["'][ \t]*\)[ \t]*;?[ \t]*\r?$/gm,
    (_whole, indent: string, keyword: string, id: string) =>
      id === "google"
        ? `${indent}${keyword} { google } = require("googleapis");`
        : `${indent}${keyword} { google: ${id} } = require("googleapis");`,
  );
  out = out.replace(
    /^([ \t]*)import[ \t]+([A-Za-z0-9_$]+)[ \t]+from[ \t]*["']googleapis["'][ \t]*;?[ \t]*\r?$/gm,
    (_whole, indent: string, id: string) =>
      id === "google"
        ? `${indent}import { google } from "googleapis";`
        : `${indent}import { google as ${id} } from "googleapis";`,
  );
  return out;
}

function classifyGoogleapisSource(content: string): PreconditionState {
  if (!/["']googleapis["']/.test(content)) return { state: "neutral" };
  const cjs = GOOGLEAPIS_DEFAULT_CJS.exec(content);
  const esm = GOOGLEAPIS_DEFAULT_ESM.exec(content);
  const binding = cjs?.[1] ?? esm?.[1];
  const named = GOOGLEAPIS_NAMED_CJS.test(content) || GOOGLEAPIS_NAMED_ESM.test(content);
  if (!binding) {
    return named
      ? { state: "target" }
      : { state: "unsupported", reason: "recipe_googleapis_import_unrecognized" };
  }
  if (new RegExp(`\\b${escapeRegExp(binding)}\\.google\\b`).test(content)) {
    return { state: "unsupported", reason: "recipe_googleapis_named_access_present" };
  }
  const transformed = rewriteGoogleapisSource(content);
  if (GOOGLEAPIS_DEFAULT_CJS.test(transformed) || GOOGLEAPIS_DEFAULT_ESM.test(transformed)) {
    return { state: "unsupported", reason: "recipe_googleapis_residual_default_import" };
  }
  return { state: "source" };
}

const STRIPE_SOURCE_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const files=['src/payments.js'];let checked=0;" +
  "for(const f of files){if(!fs.existsSync(f))continue;const s=fs.readFileSync(f,'utf8');" +
  "if(/\\.set(?:ApiVersion|Timeout|Host|Port|Protocol|MaxNetworkRetries|TelemetryEnabled|AppInfo|HttpAgent|ApiKey)\\s*\\(/.test(s))" +
  "fail('stripe_v10_setter_present:'+f);checked++;}" +
  "if(checked===0)fail('stripe_source_missing');";

const STRIPE_MANIFEST_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const p=JSON.parse(fs.readFileSync('package.json','utf8'));" +
  "const v=(p.dependencies||{}).stripe;" +
  "if(typeof v!==('str'+'ing'))fail('stripe_dependency_missing');" +
  "if(!/^[\\^~]?11\\./.test(v))fail('stripe_dependency_not_v11:'+v);";

const STRIPE_NODE_V10_TO_V11_V1 = createRecipe({
  id: "stripe-node-v10-to-v11",
  version: 1,
  title: "Stripe Node v10 to v11 (config setter methods to constructor options)",
  source: "stripe-node-v10",
  target: "stripe-node-v11",
  allowedPaths: ["package.json", "src/payments.js"],
  preconditions: [
    { kind: "json_dependency_version", path: "package.json", dependency: "stripe" },
    { kind: "stripe_v10_setter_source", path: "src/payments.js" },
  ],
  transforms: [
    {
      kind: "json_dependency_version_set",
      path: "package.json",
      dependency: "stripe",
      version: "^11.0.0",
    },
    { kind: "stripe_setter_to_config", path: "src/payments.js" },
  ],
  verificationCommands: [
    {
      id: "stripe-v11-source",
      command: `node -e "${STRIPE_SOURCE_VERIFIER}"`,
      successCriteria:
        "The migrated source contains no removed Stripe config setter calls",
    },
    {
      id: "stripe-v11-manifest",
      command: `node -e "${STRIPE_MANIFEST_VERIFIER}"`,
      successCriteria: "package.json declares the stripe dependency at v11",
    },
  ],
  rollback: {
    strategy: "inverse_operations",
    requireCurrentDigest: true,
  },
});

export const STRIPE_NODE_V10_TO_V11_RECIPE = STRIPE_NODE_V10_TO_V11_V1;

const GOOGLEAPIS_SOURCE_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const files=['src/client.js'];let named=0;" +
  "for(const f of files){if(!fs.existsSync(f))continue;const s=fs.readFileSync(f,'utf8');" +
  "if(/(?:const|let|var)\\s+[A-Za-z0-9_$]+\\s*=\\s*require\\(\\s*[\\x27\\x22]googleapis[\\x27\\x22]\\s*\\)/.test(s))" +
  "fail('googleapis_default_require:'+f);" +
  "if(/import\\s+[A-Za-z0-9_$]+\\s+from\\s+[\\x27\\x22]googleapis[\\x27\\x22]/.test(s))" +
  "fail('googleapis_default_import:'+f);" +
  "if(/\\{[^}]*\\bgoogle\\b[^}]*\\}\\s*=\\s*require\\(\\s*[\\x27\\x22]googleapis[\\x27\\x22]\\s*\\)/.test(s)||" +
  "/import\\s*\\{[^}]*\\bgoogle\\b[^}]*\\}\\s+from\\s+[\\x27\\x22]googleapis[\\x27\\x22]/.test(s))named++;}" +
  "if(named===0)fail('googleapis_named_import_missing');";

const GOOGLEAPIS_MANIFEST_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const p=JSON.parse(fs.readFileSync('package.json','utf8'));" +
  "const v=(p.dependencies||{}).googleapis;" +
  "if(typeof v!==('str'+'ing'))fail('googleapis_dependency_missing');" +
  "if(!/^[\\^~]?26\\./.test(v))fail('googleapis_dependency_not_v26:'+v);";

const GOOGLEAPIS_V25_TO_V26_V1 = createRecipe({
  id: "googleapis-v25-to-v26",
  version: 1,
  title: "googleapis v25 to v26 (default import to named google import)",
  source: "googleapis-v25",
  target: "googleapis-v26",
  allowedPaths: ["package.json", "src/client.js"],
  preconditions: [
    { kind: "json_dependency_version", path: "package.json", dependency: "googleapis" },
    { kind: "googleapis_default_import_source", path: "src/client.js" },
  ],
  transforms: [
    {
      kind: "json_dependency_version_set",
      path: "package.json",
      dependency: "googleapis",
      version: "^26.0.0",
    },
    { kind: "googleapis_default_import_to_named", path: "src/client.js" },
  ],
  verificationCommands: [
    {
      id: "googleapis-v26-source",
      command: `node -e "${GOOGLEAPIS_SOURCE_VERIFIER}"`,
      successCriteria:
        "The migrated source uses the named google import and no default googleapis import",
    },
    {
      id: "googleapis-v26-manifest",
      command: `node -e "${GOOGLEAPIS_MANIFEST_VERIFIER}"`,
      successCriteria: "package.json declares the googleapis dependency at v26",
    },
  ],
  rollback: {
    strategy: "inverse_operations",
    requireCurrentDigest: true,
  },
});

export const GOOGLEAPIS_V25_TO_V26_RECIPE = GOOGLEAPIS_V25_TO_V26_V1;

// ---------------------------------------------------------------------------
// React DOM 17 -> 18 client-render API (bounded, deterministic subset)
//
// React 18 replaced the legacy `ReactDOM.render`/`ReactDOM.hydrate` entry points
// with the `react-dom/client` root API (`createRoot`/`hydrateRoot`). This recipe
// rewrites the mechanically-deterministic slice of that migration and bumps the
// `react` and `react-dom` dependencies to v18. The supported surface is encoded
// explicitly; everything else is reported out-of-scope by analysis so the recipe
// abstains rather than producing a wrong edit.
//
// Supported surface:
//   - A default `react-dom` import bound to an identifier, either
//     `const <id> = require("react-dom")` (CommonJS) or
//     `import <id> from "react-dom"` (ESM), on its own single line. The migrated
//     import keeps the source module system and emits only the used symbols from
//     `react-dom/client`.
//   - `<id>.render(<element>, <container>)` becomes
//     `createRoot(<container>).render(<element>)`.
//   - `<id>.hydrate(<element>, <container>)` becomes
//     `hydrateRoot(<container>, <element>)`.
//   - Arguments are split on top-level commas with balanced-delimiter and string
//     scanning, so JSX elements and container expressions such as
//     `document.getElementById("root")` are relocated byte-for-byte.
//   - package.json: bumps the existing `react` and `react-dom` ranges to v18.
//
// Out-of-scope (analysis abstains, status `unsupported`):
//   - `unmountComponentAtNode` (cannot be rewritten deterministically without the
//     root handle), and any other member access on the binding.
//   - The removed third callback argument on render/hydrate, or any arity other
//     than two arguments.
//   - Multiple render/hydrate calls that share the same container expression.
//   - Non-default `react-dom` import forms (named, namespace, or unrecognized).
//   - A migrated source that still carries any legacy react-dom surface.
// ---------------------------------------------------------------------------

const REACT_18_VERSION = "^18.2.0";

const REACT_DOM_MODULE = /["']react-dom["']/;
const REACT_DOM_CLIENT_MODULE = /["']react-dom\/client["']/;
const REACT_DOM_REQUIRE_LINE =
  /^([ \t]*)(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*["']react-dom["']\s*\);?[ \t]*\r?$/m;
const REACT_DOM_IMPORT_LINE =
  /^([ \t]*)import\s+([A-Za-z0-9_$]+)\s+from\s+["']react-dom["'];?[ \t]*\r?$/m;
const REACT_DOM_REQUIRE =
  /(?:const|let|var)[ \t]+([A-Za-z0-9_$]+)[ \t]*=[ \t]*require\([ \t]*["']react-dom["'][ \t]*\)/;
const REACT_DOM_IMPORT = /import[ \t]+([A-Za-z0-9_$]+)[ \t]+from[ \t]*["']react-dom["']/;
const REACT_DOM_NAMED_ESM = /import[ \t]*\{[^}]*\}[ \t]*from[ \t]*["']react-dom["']/;
const REACT_DOM_NAMED_CJS =
  /(?:const|let|var)[ \t]*\{[^}]*\}[ \t]*=[ \t]*require\([ \t]*["']react-dom["'][ \t]*\)/;
const REACT_DOM_NAMESPACE =
  /import[ \t]*\*[ \t]*as[ \t]+[A-Za-z0-9_$]+[ \t]+from[ \t]*["']react-dom["']/;

// Scan a call argument list. `openParen` is the index of the `(` that opens the
// call. Returns the index of the matching `)` and the raw top-level argument
// substrings (untrimmed), or undefined when the parentheses are unbalanced.
function scanReactCallArgs(
  content: string,
  openParen: number,
): { end: number; args: string[] } | undefined {
  let depth = 0;
  let argStart = openParen + 1;
  const args: string[] = [];
  let quote: string | undefined;
  for (let index = openParen; index < content.length; index++) {
    const char = content[index]!;
    if (quote) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth++;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (char === ")" && depth === 1) {
        args.push(content.slice(argStart, index));
        return { end: index, args };
      }
      depth--;
      continue;
    }
    if (char === "," && depth === 1) {
      args.push(content.slice(argStart, index));
      argStart = index + 1;
    }
  }
  return undefined;
}

function rewriteReactDomSource(content: string): string {
  const requireMatch = REACT_DOM_REQUIRE_LINE.exec(content);
  const importMatch = requireMatch ? null : REACT_DOM_IMPORT_LINE.exec(content);
  const syntax: "cjs" | "esm" | undefined = requireMatch ? "cjs" : importMatch ? "esm" : undefined;
  if (!syntax) return content;
  const indent = (requireMatch ?? importMatch)![1] ?? "";
  const binding = (requireMatch ?? importMatch)![2]!;
  const escaped = escapeRegExp(binding);

  const callMarker = new RegExp(`\\b${escaped}\\.(render|hydrate)[ \\t]*\\(`, "g");
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = callMarker.exec(content))) {
    const openParen = match.index + match[0].length - 1;
    const scan = scanReactCallArgs(content, openParen);
    if (!scan || scan.args.length !== 2) continue;
    const element = scan.args[0]!.trim();
    const container = scan.args[1]!.trim();
    const replacement =
      match[1] === "render"
        ? `createRoot(${container}).render(${element})`
        : `hydrateRoot(${container}, ${element})`;
    out += content.slice(last, match.index) + replacement;
    last = scan.end + 1;
    callMarker.lastIndex = last;
  }
  out += content.slice(last);

  const used: string[] = [];
  if (/\bcreateRoot\b/.test(out)) used.push("createRoot");
  if (/\bhydrateRoot\b/.test(out)) used.push("hydrateRoot");
  if (!used.length) return content;
  const named = used.join(", ");
  const importBlock =
    syntax === "esm"
      ? `${indent}import { ${named} } from "react-dom/client";`
      : `${indent}const { ${named} } = require("react-dom/client");`;
  out = out.replace(syntax === "cjs" ? REACT_DOM_REQUIRE_LINE : REACT_DOM_IMPORT_LINE, () => importBlock);
  return out;
}

function classifyReactDomSource(content: string): PreconditionState {
  const hasLegacyModule = REACT_DOM_MODULE.test(content);
  const hasClientModule = REACT_DOM_CLIENT_MODULE.test(content);
  if (!hasLegacyModule && !hasClientModule) return { state: "neutral" };
  if (REACT_DOM_NAMESPACE.test(content)) {
    return { state: "unsupported", reason: "recipe_react_namespace_import" };
  }
  if (REACT_DOM_NAMED_ESM.test(content) || REACT_DOM_NAMED_CJS.test(content)) {
    return { state: "unsupported", reason: "recipe_react_named_import" };
  }
  const requireMatch = REACT_DOM_REQUIRE.exec(content);
  const importMatch = requireMatch ? null : REACT_DOM_IMPORT.exec(content);
  const binding = requireMatch?.[1] ?? importMatch?.[1];
  if (!binding) {
    if (hasClientModule && !hasLegacyModule) return { state: "target" };
    return { state: "unsupported", reason: "recipe_react_import_unrecognized" };
  }
  if (!REACT_DOM_REQUIRE_LINE.test(content) && !REACT_DOM_IMPORT_LINE.test(content)) {
    return { state: "unsupported", reason: "recipe_react_import_unrecognized" };
  }
  const escaped = escapeRegExp(binding);
  const members = [...content.matchAll(new RegExp(`\\b${escaped}\\.([A-Za-z0-9_$]+)`, "g"))];
  if (!members.length) return { state: "unsupported", reason: "recipe_react_binding_unused" };
  const containers: string[] = [];
  for (const member of members) {
    const method = member[1]!;
    if (method === "unmountComponentAtNode") {
      return { state: "unsupported", reason: "recipe_react_unmount_unsupported" };
    }
    if (method !== "render" && method !== "hydrate") {
      return { state: "unsupported", reason: `recipe_react_unsupported_api:${method}` };
    }
    const rest = content.slice(member.index! + member[0].length);
    const paren = /^[ \t]*\(/.exec(rest);
    if (!paren) {
      return { state: "unsupported", reason: `recipe_react_unsupported_api:${method}` };
    }
    const openParen = member.index! + member[0].length + paren[0].length - 1;
    const scan = scanReactCallArgs(content, openParen);
    if (!scan) return { state: "unsupported", reason: "recipe_react_render_unparsable" };
    if (scan.args.length === 3) {
      return { state: "unsupported", reason: "recipe_react_render_callback" };
    }
    if (scan.args.length !== 2) {
      return { state: "unsupported", reason: "recipe_react_render_arity" };
    }
    containers.push(scan.args[1]!.trim());
  }
  if (new Set(containers).size !== containers.length) {
    return { state: "unsupported", reason: "recipe_react_shared_container" };
  }
  const transformed = rewriteReactDomSource(content);
  if (
    REACT_DOM_MODULE.test(transformed) ||
    new RegExp(`\\b${escaped}\\.(?:render|hydrate)[ \\t]*\\(`).test(transformed)
  ) {
    return { state: "unsupported", reason: "recipe_react_residual_legacy" };
  }
  return { state: "source" };
}

const REACT_SOURCE_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const files=['src/index.jsx','src/index.tsx'];let migrated=0;" +
  "for(const f of files){if(!fs.existsSync(f))continue;const s=fs.readFileSync(f,'utf8');" +
  "if(/from\\s+[\\x27\\x22]react-dom[\\x27\\x22]/.test(s))fail('react_dom_legacy_import:'+f);" +
  "if(/require\\(\\s*[\\x27\\x22]react-dom[\\x27\\x22]\\s*\\)/.test(s))fail('react_dom_legacy_require:'+f);" +
  "if(/[\\x27\\x22]react-dom\\/client[\\x27\\x22]/.test(s))migrated++;}" +
  "if(migrated===0)fail('react_dom_client_import_missing');";

const REACT_MANIFEST_VERIFIER =
  "const fs=require('node:fs');const fail=(m)=>{throw new Error(m)};" +
  "const p=JSON.parse(fs.readFileSync('package.json','utf8'));" +
  "const d=p.dependencies||{};const rd=d['react-dom'];const r=d.react;" +
  "if(typeof rd!==('str'+'ing'))fail('react_dom_dependency_missing');" +
  "if(!/^[\\^~]?18\\./.test(rd))fail('react_dom_not_v18:'+rd);" +
  "if(typeof r!==('str'+'ing'))fail('react_dependency_missing');" +
  "if(!/^[\\^~]?18\\./.test(r))fail('react_not_v18:'+r);";

const REACT_DOM_17_TO_18_V1 = createRecipe({
  id: "react-dom-17-to-18",
  version: 1,
  title: "React DOM 17 to 18 (client render API)",
  source: "react-dom-17",
  target: "react-dom-18",
  allowedPaths: ["package.json", "src/index.jsx", "src/index.tsx"],
  preconditions: [
    { kind: "json_dependency_version", path: "package.json", dependency: "react-dom" },
    { kind: "react_dom_render_source", path: "src/index.jsx" },
    { kind: "react_dom_render_source", path: "src/index.tsx" },
  ],
  transforms: [
    {
      kind: "json_dependency_version_set",
      path: "package.json",
      dependency: "react-dom",
      version: REACT_18_VERSION,
    },
    {
      kind: "json_dependency_version_set",
      path: "package.json",
      dependency: "react",
      version: REACT_18_VERSION,
    },
    { kind: "react_dom_render_to_root", path: "src/index.jsx" },
    { kind: "react_dom_render_to_root", path: "src/index.tsx" },
  ],
  verificationCommands: [
    {
      id: "react-dom-18-source",
      command: `node -e "${REACT_SOURCE_VERIFIER}"`,
      successCriteria:
        "The migrated source imports from react-dom/client with no legacy react-dom import or require",
    },
    {
      id: "react-dom-18-manifest",
      command: `node -e "${REACT_MANIFEST_VERIFIER}"`,
      successCriteria: "package.json declares the react and react-dom dependencies at v18",
    },
  ],
  rollback: {
    strategy: "inverse_operations",
    requireCurrentDigest: true,
  },
});

export const REACT_DOM_17_TO_18_RECIPE = REACT_DOM_17_TO_18_V1;

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
    `${NODE_RUNTIME_20_TO_22_V1.id}@${NODE_RUNTIME_20_TO_22_V1.version}`,
    NODE_RUNTIME_20_TO_22_V1,
  ],
  [
    `${AWS_SDK_JS_V2_TO_V3_V1.id}@${AWS_SDK_JS_V2_TO_V3_V1.version}`,
    AWS_SDK_JS_V2_TO_V3_V1,
  ],
  [
    `${STRIPE_NODE_V10_TO_V11_V1.id}@${STRIPE_NODE_V10_TO_V11_V1.version}`,
    STRIPE_NODE_V10_TO_V11_V1,
  ],
  [
    `${GOOGLEAPIS_V25_TO_V26_V1.id}@${GOOGLEAPIS_V25_TO_V26_V1.version}`,
    GOOGLEAPIS_V25_TO_V26_V1,
  ],
  [
    `${REACT_DOM_17_TO_18_V1.id}@${REACT_DOM_17_TO_18_V1.version}`,
    REACT_DOM_17_TO_18_V1,
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
  if (precondition.kind === "json_string_in") {
    return `recipe_precondition_failed:${precondition.path}:${precondition.pointer}`;
  }
  if (precondition.kind === "json_dependency_version") {
    return `recipe_precondition_failed:${precondition.path}:${precondition.dependency}`;
  }
  if (precondition.kind === "stripe_v10_setter_source") {
    return `recipe_precondition_failed:${precondition.path}:stripe_setter`;
  }
  if (precondition.kind === "googleapis_default_import_source") {
    return `recipe_precondition_failed:${precondition.path}:googleapis_import`;
  }
  if (precondition.kind === "react_dom_render_source") {
    return `recipe_precondition_failed:${precondition.path}:react_dom_render`;
  }
  return `recipe_precondition_failed:${precondition.path}:node_major`;
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
  if (precondition.kind === "json_dependency_version") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    const bump = transform?.kind === "json_dependency_version_set" ? transform : undefined;
    return classifyDependencyVersion(content, precondition.dependency, bump);
  }
  if (precondition.kind === "stripe_v10_setter_source") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyStripeSource(content);
  }
  if (precondition.kind === "googleapis_default_import_source") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyGoogleapisSource(content);
  }
  if (precondition.kind === "react_dom_render_source") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyReactDomSource(content);
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
  } else if (transform.kind === "aws_sdk_source_v2_to_v3") {
    files[transform.path] = rewriteAwsSource(before!);
  } else if (transform.kind === "json_dependency_version_set") {
    files[transform.path] = setDependencyVersion(before!, transform.dependency, transform.version);
  } else if (transform.kind === "stripe_setter_to_config") {
    files[transform.path] = rewriteStripeSource(before!);
  } else if (transform.kind === "googleapis_default_import_to_named") {
    files[transform.path] = rewriteGoogleapisSource(before!);
  } else {
    files[transform.path] = rewriteReactDomSource(before!);
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
