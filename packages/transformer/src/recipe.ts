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
    }>
  | Readonly<{
      kind: "internal_api_rename_source";
      path: string;
      module: string;
      from: string;
      to: string;
    }>
  | Readonly<{
      kind: "internal_api_rename_declaration";
      path: string;
      from: string;
      to: string;
    }>
  | Readonly<{
      kind: "internal_api_type_rename_source";
      path: string;
      module: string;
      from: string;
      to: string;
    }>
  | Readonly<{
      kind: "internal_api_type_rename_declaration";
      path: string;
      from: string;
      to: string;
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
    }>
  | Readonly<{
      kind: "internal_api_rename";
      path: string;
      module: string;
      from: string;
      to: string;
    }>
  | Readonly<{
      kind: "internal_api_rename_declaration";
      path: string;
      from: string;
      to: string;
    }>
  | Readonly<{
      kind: "internal_api_type_rename";
      path: string;
      module: string;
      from: string;
      to: string;
    }>
  | Readonly<{
      kind: "internal_api_type_rename_declaration";
      path: string;
      from: string;
      to: string;
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

// ---------------------------------------------------------------------------
// Internal / custom API refactor (config/spec-driven, bounded)
//
// Unlike the SDK, framework, and runtime families, there is no single universal
// "internal API." A customer's internal refactor is described by a spec (data),
// and this recipe applies it deterministically. The spec is part of the recipe
// definition, so it is folded into the content-addressed digest: different specs
// produce different digests and are signed as independent artifacts. This family
// is NOT a general semantic refactorer. It carries exactly one mechanically-safe
// operation for v1:
//
//   rename an imported named binding and its call sites. Given a spec
//   `{ module, from, to }`, rename a named import `from` (imported from exactly
//   `module`) to `to` and rewrite every bare-identifier call site `from(...)` to
//   `to(...)`. Import specifier and call sites are located with a string- and
//   comment-aware scanner (never a naive regex), so strings, comments, template
//   literals, regex literals, and unrelated identifiers are never corrupted.
//
// Supported surface (everything else is reported out-of-scope by analysis, so
// the recipe abstains rather than producing a wrong edit):
//   - Exactly one supported import of `from` from `module`, either an ESM named
//     import `import { from } from "module"` or a CommonJS destructure
//     `const { from } = require("module")`. Additional named specifiers on the
//     same statement are preserved.
//   - Every non-import reference to the `from` identifier is a bare call site
//     `from(...)` in value position. Member calls on other objects
//     (`obj.from(...)`) belong to a different binding and are ignored.
//
// Out-of-scope (analysis abstains, status `unsupported`):
//   - The same identifier imported from a DIFFERENT module (the classic
//     false-positive trap): `recipe_internal_api_binding_unresolved`.
//   - An aliased import (`from as x`), or `from` imported from `module` on more
//     than one statement.
//   - Any non-call reference to the binding: a value reference, spread
//     (`...from`), member access on the binding (`from.field`), a local
//     declaration or shadow (`const from`, `function from`), an object/class
//     method definition named `from`, or a computed/dynamic call form.
//   - A repository where the target name `to` already appears as a code
//     identifier (`recipe_internal_api_target_conflict`).
// A repository whose import already reads `to` with no remaining `from` binding
// classifies as already applied.
// ---------------------------------------------------------------------------

type CodeIdent = Readonly<{ name: string; start: number; end: number }>;

const INTERNAL_API_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INTERNAL_API_ID_START = /[A-Za-z_$]/;
const INTERNAL_API_ID_PART = /[A-Za-z0-9_$]/;
// Keywords after which a `/` begins a regex literal rather than a division.
const INTERNAL_API_REGEX_PRECEDER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
]);
// Keywords that, immediately before `name(`, mark a declaration or method rather
// than a call, so the recipe abstains instead of renaming.
const INTERNAL_API_DECL_KEYWORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "import",
  "export",
  "interface",
  "type",
  "enum",
  "namespace",
  "get",
  "set",
  "async",
  "static",
]);
// Keywords that, immediately before a bare `name`, mark it as a value expression
// (Gap 3). A binding is never introduced right after one of these, so a `name`
// here is provably a use of the resolved binding and safe to rename.
const INTERNAL_API_VALUE_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "void",
  "delete",
  "await",
  "yield",
  "new",
  "in",
  "of",
  "case",
  "throw",
  "default",
]);
const INTERNAL_API_REGEX_PRECEDER_CHARS = "(,=:[!&|?{};+-*%<>~^";

// Single-pass scanner returning every identifier that appears in code position.
// It skips string literals, template-literal text, line/block comments, and
// regex literals, and it re-enters code mode inside template `${ ... }`
// substitutions so nothing inside a string or comment is ever treated as code.
function scanCodeIdentifiers(content: string): CodeIdent[] {
  const idents: CodeIdent[] = [];
  type Frame = { kind: "code"; brace: number } | { kind: "template" };
  const stack: Frame[] = [{ kind: "code", brace: 0 }];
  const n = content.length;
  let i = 0;
  let prevChar = "";
  let prevWord = "";
  while (i < n) {
    const frame = stack[stack.length - 1]!;
    const c = content[i]!;
    if (frame.kind === "template") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && content[i + 1] === "{") {
        stack.push({ kind: "code", brace: 0 });
        i += 2;
        prevChar = "{";
        prevWord = "";
        continue;
      }
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "/" && content[i + 1] === "/") {
      i += 2;
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === c) {
          i++;
          break;
        }
        i++;
      }
      prevChar = c;
      prevWord = "";
      continue;
    }
    if (c === "`") {
      stack.push({ kind: "template" });
      i++;
      prevChar = "`";
      prevWord = "";
      continue;
    }
    if (c === "/") {
      const regexContext =
        prevChar === "" ||
        INTERNAL_API_REGEX_PRECEDER_CHARS.includes(prevChar) ||
        (INTERNAL_API_ID_PART.test(prevChar) && INTERNAL_API_REGEX_PRECEDER_WORDS.has(prevWord));
      if (regexContext) {
        i++;
        let inClass = false;
        while (i < n) {
          const rc = content[i]!;
          if (rc === "\\") {
            i += 2;
            continue;
          }
          if (rc === "[") {
            inClass = true;
            i++;
            continue;
          }
          if (rc === "]") {
            inClass = false;
            i++;
            continue;
          }
          if (rc === "/" && !inClass) {
            i++;
            break;
          }
          if (rc === "\n") break;
          i++;
        }
        while (i < n && /[a-z]/i.test(content[i]!)) i++;
      } else {
        i++;
      }
      prevChar = "/";
      prevWord = "";
      continue;
    }
    if (c === "{") {
      frame.brace++;
      prevChar = "{";
      prevWord = "";
      i++;
      continue;
    }
    if (c === "}") {
      if (frame.brace > 0) {
        frame.brace--;
      } else if (stack.length > 1) {
        stack.pop();
      }
      prevChar = "}";
      prevWord = "";
      i++;
      continue;
    }
    if (INTERNAL_API_ID_START.test(c)) {
      const start = i;
      i++;
      while (i < n && INTERNAL_API_ID_PART.test(content[i]!)) i++;
      const name = content.slice(start, i);
      idents.push({ name, start, end: i });
      prevChar = content[i - 1]!;
      prevWord = name;
      continue;
    }
    prevChar = c;
    prevWord = "";
    i++;
  }
  return idents;
}

type InternalApiImportSpan = Readonly<{ specifiers: string; braceStart: number; braceEnd: number }>;

function internalApiImportSpans(content: string, module: string): InternalApiImportSpan[] {
  const escaped = escapeRegExp(module);
  const spans: InternalApiImportSpan[] = [];
  const patterns = [
    new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`, "g"),
    new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*["']${escaped}["']\\s*\\)`, "g"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      const open = content.indexOf("{", match.index);
      if (open < 0) continue;
      const close = content.indexOf("}", open);
      if (close < 0) continue;
      spans.push({ specifiers: match[1]!, braceStart: open + 1, braceEnd: close });
    }
  }
  return spans;
}

// Namespace-import bindings for `module` (Gap 5). A namespace import
// (`import * as ns from "module"`) or a whole-module CommonJS require
// (`const ns = require("module")`) binds an object whose members are the
// module's exports, so `ns.<name>` provably resolves to that module's export.
// Named-destructuring requires (`const { x } = require(...)`) are handled by the
// import-span logic instead and are not namespace bindings.
function internalApiNamespaceBindings(content: string, module: string): Set<string> {
  const escaped = escapeRegExp(module);
  const names = new Set<string>();
  const patterns = [
    new RegExp(`import\\s*\\*\\s*as\\s+([A-Za-z0-9_$]+)\\s+from\\s*["']${escaped}["']`, "g"),
    new RegExp(
      `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*require\\(\\s*["']${escaped}["']\\s*\\)`,
      "g",
    ),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) names.add(match[1]!);
  }
  return names;
}

// Member tokens `receiver.<name>` where `receiver` is one of `namespaceBindings`.
// These are the only `.<name>` member accesses the rename touches; every other
// member access (on an unrelated object) stays untouched.
function internalApiNamespaceMemberTokens(
  content: string,
  tokens: readonly CodeIdent[],
  name: string,
  namespaceBindings: ReadonlySet<string>,
): CodeIdent[] {
  if (namespaceBindings.size === 0) return [];
  const hits: CodeIdent[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.name !== name) continue;
    let back = token.start - 1;
    while (back >= 0 && /\s/.test(content[back]!)) back--;
    if (back < 0 || content[back] !== ".") continue;
    if (back - 1 >= 0 && content[back - 1] === ".") continue; // spread / optional
    const receiver = tokens[index - 1];
    if (
      receiver &&
      receiver.end <= back &&
      content.slice(receiver.end, back).trim() === "" &&
      namespaceBindings.has(receiver.name)
    ) {
      hits.push(token);
    }
  }
  return hits;
}

type InternalApiBindingStatus =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "aliased" }>
  | Readonly<{ status: "multiple" }>
  | Readonly<{ status: "ok"; braceStart: number; braceEnd: number }>;

function internalApiBindingStatus(
  content: string,
  module: string,
  name: string,
): InternalApiBindingStatus {
  const hits: Array<{ braceStart: number; braceEnd: number }> = [];
  let aliased = false;
  for (const span of internalApiImportSpans(content, module)) {
    for (const raw of span.specifiers.split(",")) {
      const specifier = raw.trim();
      if (!specifier) continue;
      const alias = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(specifier);
      if (alias) {
        if (alias[1] === name) aliased = true;
        continue;
      }
      if (specifier === name) hits.push({ braceStart: span.braceStart, braceEnd: span.braceEnd });
    }
  }
  if (hits.length === 1) {
    return { status: "ok", braceStart: hits[0]!.braceStart, braceEnd: hits[0]!.braceEnd };
  }
  if (hits.length > 1) return { status: "multiple" };
  if (aliased) return { status: "aliased" };
  return { status: "none" };
}

// Classify a single non-import occurrence of the binding identifier. `member` is
// a member access on another object (ignore), `call` is a clean call site
// (rename), `value` is a provably-safe non-call value reference (rename, Gap 3),
// and `other` is anything ambiguous (abstain). The `value` cases are limited to
// three bracket-independent contexts that can never be a binding introduction,
// an object property key, or a shadowing declaration: an assignment/initializer
// right-hand side (`= name`), a value expression after a value keyword
// (`return name`, `export default name`, ...), and a member-root read on the
// binding itself (`name.bind(...)`). Every other non-call form (call arguments,
// spreads, object keys/shorthand, destructuring, type positions) stays `other`
// so the completeness invariant abstains rather than risk an unsafe edit.
function internalApiReferenceKind(
  content: string,
  tokens: readonly CodeIdent[],
  index: number,
): "member" | "call" | "value" | "other" {
  const token = tokens[index]!;
  let back = token.start - 1;
  while (back >= 0 && /\s/.test(content[back]!)) back--;
  const prevChar = back >= 0 ? content[back]! : "";
  if (prevChar === ".") {
    // A single leading `.` is a member access; `..`/`...` (spread) is out of the
    // safe value subset and abstains.
    return back - 1 >= 0 && content[back - 1] === "." ? "other" : "member";
  }
  let forward = token.end;
  while (forward < content.length && /\s/.test(content[forward]!)) forward++;
  const nextChar = forward < content.length ? content[forward]! : "";
  if (nextChar === "(") {
    const previous = tokens[index - 1];
    if (
      previous &&
      /^\s*$/.test(content.slice(previous.end, token.start)) &&
      INTERNAL_API_DECL_KEYWORDS.has(previous.name)
    ) {
      return "other";
    }
    const scan = scanReactCallArgs(content, forward);
    if (!scan) return "other";
    let after = scan.end + 1;
    while (after < content.length && /\s/.test(content[after]!)) after++;
    if (content[after] === "{") return "other";
    return "call";
  }
  // Gap 3, context (c): member-root read on the binding (`name.field`,
  // `name.bind(this)`). The binding is read as a value, then a member accessed;
  // this is never a declaration or an object key.
  if (nextChar === ".") return "value";
  // Gap 3, context (a): assignment/initializer/comparison right-hand side
  // (`const handler = name`, `x = name`, `a === name`). `=>` and comparison
  // operators end on `>`/`<`, so a nearest-non-space `=` is only a real `=`.
  if (prevChar === "=") return "value";
  // Gap 3, context (b): value expression after a value keyword
  // (`return name`, `export default name`, `await name`, `case name`).
  const previous = tokens[index - 1];
  if (
    previous &&
    content.slice(previous.end, token.start).trim() === "" &&
    INTERNAL_API_VALUE_KEYWORDS.has(previous.name)
  ) {
    return "value";
  }
  return "other";
}

function applyInternalApiRanges(
  content: string,
  to: string,
  ranges: readonly (readonly [number, number])[],
): string {
  let out = content;
  for (const [start, end] of [...ranges].sort((left, right) => right[0] - left[0])) {
    out = out.slice(0, start) + to + out.slice(end);
  }
  return out;
}

type InternalApiPlan = Readonly<{
  state: PreconditionState["state"];
  reason?: string;
  ranges?: readonly (readonly [number, number])[];
}>;

function planInternalApiRename(
  content: string,
  module: string,
  from: string,
  to: string,
): InternalApiPlan {
  if (!new RegExp(`["']${escapeRegExp(module)}["']`).test(content)) return { state: "neutral" };
  const tokens = scanCodeIdentifiers(content);
  const fromStatus = internalApiBindingStatus(content, module, from);
  const toStatus = internalApiBindingStatus(content, module, to);
  const namespaceBindings = internalApiNamespaceBindings(content, module);
  // Namespace-member accesses of the target module (Gap 5): `ns.from` / `ns.to`.
  const namespaceFromMembers = internalApiNamespaceMemberTokens(content, tokens, from, namespaceBindings);
  const namespaceToMembers = internalApiNamespaceMemberTokens(content, tokens, to, namespaceBindings);
  const namespaceMemberSet = new Set(namespaceFromMembers);
  const nonMemberFrom = tokens.filter(
    (token, index) =>
      token.name === from && internalApiReferenceKind(content, tokens, index) !== "member",
  );

  if (toStatus.status === "ok" && fromStatus.status === "none") {
    return nonMemberFrom.length === 0 && namespaceFromMembers.length === 0
      ? { state: "target" }
      : { state: "unsupported", reason: "recipe_internal_api_partial_migration" };
  }
  if (fromStatus.status === "aliased") {
    return { state: "unsupported", reason: "recipe_internal_api_aliased_import" };
  }
  if (fromStatus.status === "multiple") {
    return { state: "unsupported", reason: "recipe_internal_api_multiple_imports" };
  }
  if (fromStatus.status === "none") {
    // No named import of `from`. A namespace consumer (`ns.from`) is handled here
    // (Gap 5); anything else non-member is an unresolved reference.
    if (namespaceFromMembers.length === 0) {
      return nonMemberFrom.length === 0
        ? { state: "neutral" }
        : { state: "unsupported", reason: "recipe_internal_api_binding_unresolved" };
    }
    if (nonMemberFrom.length > 0) {
      return { state: "unsupported", reason: "recipe_internal_api_binding_unresolved" };
    }
    if (namespaceToMembers.length > 0) {
      return { state: "unsupported", reason: "recipe_internal_api_target_conflict" };
    }
    const nsRanges = namespaceFromMembers.map(
      (token) => [token.start, token.end] as const,
    );
    const transformed = applyInternalApiRanges(content, to, nsRanges);
    if (internalApiNamespaceMemberTokens(transformed, scanCodeIdentifiers(transformed), from, namespaceBindings).length !== 0) {
      return { state: "unsupported", reason: "recipe_internal_api_residual_import" };
    }
    return { state: "source", ranges: nsRanges };
  }
  const specToken = tokens.find(
    (token) =>
      token.name === from && token.start >= fromStatus.braceStart && token.end <= fromStatus.braceEnd,
  );
  if (!specToken) return { state: "unsupported", reason: "recipe_internal_api_import_unresolved" };
  if (tokens.some((token) => token.name === to && !namespaceToMembers.includes(token))) {
    return { state: "unsupported", reason: "recipe_internal_api_target_conflict" };
  }
  const ranges: Array<readonly [number, number]> = [[specToken.start, specToken.end]];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.name !== from || token === specToken) continue;
    if (namespaceMemberSet.has(token)) {
      // A `ns.from` member alongside a named import: rename the member too.
      ranges.push([token.start, token.end]);
      continue;
    }
    const kind = internalApiReferenceKind(content, tokens, index);
    if (kind === "member") continue;
    if (kind === "call" || kind === "value") {
      ranges.push([token.start, token.end]);
      continue;
    }
    return { state: "unsupported", reason: "recipe_internal_api_unsupported_reference" };
  }
  const transformed = applyInternalApiRanges(content, to, ranges);
  if (internalApiBindingStatus(transformed, module, from).status !== "none") {
    return { state: "unsupported", reason: "recipe_internal_api_residual_import" };
  }
  return { state: "source", ranges };
}

function classifyInternalApiRenameSource(
  content: string,
  module: string,
  from: string,
  to: string,
): PreconditionState {
  const plan = planInternalApiRename(content, module, from, to);
  return plan.reason ? { state: plan.state, reason: plan.reason } : { state: plan.state };
}

function rewriteInternalApiRenameSource(
  content: string,
  module: string,
  from: string,
  to: string,
): string {
  const plan = planInternalApiRename(content, module, from, to);
  if (plan.state !== "source" || !plan.ranges) return content;
  return applyInternalApiRanges(content, to, plan.ranges);
}

// ---------------------------------------------------------------------------
// Declaring-module rename (Gap 1 + Gap 2).
//
// The consumer-side rename above updates every module that IMPORTS the binding.
// The producing module — the one that owns `export function/const/class from`,
// or a barrel that re-exports it with `export { from } from "./y.js"` — is
// handled here. Without this, a rename leaves the producer exporting the old
// name and the workspace fails to compile (TS2305). A relative `spec.module`
// (in-repo) therefore requires at least one declaration path so the producer and
// any barrels in the chain are rewritten in lockstep with the consumers.
//
// Supported export surface (anything else abstains, status `unsupported`):
//   - An exported local declaration of `from`: `export function from`,
//     `export const|let|var from`, `export class from` (with `async`/`abstract`).
//   - A named re-export list `export { from }` / `export { from } from "./y.js"`,
//     the barrel form. Internal bare call sites of `from` in the producer are
//     renamed too.
//
// Out-of-scope (abstains, so the whole spec abstains rather than emitting a
// partial rename that does not compile):
//   - `recipe_internal_api_declaration_unresolved`: the designated declaration
//     path exposes no rewritable `from` export (completeness invariant).
//   - `recipe_internal_api_declaration_aliased_export`: an aliased specifier
//     `export { from as X }` / `export { X as from }` (ambiguous local/exported
//     name split).
//   - `recipe_internal_api_declaration_target_conflict`: the target name already
//     appears as a code identifier in the producer.
//   - `recipe_internal_api_declaration_unsupported_reference`: a non-call, value
//     reference to the binding (spread, alias, member definition).
//   - `recipe_internal_api_declaration_residual`: a `from` export would survive
//     the rewrite (defence-in-depth completeness check).
// ---------------------------------------------------------------------------

// Brace regions of every `export { ... }` list (with or without a trailing
// `from "..."`), used to locate re-exported specifiers in code position.
function internalApiExportListBraces(content: string): Array<readonly [number, number]> {
  const braces: Array<readonly [number, number]> = [];
  const pattern = /\bexport\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const open = content.indexOf("{", match.index);
    if (open < 0) continue;
    const close = content.indexOf("}", open);
    if (close < 0) continue;
    braces.push([open + 1, close] as const);
  }
  return braces;
}

type InternalApiDeclarationSites = Readonly<{ starts: ReadonlySet<number>; aliased: boolean }>;

// Every code-position occurrence of `name` that is an export site: an exported
// local declaration, or a bare specifier inside an `export { ... }` list. Sets
// `aliased` when the name only appears through an `as` alias, which the recipe
// abstains on. String/comment false matches are discarded by requiring a real
// scanned token at the offset.
function internalApiDeclarationSites(
  content: string,
  tokens: readonly CodeIdent[],
  name: string,
): InternalApiDeclarationSites {
  const starts = new Set<number>();
  let aliased = false;
  const tokenStarts = new Map(tokens.map((token) => [token.start, token] as const));
  const localPattern = new RegExp(
    `\\bexport\\s+(?:(?:async\\s+)?function|(?:abstract\\s+)?class|const|let|var)\\s+(${escapeRegExp(name)})\\b`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = localPattern.exec(content))) {
    const nameStart = match.index + match[0].length - match[1]!.length;
    const token = tokenStarts.get(nameStart);
    if (token && token.name === name) starts.add(nameStart);
  }
  const braces = internalApiExportListBraces(content);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.name !== name) continue;
    if (!braces.some(([open, close]) => token.start >= open && token.end <= close)) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const previousIsAs =
      previous?.name === "as" && content.slice(previous.end, token.start).trim() === "";
    const nextIsAs = next?.name === "as" && content.slice(token.end, next.start).trim() === "";
    if (previousIsAs || nextIsAs) {
      aliased = true;
      continue;
    }
    starts.add(token.start);
  }
  return { starts, aliased };
}

function planInternalApiDeclarationRename(
  content: string,
  from: string,
  to: string,
): InternalApiPlan {
  const tokens = scanCodeIdentifiers(content);
  const fromSites = internalApiDeclarationSites(content, tokens, from);
  const toSites = internalApiDeclarationSites(content, tokens, to);
  const fromTokens = tokens.filter((token) => token.name === from);
  const toTokens = tokens.filter((token) => token.name === to);

  if (fromSites.aliased || toSites.aliased) {
    return { state: "unsupported", reason: "recipe_internal_api_declaration_aliased_export" };
  }
  if (fromSites.starts.size === 0) {
    if (toSites.starts.size > 0 && fromTokens.length === 0) return { state: "target" };
    return { state: "unsupported", reason: "recipe_internal_api_declaration_unresolved" };
  }
  if (toTokens.length > 0) {
    return { state: "unsupported", reason: "recipe_internal_api_declaration_target_conflict" };
  }
  const ranges: Array<readonly [number, number]> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.name !== from) continue;
    if (fromSites.starts.has(token.start)) {
      ranges.push([token.start, token.end]);
      continue;
    }
    const kind = internalApiReferenceKind(content, tokens, index);
    if (kind === "member") continue;
    if (kind === "call" || kind === "value") {
      ranges.push([token.start, token.end]);
      continue;
    }
    return { state: "unsupported", reason: "recipe_internal_api_declaration_unsupported_reference" };
  }
  if (ranges.length === 0) {
    return { state: "unsupported", reason: "recipe_internal_api_declaration_unresolved" };
  }
  const transformed = applyInternalApiRanges(content, to, ranges);
  const residual = internalApiDeclarationSites(transformed, scanCodeIdentifiers(transformed), from);
  if (residual.starts.size !== 0) {
    return { state: "unsupported", reason: "recipe_internal_api_declaration_residual" };
  }
  return { state: "source", ranges };
}

function classifyInternalApiDeclarationRename(
  content: string,
  from: string,
  to: string,
): PreconditionState {
  const plan = planInternalApiDeclarationRename(content, from, to);
  return plan.reason ? { state: plan.state, reason: plan.reason } : { state: plan.state };
}

function rewriteInternalApiDeclarationRename(content: string, from: string, to: string): string {
  const plan = planInternalApiDeclarationRename(content, from, to);
  if (plan.state !== "source" || !plan.ranges) return content;
  return applyInternalApiRanges(content, to, plan.ranges);
}

// ---------------------------------------------------------------------------
// Type and interface rename (Gap 4).
//
// A type-only name (`interface X`, `type X = ...`) lives in the TypeScript type
// namespace, disjoint from the value namespace, so it is renamed as its own spec
// shape rather than by overloading the value rename. A pure type name can only
// appear in type positions (annotations, generic arguments, `extends`/
// `implements`/`satisfies`, type imports/exports), never as a runtime value, so
// the rename covers every non-member occurrence of the name whose next
// significant character is not `:` (which would make it a property/member key,
// not a type reference). Any occurrence that is a value use (a call site or a
// value reference per `internalApiReferenceKind`) proves the name is not a pure
// type in this file (a value/type collision or a shadow), so the whole spec
// abstains rather than emit an unsafe edit.
//
// Consumer surface (`internal_api_type_rename`, needs the module): the type must
// be imported from the exact `module` (`import type { X } from "module"`,
// `import { X }`, or `import { type X }`); a same-named type from a different
// module abstains. Declaration surface (`internal_api_type_rename_declaration`):
// the producing module that owns `interface X`/`type X`, or a barrel that
// re-exports it with `export type { X } from "./y.js"`.
//
// Out-of-scope (abstains, so the whole spec abstains rather than a partial edit):
//   - `recipe_internal_api_type_value_reference`: the name is used as a value
//     (call site or value reference) — it is not a pure type here.
//   - `recipe_internal_api_type_value_collision`: the name is also declared as a
//     value (`const`/`let`/`var`/`function`/`class`/`enum`/`namespace`).
//   - `recipe_internal_api_type_shadowed`: the name is (re)declared as a type
//     parameter (`function f<X>()`, `interface I<X>`, `type T<X>`, `class C<X>`).
//   - `recipe_internal_api_type_target_conflict`: the target name already appears
//     as a code identifier.
//   - `recipe_internal_api_type_binding_unresolved` / `_aliased_import` /
//     `_multiple_imports` / `_import_unresolved`: the consumer import binding is a
//     same-name-different-module reference, aliased, duplicated, or unresolvable.
//   - `recipe_internal_api_type_declaration_unresolved`: the designated
//     declaration path exposes no rewritable `interface`/`type` declaration.
//   - `recipe_internal_api_type_residual`: a `from` type reference would survive.
// ---------------------------------------------------------------------------

// Import brace spans for `module`, allowing an optional `type` modifier
// (`import type { ... } from "module"`) that the value-side span matcher omits.
function internalApiTypeImportSpans(content: string, module: string): InternalApiImportSpan[] {
  const escaped = escapeRegExp(module);
  const spans: InternalApiImportSpan[] = [];
  const patterns = [
    new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`, "g"),
    new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*["']${escaped}["']\\s*\\)`, "g"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      const open = content.indexOf("{", match.index);
      if (open < 0) continue;
      const close = content.indexOf("}", open);
      if (close < 0) continue;
      spans.push({ specifiers: match[1]!, braceStart: open + 1, braceEnd: close });
    }
  }
  return spans;
}

// Binding status of a type imported from `module`, tolerating an inline `type`
// modifier on the specifier (`import { type X }`).
function internalApiTypeBindingStatus(
  content: string,
  module: string,
  name: string,
): InternalApiBindingStatus {
  const hits: Array<{ braceStart: number; braceEnd: number }> = [];
  let aliased = false;
  for (const span of internalApiTypeImportSpans(content, module)) {
    for (const raw of span.specifiers.split(",")) {
      const specifier = raw.trim().replace(/^type\s+/, "");
      if (!specifier) continue;
      const alias = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(specifier);
      if (alias) {
        if (alias[1] === name) aliased = true;
        continue;
      }
      if (specifier === name) hits.push({ braceStart: span.braceStart, braceEnd: span.braceEnd });
    }
  }
  if (hits.length === 1) {
    return { status: "ok", braceStart: hits[0]!.braceStart, braceEnd: hits[0]!.braceEnd };
  }
  if (hits.length > 1) return { status: "multiple" };
  if (aliased) return { status: "aliased" };
  return { status: "none" };
}

const INTERNAL_API_VALUE_DECL = (name: string): RegExp =>
  new RegExp(`\\b(?:const|let|var|function|class|enum|namespace)\\s+${escapeRegExp(name)}\\b`);

// Best-effort detection of `name` used as a type-parameter declaration, e.g.
// `function f<name>()`, `interface I<name>`, `type T<name> =`, `class C<name>`.
// Generic *uses* (`Map<name>`) are not matched because they are not preceded by
// a declaration keyword and name.
function internalApiTypeParamShadow(content: string, name: string): boolean {
  const n = escapeRegExp(name);
  return new RegExp(
    `\\b(?:function|interface|type|class)\\s+[A-Za-z0-9_$]*\\s*<[^<>]*\\b${n}\\b[^<>]*>`,
  ).test(content);
}

// Type declaration / re-export sites of `name`: `interface name`, `type name`,
// and bare specifiers inside an `export type { ... }` (or `export { ... }`) list.
function internalApiTypeDeclarationSites(
  content: string,
  tokens: readonly CodeIdent[],
  name: string,
): InternalApiDeclarationSites {
  const starts = new Set<number>();
  let aliased = false;
  const tokenStarts = new Map(tokens.map((token) => [token.start, token] as const));
  const localPattern = new RegExp(
    `\\b(?:export\\s+)?(?:interface|type)\\s+(${escapeRegExp(name)})\\b`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = localPattern.exec(content))) {
    const nameStart = match.index + match[0].length - match[1]!.length;
    const token = tokenStarts.get(nameStart);
    if (token && token.name === name) starts.add(nameStart);
  }
  const braces = internalApiExportListBraces(content);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.name !== name) continue;
    if (!braces.some(([open, close]) => token.start >= open && token.end <= close)) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const previousIsAs =
      previous?.name === "as" && content.slice(previous.end, token.start).trim() === "";
    const nextIsAs = next?.name === "as" && content.slice(token.end, next.start).trim() === "";
    if (previousIsAs || nextIsAs) {
      aliased = true;
      continue;
    }
    starts.add(token.start);
  }
  return { starts, aliased };
}

// Compute rename ranges for every type-position occurrence of `name`: skip
// member accesses (`obj.name`) and property/member keys (`name:`), rename the
// rest, and abstain (return the reason) if any occurrence is a value use.
function internalApiTypeRenameRanges(
  content: string,
  tokens: readonly CodeIdent[],
  name: string,
): { ranges: Array<readonly [number, number]> } | { reason: string } {
  const ranges: Array<readonly [number, number]> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.name !== name) continue;
    const kind = internalApiReferenceKind(content, tokens, index);
    if (kind === "member") continue;
    if (kind === "call" || kind === "value") {
      return { reason: "recipe_internal_api_type_value_reference" };
    }
    let forward = token.end;
    while (forward < content.length && /\s/.test(content[forward]!)) forward++;
    if (content[forward] === ":") continue; // property/member key, not a type reference
    ranges.push([token.start, token.end]);
  }
  return { ranges };
}

function planInternalApiTypeConsumerRename(
  content: string,
  module: string,
  from: string,
  to: string,
): InternalApiPlan {
  if (!new RegExp(`["']${escapeRegExp(module)}["']`).test(content)) return { state: "neutral" };
  const tokens = scanCodeIdentifiers(content);
  const fromStatus = internalApiTypeBindingStatus(content, module, from);
  const toStatus = internalApiTypeBindingStatus(content, module, to);
  const fromTokens = tokens.filter((token) => token.name === from);

  if (toStatus.status === "ok" && fromStatus.status === "none") {
    return fromTokens.length === 0
      ? { state: "target" }
      : { state: "unsupported", reason: "recipe_internal_api_type_partial_migration" };
  }
  if (fromStatus.status === "aliased") {
    return { state: "unsupported", reason: "recipe_internal_api_type_aliased_import" };
  }
  if (fromStatus.status === "multiple") {
    return { state: "unsupported", reason: "recipe_internal_api_type_multiple_imports" };
  }
  if (fromStatus.status === "none") {
    return fromTokens.length === 0
      ? { state: "neutral" }
      : { state: "unsupported", reason: "recipe_internal_api_type_binding_unresolved" };
  }
  if (INTERNAL_API_VALUE_DECL(from).test(content)) {
    return { state: "unsupported", reason: "recipe_internal_api_type_value_collision" };
  }
  if (internalApiTypeParamShadow(content, from)) {
    return { state: "unsupported", reason: "recipe_internal_api_type_shadowed" };
  }
  if (tokens.some((token) => token.name === to)) {
    return { state: "unsupported", reason: "recipe_internal_api_type_target_conflict" };
  }
  const computed = internalApiTypeRenameRanges(content, tokens, from);
  if ("reason" in computed) return { state: "unsupported", reason: computed.reason };
  if (computed.ranges.length === 0) {
    return { state: "unsupported", reason: "recipe_internal_api_type_import_unresolved" };
  }
  const transformed = applyInternalApiRanges(content, to, computed.ranges);
  if (internalApiTypeBindingStatus(transformed, module, from).status !== "none") {
    return { state: "unsupported", reason: "recipe_internal_api_type_residual" };
  }
  return { state: "source", ranges: computed.ranges };
}

function planInternalApiTypeDeclarationRename(
  content: string,
  from: string,
  to: string,
): InternalApiPlan {
  const tokens = scanCodeIdentifiers(content);
  const fromSites = internalApiTypeDeclarationSites(content, tokens, from);
  const toSites = internalApiTypeDeclarationSites(content, tokens, to);
  const fromTokens = tokens.filter((token) => token.name === from);
  const toTokens = tokens.filter((token) => token.name === to);

  if (fromSites.aliased || toSites.aliased) {
    return { state: "unsupported", reason: "recipe_internal_api_type_declaration_aliased_export" };
  }
  if (fromSites.starts.size === 0) {
    if (toSites.starts.size > 0 && fromTokens.length === 0) return { state: "target" };
    return { state: "unsupported", reason: "recipe_internal_api_type_declaration_unresolved" };
  }
  if (INTERNAL_API_VALUE_DECL(from).test(content)) {
    return { state: "unsupported", reason: "recipe_internal_api_type_value_collision" };
  }
  if (internalApiTypeParamShadow(content, from)) {
    return { state: "unsupported", reason: "recipe_internal_api_type_shadowed" };
  }
  if (toTokens.length > 0) {
    return { state: "unsupported", reason: "recipe_internal_api_type_declaration_target_conflict" };
  }
  const computed = internalApiTypeRenameRanges(content, tokens, from);
  if ("reason" in computed) return { state: "unsupported", reason: computed.reason };
  if (computed.ranges.length === 0) {
    return { state: "unsupported", reason: "recipe_internal_api_type_declaration_unresolved" };
  }
  const transformed = applyInternalApiRanges(content, to, computed.ranges);
  const residual = internalApiTypeDeclarationSites(transformed, scanCodeIdentifiers(transformed), from);
  if (residual.starts.size !== 0) {
    return { state: "unsupported", reason: "recipe_internal_api_type_declaration_residual" };
  }
  return { state: "source", ranges: computed.ranges };
}

function classifyInternalApiTypeConsumerRename(
  content: string,
  module: string,
  from: string,
  to: string,
): PreconditionState {
  const plan = planInternalApiTypeConsumerRename(content, module, from, to);
  return plan.reason ? { state: plan.state, reason: plan.reason } : { state: plan.state };
}

function classifyInternalApiTypeDeclarationRename(
  content: string,
  from: string,
  to: string,
): PreconditionState {
  const plan = planInternalApiTypeDeclarationRename(content, from, to);
  return plan.reason ? { state: plan.state, reason: plan.reason } : { state: plan.state };
}

function rewriteInternalApiTypeConsumerRename(
  content: string,
  module: string,
  from: string,
  to: string,
): string {
  const plan = planInternalApiTypeConsumerRename(content, module, from, to);
  if (plan.state !== "source" || !plan.ranges) return content;
  return applyInternalApiRanges(content, to, plan.ranges);
}

function rewriteInternalApiTypeDeclarationRename(content: string, from: string, to: string): string {
  const plan = planInternalApiTypeDeclarationRename(content, from, to);
  if (plan.state !== "source" || !plan.ranges) return content;
  return applyInternalApiRanges(content, to, plan.ranges);
}

export type InternalApiRenameSpec = Readonly<{
  recipeId: string;
  version: number;
  title: string;
  source: string;
  target: string;
  module: string;
  from: string;
  to: string;
  paths: readonly string[];
  /**
   * In-repo declaration and barrel files that own or re-export `from`. Required
   * when `module` is a relative specifier (the producer lives in the repository);
   * omitted for external/bare modules whose producer ships the new name already.
   */
  declarationPaths?: readonly string[];
}>;

function internalApiVerifierScript(
  paths: readonly string[],
  identifier: string,
  present: boolean,
  missingFailure: string,
  presentFailure: string,
): string {
  const pathList = paths.map((path) => `'${path}'`).join(",");
  const callRegex = `new RegExp('(?<![\\\\w$.])${identifier}\\\\s*\\\\(')`;
  const body = present
    ? `let seen=0;for(const p of paths){if(!fs.existsSync(p))continue;const s=fs.readFileSync(p,'utf8');if(call.test(s))seen++;}if(seen===0)fail('${missingFailure}');`
    : `let checked=0;for(const p of paths){if(!fs.existsSync(p))continue;checked++;const s=fs.readFileSync(p,'utf8');if(call.test(s))fail('${presentFailure}:'+p);}if(checked===0)fail('${missingFailure}');`;
  return (
    "const fs=require('node:fs');" +
    "const fail=(m)=>{throw new Error(m)};" +
    `const paths=[${pathList}];` +
    `const call=${callRegex};` +
    body
  );
}

export function createInternalApiRenameRecipe(spec: InternalApiRenameSpec): MigrationRecipeContract {
  if (!INTERNAL_API_IDENTIFIER.test(spec.from) || !INTERNAL_API_IDENTIFIER.test(spec.to)) {
    throw new Error("recipe_internal_api_identifier_invalid");
  }
  if (spec.from === spec.to) throw new Error("recipe_internal_api_noop");
  if (!spec.module || /["'\\]/.test(spec.module)) throw new Error("recipe_internal_api_module_invalid");
  const consumerPaths = [...spec.paths].sort();
  if (!consumerPaths.length) throw new Error("recipe_internal_api_paths_required");
  const declarationPaths = [...(spec.declarationPaths ?? [])].sort();
  const consumerSet = new Set(consumerPaths);
  for (const path of declarationPaths) {
    if (consumerSet.has(path)) throw new Error("recipe_internal_api_declaration_path_conflict");
  }
  // Completeness: a relative `module` names an in-repo producer, so the rename is
  // only complete when its declaration (and any barrels) travel with it.
  const relativeModule = spec.module.startsWith("./") || spec.module.startsWith("../");
  if (relativeModule && declarationPaths.length === 0) {
    throw new Error("recipe_internal_api_declaration_required");
  }
  const allowedPaths = [...consumerPaths, ...declarationPaths].sort();
  const preconditions = [
    ...consumerPaths.map(
      (path) =>
        ({
          kind: "internal_api_rename_source",
          path,
          module: spec.module,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
    ...declarationPaths.map(
      (path) =>
        ({
          kind: "internal_api_rename_declaration",
          path,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
  ];
  const transforms = [
    ...consumerPaths.map(
      (path) =>
        ({
          kind: "internal_api_rename",
          path,
          module: spec.module,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
    ...declarationPaths.map(
      (path) =>
        ({
          kind: "internal_api_rename_declaration",
          path,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
  ];
  return createRecipe({
    id: spec.recipeId,
    version: spec.version,
    title: spec.title,
    source: spec.source,
    target: spec.target,
    allowedPaths,
    preconditions,
    transforms,
    verificationCommands: [
      {
        id: "internal-api-old-surface-absent",
        command: `node -e "${internalApiVerifierScript(
          allowedPaths,
          spec.from,
          false,
          "internal_api_source_missing",
          "internal_api_old_call_present",
        )}"`,
        successCriteria: `Migrated consumer sources contain no ${spec.from} call sites`,
      },
      {
        id: "internal-api-new-surface-present",
        command: `node -e "${internalApiVerifierScript(
          allowedPaths,
          spec.to,
          true,
          "internal_api_new_call_missing",
          "internal_api_new_call_present",
        )}"`,
        successCriteria: `Migrated consumer sources call ${spec.to} in at least one file`,
      },
    ],
    rollback: {
      strategy: "inverse_operations",
      requireCurrentDigest: true,
    },
  });
}

// Whole-word identifier presence/absence verifier for type renames (there are no
// call sites to key on). `.name` member access and `name:` keys are excluded so a
// coincidental unrelated key does not trip the check.
function internalApiTypeVerifierScript(
  paths: readonly string[],
  identifier: string,
  present: boolean,
  missingFailure: string,
  presentFailure: string,
): string {
  const pathList = paths.map((path) => `'${path}'`).join(",");
  const wordRegex = `new RegExp('(?<![\\\\w$.])${identifier}(?![\\\\w$])(?!\\\\s*:)')`;
  const body = present
    ? `let seen=0;for(const p of paths){if(!fs.existsSync(p))continue;const s=fs.readFileSync(p,'utf8');if(word.test(s))seen++;}if(seen===0)fail('${missingFailure}');`
    : `let checked=0;for(const p of paths){if(!fs.existsSync(p))continue;checked++;const s=fs.readFileSync(p,'utf8');if(word.test(s))fail('${presentFailure}:'+p);}if(checked===0)fail('${missingFailure}');`;
  return (
    "const fs=require('node:fs');" +
    "const fail=(m)=>{throw new Error(m)};" +
    `const paths=[${pathList}];` +
    `const word=${wordRegex};` +
    body
  );
}

export function createInternalApiTypeRenameRecipe(
  spec: InternalApiRenameSpec,
): MigrationRecipeContract {
  if (!INTERNAL_API_IDENTIFIER.test(spec.from) || !INTERNAL_API_IDENTIFIER.test(spec.to)) {
    throw new Error("recipe_internal_api_identifier_invalid");
  }
  if (spec.from === spec.to) throw new Error("recipe_internal_api_noop");
  if (!spec.module || /["'\\]/.test(spec.module)) throw new Error("recipe_internal_api_module_invalid");
  const consumerPaths = [...spec.paths].sort();
  if (!consumerPaths.length) throw new Error("recipe_internal_api_paths_required");
  const declarationPaths = [...(spec.declarationPaths ?? [])].sort();
  const consumerSet = new Set(consumerPaths);
  for (const path of declarationPaths) {
    if (consumerSet.has(path)) throw new Error("recipe_internal_api_declaration_path_conflict");
  }
  // Completeness: a relative `module` names an in-repo producer, so the type
  // declaration (and any barrels) must travel with the consumer edits.
  const relativeModule = spec.module.startsWith("./") || spec.module.startsWith("../");
  if (relativeModule && declarationPaths.length === 0) {
    throw new Error("recipe_internal_api_declaration_required");
  }
  const allowedPaths = [...consumerPaths, ...declarationPaths].sort();
  const preconditions = [
    ...consumerPaths.map(
      (path) =>
        ({
          kind: "internal_api_type_rename_source",
          path,
          module: spec.module,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
    ...declarationPaths.map(
      (path) =>
        ({
          kind: "internal_api_type_rename_declaration",
          path,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
  ];
  const transforms = [
    ...consumerPaths.map(
      (path) =>
        ({
          kind: "internal_api_type_rename",
          path,
          module: spec.module,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
    ...declarationPaths.map(
      (path) =>
        ({
          kind: "internal_api_type_rename_declaration",
          path,
          from: spec.from,
          to: spec.to,
        }) as const,
    ),
  ];
  return createRecipe({
    id: spec.recipeId,
    version: spec.version,
    title: spec.title,
    source: spec.source,
    target: spec.target,
    allowedPaths,
    preconditions,
    transforms,
    verificationCommands: [
      {
        id: "internal-api-type-old-surface-absent",
        command: `node -e "${internalApiTypeVerifierScript(
          allowedPaths,
          spec.from,
          false,
          "internal_api_type_source_missing",
          "internal_api_type_old_present",
        )}"`,
        successCriteria: `Migrated sources contain no ${spec.from} type references`,
      },
      {
        id: "internal-api-type-new-surface-present",
        command: `node -e "${internalApiTypeVerifierScript(
          allowedPaths,
          spec.to,
          true,
          "internal_api_type_new_missing",
          "internal_api_type_new_present",
        )}"`,
        successCriteria: `Migrated sources reference ${spec.to} in at least one file`,
      },
    ],
    rollback: {
      strategy: "inverse_operations",
      requireCurrentDigest: true,
    },
  });
}

// Worked example: an internal user-service refactor that renamed the exported
// binding `getUser` to `fetchUser` in the internal package `@acme/user-service`.
// This instantiates the factory with a concrete spec; the spec is folded into
// the recipe digest, so a different spec would sign as an independent artifact.
const INTERNAL_API_ACME_USER_RENAME_SPEC: InternalApiRenameSpec = {
  recipeId: "internal-api-acme-user-getuser-to-fetchuser",
  version: 1,
  title: "Internal API refactor: acme user-service getUser to fetchUser",
  source: "acme-user-service-getUser",
  target: "acme-user-service-fetchUser",
  module: "@acme/user-service",
  from: "getUser",
  to: "fetchUser",
  paths: ["src/profile.ts", "src/settings.ts"],
};

const INTERNAL_API_ACME_USER_RENAME_V1 = createInternalApiRenameRecipe(
  INTERNAL_API_ACME_USER_RENAME_SPEC,
);

export const INTERNAL_API_ACME_USER_RENAME_RECIPE = INTERNAL_API_ACME_USER_RENAME_V1;

// Worked example (Gap 1): an in-repo rename where the producing module owns the
// declaration. `placeOrder` is exported from `./orders.js` and called by two
// consumers; the relative module forces a declaration path so the producer's
// `export function` is rewritten alongside the import and call sites.
const INTERNAL_API_ORDERS_RENAME_V1 = createInternalApiRenameRecipe({
  recipeId: "internal-api-orders-place-to-submit",
  version: 1,
  title: "Internal API refactor: orders placeOrder to submitOrder",
  source: "orders-placeOrder",
  target: "orders-submitOrder",
  module: "./orders.js",
  from: "placeOrder",
  to: "submitOrder",
  paths: ["src/cart.ts", "src/checkout.ts"],
  declarationPaths: ["src/orders.ts"],
});

// Worked example (Gap 2): a rename that threads a barrel re-export. `verifyToken`
// is declared in `./auth/token.js`, re-exported by the `./auth/index.js` barrel,
// and imported by a consumer through the barrel. All three files in the chain are
// rewritten consistently.
const INTERNAL_API_AUTH_BARREL_RENAME_V1 = createInternalApiRenameRecipe({
  recipeId: "internal-api-auth-verify-to-check",
  version: 1,
  title: "Internal API refactor: auth verifyToken to checkToken via barrel",
  source: "auth-verifyToken",
  target: "auth-checkToken",
  module: "./auth/index.js",
  from: "verifyToken",
  to: "checkToken",
  paths: ["src/middleware.ts"],
  declarationPaths: ["src/auth/index.ts", "src/auth/token.ts"],
});

// Dogfood proof: renaming this repository's own `isHumanWardenReviewer` export to
// `isHumanFettlerReviewer`. The producing module `apps/api/src/warden-review-auth.ts`
// is a declaration path; the three files that import and call the binding are the
// consumers. This is the concrete real-repo case that measured 0% before the
// declaration rewrite landed. See `scripts/rename-dogfood-proof.ts`.
const INTERNAL_API_WARDEN_REVIEWER_RENAME_V1 = createInternalApiRenameRecipe({
  recipeId: "internal-api-warden-ishuman-reviewer-rename",
  version: 1,
  title: "Internal API refactor: isHumanWardenReviewer to isHumanFettlerReviewer",
  source: "warden-isHumanWardenReviewer",
  target: "warden-isHumanFettlerReviewer",
  module: "./warden-review-auth.js",
  from: "isHumanWardenReviewer",
  to: "isHumanFettlerReviewer",
  paths: [
    "apps/api/src/transformer-adaptive-review.ts",
    "apps/api/src/warden-candidate-review.ts",
    "apps/api/src/warden-review-auth.test.ts",
  ],
  declarationPaths: ["apps/api/src/warden-review-auth.ts"],
});

// Worked example (Gap 4): an in-repo interface rename. `OrderRecord` is declared
// in `./order-types.js` and referenced only in type positions by two consumers.
// The declaration path rewrites the `interface` declaration; the consumers rewrite
// their `import type` specifier and every type-position reference.
const INTERNAL_API_ORDER_TYPE_RENAME_V1 = createInternalApiTypeRenameRecipe({
  recipeId: "internal-api-order-record-to-order-row",
  version: 1,
  title: "Internal API type refactor: OrderRecord to OrderRow",
  source: "types-OrderRecord",
  target: "types-OrderRow",
  module: "./order-types.js",
  from: "OrderRecord",
  to: "OrderRow",
  paths: ["src/order-service.ts", "src/order-view.ts"],
  declarationPaths: ["src/order-types.ts"],
});

// Dogfood proof (Gap 4): renaming this repository's own `HumanReviewDecision`
// type to `HumanReviewVerdict`. The producing module `apps/api/src/reviews.ts`
// owns the `export type` declaration; `apps/api/src/review-routes.ts` imports it
// (inline `type` specifier) and uses it only in type positions (`as` assertions).
// See `scripts/rename-dogfood-proof.ts`.
const INTERNAL_API_REVIEW_DECISION_TYPE_RENAME_V1 = createInternalApiTypeRenameRecipe({
  recipeId: "internal-api-review-decision-type-rename",
  version: 1,
  title: "Internal API type refactor: HumanReviewDecision to HumanReviewVerdict",
  source: "reviews-HumanReviewDecision",
  target: "reviews-HumanReviewVerdict",
  module: "./reviews.js",
  from: "HumanReviewDecision",
  to: "HumanReviewVerdict",
  paths: ["apps/api/src/review-routes.ts"],
  declarationPaths: ["apps/api/src/reviews.ts"],
});

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
  [
    `${INTERNAL_API_ACME_USER_RENAME_V1.id}@${INTERNAL_API_ACME_USER_RENAME_V1.version}`,
    INTERNAL_API_ACME_USER_RENAME_V1,
  ],
  [
    `${INTERNAL_API_ORDERS_RENAME_V1.id}@${INTERNAL_API_ORDERS_RENAME_V1.version}`,
    INTERNAL_API_ORDERS_RENAME_V1,
  ],
  [
    `${INTERNAL_API_AUTH_BARREL_RENAME_V1.id}@${INTERNAL_API_AUTH_BARREL_RENAME_V1.version}`,
    INTERNAL_API_AUTH_BARREL_RENAME_V1,
  ],
  [
    `${INTERNAL_API_WARDEN_REVIEWER_RENAME_V1.id}@${INTERNAL_API_WARDEN_REVIEWER_RENAME_V1.version}`,
    INTERNAL_API_WARDEN_REVIEWER_RENAME_V1,
  ],
  [
    `${INTERNAL_API_ORDER_TYPE_RENAME_V1.id}@${INTERNAL_API_ORDER_TYPE_RENAME_V1.version}`,
    INTERNAL_API_ORDER_TYPE_RENAME_V1,
  ],
  [
    `${INTERNAL_API_REVIEW_DECISION_TYPE_RENAME_V1.id}@${INTERNAL_API_REVIEW_DECISION_TYPE_RENAME_V1.version}`,
    INTERNAL_API_REVIEW_DECISION_TYPE_RENAME_V1,
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

/**
 * Migration family label vocabulary for the learning corpus. `warden-provider`
 * is reserved for the separate Warden provider-change candidate path (sealed in
 * apps/api); the deterministic recipe classifier below never emits it.
 */
export type MigrationLabelFamily =
  | "sdk"
  | "framework"
  | "runtime"
  | "internal_api"
  | "warden-provider";

/**
 * Deterministic, secret-free classification of a migration recipe for corpus
 * labeling. It is pure METADATA: it never gates or changes any control-flow
 * decision. `provider`/`framework` are populated only where the recipe context
 * makes them unambiguous, and are null otherwise (never fabricated).
 */
export type RecipeClassification = Readonly<{
  family: MigrationLabelFamily | null;
  provider: string | null;
  framework: string | null;
}>;

const NULL_RECIPE_CLASSIFICATION: RecipeClassification = Object.freeze({
  family: null,
  provider: null,
  framework: null,
});

/**
 * Classify a resolved recipe contract into a family/provider/framework label from
 * its bound transform kinds. The transform kind is the deterministic identity of
 * the migration, so this needs no external catalog and stays byte-stable. Any
 * recipe with no recognized identifying transform classifies as all-null (honest
 * "undeterminable") rather than a fabricated label.
 */
export function classifyRecipeContract(recipe: MigrationRecipeContract): RecipeClassification {
  const kinds = new Set(recipe.transforms.map((transform) => transform.kind));
  if (kinds.has("aws_sdk_source_v2_to_v3") || kinds.has("aws_dependency_swap")) {
    return Object.freeze({ family: "sdk", provider: "aws-sdk-js", framework: null });
  }
  if (kinds.has("stripe_setter_to_config")) {
    return Object.freeze({ family: "sdk", provider: "stripe", framework: null });
  }
  if (kinds.has("googleapis_default_import_to_named")) {
    return Object.freeze({ family: "sdk", provider: "googleapis", framework: null });
  }
  if (kinds.has("react_dom_render_to_root")) {
    return Object.freeze({ family: "framework", provider: "react-dom", framework: "react-dom" });
  }
  if (kinds.has("node_version_set") || kinds.has("docker_node_major_set")) {
    return Object.freeze({ family: "runtime", provider: "node", framework: null });
  }
  if (
    kinds.has("internal_api_rename") ||
    kinds.has("internal_api_rename_declaration") ||
    kinds.has("internal_api_type_rename") ||
    kinds.has("internal_api_type_rename_declaration")
  ) {
    // Internal API renames are per-customer; there is no canonical provider slug
    // or framework to attach, so those stay null while the family is determinable.
    return Object.freeze({ family: "internal_api", provider: null, framework: null });
  }
  return NULL_RECIPE_CLASSIFICATION;
}

/**
 * Classify a recipe REFERENCE. Fails closed to an all-null classification when the
 * reference cannot be resolved (unknown recipe, digest drift), so classification
 * can never throw on the seal/handoff path.
 */
export function classifyRecipeReference(reference: RecipeReference): RecipeClassification {
  try {
    return classifyRecipeContract(resolveRecipe(reference));
  } catch {
    return NULL_RECIPE_CLASSIFICATION;
  }
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
  if (precondition.kind === "internal_api_rename_source") {
    return `recipe_precondition_failed:${precondition.path}:internal_api_rename`;
  }
  if (precondition.kind === "internal_api_rename_declaration") {
    return `recipe_precondition_failed:${precondition.path}:internal_api_declaration`;
  }
  if (precondition.kind === "internal_api_type_rename_source") {
    return `recipe_precondition_failed:${precondition.path}:internal_api_type_rename`;
  }
  if (precondition.kind === "internal_api_type_rename_declaration") {
    return `recipe_precondition_failed:${precondition.path}:internal_api_type_declaration`;
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
  if (precondition.kind === "internal_api_rename_source") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyInternalApiRenameSource(
      content,
      precondition.module,
      precondition.from,
      precondition.to,
    );
  }
  if (precondition.kind === "internal_api_rename_declaration") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyInternalApiDeclarationRename(content, precondition.from, precondition.to);
  }
  if (precondition.kind === "internal_api_type_rename_source") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyInternalApiTypeConsumerRename(
      content,
      precondition.module,
      precondition.from,
      precondition.to,
    );
  }
  if (precondition.kind === "internal_api_type_rename_declaration") {
    const content = files[precondition.path];
    if (content === undefined) return { state: "neutral" };
    return classifyInternalApiTypeDeclarationRename(content, precondition.from, precondition.to);
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
  } else if (transform.kind === "react_dom_render_to_root") {
    files[transform.path] = rewriteReactDomSource(before!);
  } else if (transform.kind === "internal_api_rename") {
    files[transform.path] = rewriteInternalApiRenameSource(
      before!,
      transform.module,
      transform.from,
      transform.to,
    );
  } else if (transform.kind === "internal_api_rename_declaration") {
    files[transform.path] = rewriteInternalApiDeclarationRename(
      before!,
      transform.from,
      transform.to,
    );
  } else if (transform.kind === "internal_api_type_rename") {
    files[transform.path] = rewriteInternalApiTypeConsumerRename(
      before!,
      transform.module,
      transform.from,
      transform.to,
    );
  } else {
    files[transform.path] = rewriteInternalApiTypeDeclarationRename(
      before!,
      transform.from,
      transform.to,
    );
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
