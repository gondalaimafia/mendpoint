import {
  createHash,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type KeyLike,
} from "node:crypto";
import { posix } from "node:path";
import { resolveRecipe, type RecipeReference } from "./recipe.js";

export const PROVIDER_RECIPE_SCHEMA_VERSION = "2026-08-02.v1" as const;

export const PROVIDER_CATEGORIES = [
  "payments",
  "identity",
  "communications",
  "cloud",
  "data",
  "developer_platform",
  "observability",
] as const;

export const PROVIDER_CHANGE_TARGETS = [
  "api",
  "sdk",
  "framework",
  "runtime",
  "authentication",
  "webhook",
  "schema",
  "configuration",
  "protocol",
] as const;

export const PROVIDER_CHANGE_KINDS = [
  "breaking",
  "behavioral",
  "security",
  "deprecation",
  "performance",
] as const;

export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];
export type ProviderChangeTarget = (typeof PROVIDER_CHANGE_TARGETS)[number];
export type ProviderChangeKind = (typeof PROVIDER_CHANGE_KINDS)[number];

export type ProviderRecipeSignal = Readonly<{
  kind: "file_exists" | "manifest_value" | "source_pattern" | "provider_evidence";
  path: string;
  selector: string;
  expected: string;
  evidenceRequired: true;
}>;

export type ProviderRecipePrecondition = Readonly<{
  id: string;
  kind: ProviderRecipeSignal["kind"];
  path: string;
  selector: string;
  expected: string;
}>;

export type ProviderRecipeArtifact = Readonly<{
  schemaVersion: typeof PROVIDER_RECIPE_SCHEMA_VERSION;
  recipeId: string;
  version: number;
  publishedAt: string;
  provider: Readonly<{
    slug: string;
    category: ProviderCategory;
  }>;
  change: Readonly<{
    target: ProviderChangeTarget;
    kind: ProviderChangeKind;
    fromVersion: string;
    toVersion: string;
  }>;
  detection: Readonly<{
    allOf: readonly ProviderRecipeSignal[];
  }>;
  preconditions: readonly ProviderRecipePrecondition[];
  boundedEdits: Readonly<{
    implementationRecipe: RecipeReference;
    allowedPaths: readonly string[];
    allowedOperationKinds: readonly ["replace_file"];
    maxFilesChanged: number;
    maxBytesChanged: number;
  }>;
  verification: readonly Readonly<{
    id: string;
    command: string;
    timeoutMs: number;
    successCriteria: string;
    required: true;
  }>[];
  rollback: Readonly<{
    strategy: "inverse_operations";
    verificationIds: readonly string[];
    maxRecoveryMinutes: number;
  }>;
  evidence: Readonly<{
    requiredSourceKinds: readonly (
      | "provider_release"
      | "provider_documentation"
      | "repository_snapshot"
      | "customer_incident"
    )[];
    retainInputSnapshot: true;
    retainOperationDiffs: true;
    retainVerificationOutput: true;
  }>;
  ownership: Readonly<{
    team: string;
    maintainerPrincipalId: string;
    securityReviewerPrincipalId: string;
  }>;
  compatibility: Readonly<{
    languages: readonly string[];
    packageManagers: readonly string[];
    repositoryKinds: readonly string[];
    runtime: Readonly<{
      name: string;
      minMajor: number;
      maxMajor: number;
    }>;
  }>;
  outcomeTelemetry: Readonly<{
    schemaVersion: 1;
    eventName: "provider_recipe_outcome";
    correlationFields: readonly ["tenantId", "campaignId", "runId", "recipeArtifactSha256"];
    metricIds: readonly string[];
    retentionDays: number;
  }>;
}>;

export type SignedProviderRecipe = Readonly<{
  artifact: ProviderRecipeArtifact;
  integrity: Readonly<{
    algorithm: "ed25519";
    keyId: string;
    artifactSha256: string;
    signature: string;
  }>;
}>;

export type ProviderRecipeResolution = Readonly<{
  providerSlug: string;
  providerCategory: ProviderCategory;
  changeTarget: ProviderChangeTarget;
  changeKind: ProviderChangeKind;
  fromVersion: string;
  toVersion: string;
  language: string;
  packageManager: string;
  repositoryKind: string;
  runtime: Readonly<{ name: string; major: number }>;
}>;

export type ProviderRecipeOutcomeEvent = Readonly<{
  schemaVersion: 1;
  eventName: "provider_recipe_outcome";
  tenantId: string;
  campaignId: string;
  runId: string;
  recipeArtifactSha256: string;
  recipeId: string;
  recipeVersion: number;
  observedAt: string;
  metrics: Readonly<Record<string, string | number | boolean>>;
}>;

export class RecipeCatalogError extends Error {
  constructor(readonly code: string, readonly path?: string) {
    super(path ? `${code}:${path}` : code);
    this.name = "RecipeCatalogError";
  }
}

const IDENTIFIER = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/;
const METRIC_IDENTIFIER = /^[a-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_KINDS = new Set([
  "provider_release",
  "provider_documentation",
  "repository_snapshot",
  "customer_incident",
]);

function fail(code: string, path?: string): never {
  throw new RecipeCatalogError(code, path);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("recipe_object_required", path);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("recipe_field_unknown", `${path}.${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) fail("recipe_field_required", `${path}.${key}`);
  }
}

function text(value: unknown, path: string, max = 512): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max) {
    fail("recipe_text_invalid", path);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path, 128);
  if (!IDENTIFIER.test(result)) fail("recipe_identifier_invalid", path);
  return result;
}

function metricIdentifier(value: unknown, path: string): string {
  const result = text(value, path, 128);
  if (!METRIC_IDENTIFIER.test(result)) fail("recipe_metric_identifier_invalid", path);
  return result;
}

function positiveInteger(value: unknown, path: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    fail("recipe_integer_invalid", path);
  }
  return Number(value);
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 40);
  const parsed = Date.parse(result);
  if (!CANONICAL_TIMESTAMP.test(result) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    fail("recipe_timestamp_invalid", path);
  }
  return result;
}

function nonEmptyArray(value: unknown, path: string, max = 100): readonly unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) fail("recipe_array_invalid", path);
  return value;
}

function uniqueStrings(value: unknown, path: string, max = 100): readonly string[] {
  const entries = nonEmptyArray(value, path, max).map((item, index) => text(item, `${path}.${index}`));
  if (new Set(entries).size !== entries.length) fail("recipe_value_duplicate", path);
  return entries;
}

function safePath(value: unknown, path: string): string {
  const result = text(value, path, 512);
  if (result.includes("\\") || posix.isAbsolute(result)) fail("recipe_path_invalid", path);
  const normalized = posix.normalize(result);
  if (normalized !== result || normalized === ".." || normalized.startsWith("../")) {
    fail("recipe_path_invalid", path);
  }
  return result;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("recipe_enum_invalid", path);
  return value as T;
}

function validateSignal(value: unknown, path: string, withId: boolean): void {
  const candidate = object(value, path);
  exactKeys(
    candidate,
    withId
      ? ["id", "kind", "path", "selector", "expected"]
      : ["kind", "path", "selector", "expected", "evidenceRequired"],
    path,
  );
  if (withId) identifier(candidate.id, `${path}.id`);
  enumValue(candidate.kind, ["file_exists", "manifest_value", "source_pattern", "provider_evidence"], `${path}.kind`);
  safePath(candidate.path, `${path}.path`);
  text(candidate.selector, `${path}.selector`, 1_000);
  text(candidate.expected, `${path}.expected`, 2_000);
  if (!withId && candidate.evidenceRequired !== true) fail("recipe_evidence_required", `${path}.evidenceRequired`);
}

function validateArtifact(input: unknown): asserts input is ProviderRecipeArtifact {
  const artifact = object(input, "artifact");
  exactKeys(artifact, [
    "schemaVersion", "recipeId", "version", "publishedAt", "provider", "change",
    "detection", "preconditions", "boundedEdits", "verification", "rollback",
    "evidence", "ownership", "compatibility", "outcomeTelemetry",
  ], "artifact");
  if (artifact.schemaVersion !== PROVIDER_RECIPE_SCHEMA_VERSION) fail("recipe_schema_unsupported");
  identifier(artifact.recipeId, "artifact.recipeId");
  positiveInteger(artifact.version, "artifact.version", 1_000_000);
  timestamp(artifact.publishedAt, "artifact.publishedAt");

  const provider = object(artifact.provider, "artifact.provider");
  exactKeys(provider, ["slug", "category"], "artifact.provider");
  identifier(provider.slug, "artifact.provider.slug");
  enumValue(provider.category, PROVIDER_CATEGORIES, "artifact.provider.category");

  const change = object(artifact.change, "artifact.change");
  exactKeys(change, ["target", "kind", "fromVersion", "toVersion"], "artifact.change");
  enumValue(change.target, PROVIDER_CHANGE_TARGETS, "artifact.change.target");
  enumValue(change.kind, PROVIDER_CHANGE_KINDS, "artifact.change.kind");
  const fromVersion = text(change.fromVersion, "artifact.change.fromVersion", 128);
  const toVersion = text(change.toVersion, "artifact.change.toVersion", 128);
  if (fromVersion === toVersion) fail("recipe_change_noop", "artifact.change");

  const detection = object(artifact.detection, "artifact.detection");
  exactKeys(detection, ["allOf"], "artifact.detection");
  nonEmptyArray(detection.allOf, "artifact.detection.allOf", 50).forEach((entry, index) =>
    validateSignal(entry, `artifact.detection.allOf.${index}`, false));
  const preconditions = nonEmptyArray(artifact.preconditions, "artifact.preconditions", 50);
  preconditions.forEach((entry, index) => validateSignal(entry, `artifact.preconditions.${index}`, true));
  const preconditionIds = preconditions.map((entry) => (entry as Record<string, unknown>).id);
  if (new Set(preconditionIds).size !== preconditionIds.length) fail("recipe_precondition_duplicate");

  const edits = object(artifact.boundedEdits, "artifact.boundedEdits");
  exactKeys(edits, ["implementationRecipe", "allowedPaths", "allowedOperationKinds", "maxFilesChanged", "maxBytesChanged"], "artifact.boundedEdits");
  const implementation = object(edits.implementationRecipe, "artifact.boundedEdits.implementationRecipe");
  exactKeys(implementation, ["id", "version", "digest"], "artifact.boundedEdits.implementationRecipe");
  identifier(implementation.id, "artifact.boundedEdits.implementationRecipe.id");
  positiveInteger(implementation.version, "artifact.boundedEdits.implementationRecipe.version", 1_000_000);
  if (typeof implementation.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(implementation.digest)) {
    fail("recipe_digest_invalid", "artifact.boundedEdits.implementationRecipe.digest");
  }
  let executable;
  try {
    executable = resolveRecipe(implementation as RecipeReference);
  } catch {
    fail("recipe_implementation_incompatible");
  }
  const allowedPaths = uniqueStrings(edits.allowedPaths, "artifact.boundedEdits.allowedPaths", 100)
    .map((entry, index) => safePath(entry, `artifact.boundedEdits.allowedPaths.${index}`));
  for (const path of allowedPaths) {
    if (!executable.allowedPaths.includes(path)) fail("recipe_implementation_path_incompatible", path);
  }
  for (const path of executable.allowedPaths) {
    if (!allowedPaths.includes(path)) fail("recipe_implementation_path_incompatible", path);
  }
  if (!Array.isArray(edits.allowedOperationKinds) || edits.allowedOperationKinds.length !== 1 || edits.allowedOperationKinds[0] !== "replace_file") {
    fail("recipe_operation_kind_invalid");
  }
  const maxFiles = positiveInteger(edits.maxFilesChanged, "artifact.boundedEdits.maxFilesChanged", 100);
  if (maxFiles > allowedPaths.length) fail("recipe_edit_bound_invalid", "artifact.boundedEdits.maxFilesChanged");
  const possibleChangedPaths = new Set(executable.transforms.map((transform) => transform.path)).size;
  if (maxFiles < possibleChangedPaths) fail("recipe_edit_bound_invalid", "artifact.boundedEdits.maxFilesChanged");
  positiveInteger(edits.maxBytesChanged, "artifact.boundedEdits.maxBytesChanged", 10_000_000);

  const verification = nonEmptyArray(artifact.verification, "artifact.verification", 50);
  const verificationIds: string[] = [];
  verification.forEach((entry, index) => {
    const check = object(entry, `artifact.verification.${index}`);
    exactKeys(check, ["id", "command", "timeoutMs", "successCriteria", "required"], `artifact.verification.${index}`);
    verificationIds.push(identifier(check.id, `artifact.verification.${index}.id`));
    text(check.command, `artifact.verification.${index}.command`, 2_048);
    positiveInteger(check.timeoutMs, `artifact.verification.${index}.timeoutMs`, 900_000);
    text(check.successCriteria, `artifact.verification.${index}.successCriteria`, 2_000);
    if (check.required !== true) fail("recipe_verification_required", `artifact.verification.${index}.required`);
  });
  if (new Set(verificationIds).size !== verificationIds.length) fail("recipe_verification_duplicate");

  const rollback = object(artifact.rollback, "artifact.rollback");
  exactKeys(rollback, ["strategy", "verificationIds", "maxRecoveryMinutes"], "artifact.rollback");
  if (rollback.strategy !== "inverse_operations") fail("recipe_rollback_invalid");
  const rollbackIds = uniqueStrings(rollback.verificationIds, "artifact.rollback.verificationIds", 50);
  for (const id of rollbackIds) {
    if (!verificationIds.includes(id)) fail("recipe_rollback_verification_unknown", id);
  }
  positiveInteger(rollback.maxRecoveryMinutes, "artifact.rollback.maxRecoveryMinutes", 43_200);

  const evidence = object(artifact.evidence, "artifact.evidence");
  exactKeys(evidence, ["requiredSourceKinds", "retainInputSnapshot", "retainOperationDiffs", "retainVerificationOutput"], "artifact.evidence");
  for (const kind of uniqueStrings(evidence.requiredSourceKinds, "artifact.evidence.requiredSourceKinds", 10)) {
    if (!EVIDENCE_KINDS.has(kind)) fail("recipe_evidence_kind_invalid", kind);
  }
  for (const field of ["retainInputSnapshot", "retainOperationDiffs", "retainVerificationOutput"] as const) {
    if (evidence[field] !== true) fail("recipe_evidence_required", `artifact.evidence.${field}`);
  }

  const ownership = object(artifact.ownership, "artifact.ownership");
  exactKeys(ownership, ["team", "maintainerPrincipalId", "securityReviewerPrincipalId"], "artifact.ownership");
  identifier(ownership.team, "artifact.ownership.team");
  const maintainer = identifier(ownership.maintainerPrincipalId, "artifact.ownership.maintainerPrincipalId");
  const securityReviewer = identifier(ownership.securityReviewerPrincipalId, "artifact.ownership.securityReviewerPrincipalId");
  if (maintainer === securityReviewer) fail("recipe_ownership_separation_required");

  const compatibility = object(artifact.compatibility, "artifact.compatibility");
  exactKeys(compatibility, ["languages", "packageManagers", "repositoryKinds", "runtime"], "artifact.compatibility");
  uniqueStrings(compatibility.languages, "artifact.compatibility.languages", 20).forEach((entry, index) => identifier(entry, `artifact.compatibility.languages.${index}`));
  uniqueStrings(compatibility.packageManagers, "artifact.compatibility.packageManagers", 20).forEach((entry, index) => identifier(entry, `artifact.compatibility.packageManagers.${index}`));
  uniqueStrings(compatibility.repositoryKinds, "artifact.compatibility.repositoryKinds", 20).forEach((entry, index) => identifier(entry, `artifact.compatibility.repositoryKinds.${index}`));
  const runtime = object(compatibility.runtime, "artifact.compatibility.runtime");
  exactKeys(runtime, ["name", "minMajor", "maxMajor"], "artifact.compatibility.runtime");
  identifier(runtime.name, "artifact.compatibility.runtime.name");
  const minMajor = positiveInteger(runtime.minMajor, "artifact.compatibility.runtime.minMajor", 10_000);
  const maxMajor = positiveInteger(runtime.maxMajor, "artifact.compatibility.runtime.maxMajor", 10_000);
  if (maxMajor < minMajor) fail("recipe_runtime_range_invalid");

  const telemetry = object(artifact.outcomeTelemetry, "artifact.outcomeTelemetry");
  exactKeys(telemetry, ["schemaVersion", "eventName", "correlationFields", "metricIds", "retentionDays"], "artifact.outcomeTelemetry");
  if (telemetry.schemaVersion !== 1 || telemetry.eventName !== "provider_recipe_outcome") fail("recipe_telemetry_schema_invalid");
  const expectedCorrelation = ["tenantId", "campaignId", "runId", "recipeArtifactSha256"];
  if (!Array.isArray(telemetry.correlationFields) || telemetry.correlationFields.length !== expectedCorrelation.length || telemetry.correlationFields.some((entry, index) => entry !== expectedCorrelation[index])) {
    fail("recipe_telemetry_correlation_invalid");
  }
  uniqueStrings(telemetry.metricIds, "artifact.outcomeTelemetry.metricIds", 50).forEach((entry, index) => metricIdentifier(entry, `artifact.outcomeTelemetry.metricIds.${index}`));
  positiveInteger(telemetry.retentionDays, "artifact.outcomeTelemetry.retentionDays", 3_650);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function canonicalArtifactBytes(artifact: ProviderRecipeArtifact): Buffer {
  return Buffer.from(JSON.stringify(stableValue(artifact)), "utf8");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function recipeArtifactSha256(artifact: ProviderRecipeArtifact): string {
  validateArtifact(artifact);
  return createHash("sha256").update(canonicalArtifactBytes(artifact)).digest("hex");
}

export function signProviderRecipe(
  artifact: ProviderRecipeArtifact,
  keyId: string,
  privateKey: KeyLike,
): SignedProviderRecipe {
  const retained = structuredClone(artifact);
  validateArtifact(retained);
  identifier(keyId, "integrity.keyId");
  const bytes = canonicalArtifactBytes(retained);
  const result = {
    artifact: retained,
    integrity: {
      algorithm: "ed25519" as const,
      keyId,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      signature: signBytes(null, bytes, privateKey).toString("base64"),
    },
  };
  return deepFreeze(result);
}

function validateSignedRecipe(input: unknown): asserts input is SignedProviderRecipe {
  const signed = object(input, "recipe");
  if (!("integrity" in signed)) fail("recipe_unsigned");
  exactKeys(signed, ["artifact", "integrity"], "recipe");
  validateArtifact(signed.artifact);
  const integrity = object(signed.integrity, "recipe.integrity");
  exactKeys(integrity, ["algorithm", "keyId", "artifactSha256", "signature"], "recipe.integrity");
  if (integrity.algorithm !== "ed25519") fail("recipe_signature_algorithm_invalid");
  identifier(integrity.keyId, "recipe.integrity.keyId");
  if (typeof integrity.artifactSha256 !== "string" || !SHA256.test(integrity.artifactSha256)) fail("recipe_artifact_digest_invalid");
  const signature = text(integrity.signature, "recipe.integrity.signature", 256);
  const decoded = Buffer.from(signature, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== signature) fail("recipe_signature_malformed");
}

export function verifyProviderRecipeSignature(
  recipe: SignedProviderRecipe,
  publicKey: KeyLike,
): boolean {
  try {
    validateSignedRecipe(recipe);
    const bytes = canonicalArtifactBytes(recipe.artifact);
    const expectedDigest = createHash("sha256").update(bytes).digest();
    const suppliedDigest = Buffer.from(recipe.integrity.artifactSha256, "hex");
    if (suppliedDigest.length !== expectedDigest.length || !timingSafeEqual(suppliedDigest, expectedDigest)) return false;
    return verifyBytes(null, bytes, publicKey, Buffer.from(recipe.integrity.signature, "base64"));
  } catch {
    return false;
  }
}

function sameMigration(recipe: SignedProviderRecipe, query: ProviderRecipeResolution): boolean {
  const { artifact } = recipe;
  return artifact.provider.slug === query.providerSlug
    && artifact.provider.category === query.providerCategory
    && artifact.change.target === query.changeTarget
    && artifact.change.kind === query.changeKind
    && artifact.change.fromVersion === query.fromVersion
    && artifact.change.toVersion === query.toVersion;
}

function compatible(recipe: SignedProviderRecipe, query: ProviderRecipeResolution): boolean {
  const rules = recipe.artifact.compatibility;
  return rules.languages.includes(query.language)
    && rules.packageManagers.includes(query.packageManager)
    && rules.repositoryKinds.includes(query.repositoryKind)
    && rules.runtime.name === query.runtime.name
    && query.runtime.major >= rules.runtime.minMajor
    && query.runtime.major <= rules.runtime.maxMajor;
}

export function createProviderRecipeCatalog(input: Readonly<{
  artifacts: readonly unknown[];
  trustedKeys: readonly Readonly<{ keyId: string; algorithm: "ed25519"; publicKey: KeyLike }>[];
  revokedArtifactSha256?: readonly string[];
  revokedRecipeVersions?: readonly string[];
  revokedKeyIds?: readonly string[];
  now: string;
}>): Readonly<{
  list(): readonly SignedProviderRecipe[];
  resolve(query: ProviderRecipeResolution): SignedProviderRecipe;
}> {
  const now = Date.parse(timestamp(input.now, "now"));
  const trusted = new Map<string, KeyLike>();
  for (const key of input.trustedKeys) {
    identifier(key.keyId, "trustedKeys.keyId");
    if (key.algorithm !== "ed25519") fail("recipe_signature_algorithm_invalid");
    if (trusted.has(key.keyId)) fail("recipe_signing_key_duplicate", key.keyId);
    trusted.set(key.keyId, key.publicKey);
  }
  const revokedDigests = new Set(input.revokedArtifactSha256 ?? []);
  const revokedVersions = new Set(input.revokedRecipeVersions ?? []);
  const revokedKeys = new Set(input.revokedKeyIds ?? []);
  for (const digest of revokedDigests) if (!SHA256.test(digest)) fail("recipe_revocation_invalid", digest);

  const versions = new Set<string>();
  const accepted: SignedProviderRecipe[] = [];
  for (const supplied of input.artifacts) {
    const item = structuredClone(supplied);
    validateSignedRecipe(item);
    const identity = `${item.artifact.recipeId}@${item.artifact.version}`;
    if (versions.has(identity)) fail("recipe_duplicate", identity);
    versions.add(identity);
    if (revokedDigests.has(item.integrity.artifactSha256) || revokedVersions.has(identity) || revokedKeys.has(item.integrity.keyId)) {
      fail("recipe_revoked", identity);
    }
    const key = trusted.get(item.integrity.keyId);
    if (!key) fail("recipe_signing_key_untrusted", item.integrity.keyId);
    const actualDigest = recipeArtifactSha256(item.artifact);
    if (actualDigest !== item.integrity.artifactSha256) fail("recipe_artifact_digest_mismatch", identity);
    if (!verifyProviderRecipeSignature(item, key)) fail("recipe_signature_invalid", identity);
    if (Date.parse(item.artifact.publishedAt) > now) fail("recipe_not_yet_published", identity);
    accepted.push(deepFreeze(item));
  }
  const immutable = Object.freeze([...accepted].sort((left, right) =>
    `${left.artifact.recipeId}@${left.artifact.version}`.localeCompare(`${right.artifact.recipeId}@${right.artifact.version}`)));
  return Object.freeze({
    list: () => immutable,
    resolve(query: ProviderRecipeResolution): SignedProviderRecipe {
      identifier(query.providerSlug, "query.providerSlug");
      enumValue(query.providerCategory, PROVIDER_CATEGORIES, "query.providerCategory");
      enumValue(query.changeTarget, PROVIDER_CHANGE_TARGETS, "query.changeTarget");
      enumValue(query.changeKind, PROVIDER_CHANGE_KINDS, "query.changeKind");
      text(query.fromVersion, "query.fromVersion", 128);
      text(query.toVersion, "query.toVersion", 128);
      identifier(query.language, "query.language");
      identifier(query.packageManager, "query.packageManager");
      identifier(query.repositoryKind, "query.repositoryKind");
      identifier(query.runtime.name, "query.runtime.name");
      positiveInteger(query.runtime.major, "query.runtime.major", 10_000);
      const migrationMatches = immutable.filter((recipe) => sameMigration(recipe, query));
      if (!migrationMatches.length) fail("recipe_not_found");
      const compatibleMatches = migrationMatches.filter((recipe) => compatible(recipe, query));
      if (!compatibleMatches.length) fail("recipe_incompatible");
      if (compatibleMatches.length !== 1) fail("recipe_ambiguous");
      return compatibleMatches[0]!;
    },
  });
}

export function createRecipeOutcomeEvent(
  recipe: SignedProviderRecipe,
  input: Readonly<{
    tenantId: string;
    campaignId: string;
    runId: string;
    observedAt: string;
    metrics: Readonly<Record<string, string | number | boolean>>;
  }>,
): ProviderRecipeOutcomeEvent {
  validateSignedRecipe(recipe);
  if (recipeArtifactSha256(recipe.artifact) !== recipe.integrity.artifactSha256) {
    fail("recipe_artifact_digest_mismatch");
  }
  const declared = new Set(recipe.artifact.outcomeTelemetry.metricIds);
  const metrics: Record<string, string | number | boolean> = {};
  const entries = Object.entries(input.metrics).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) fail("recipe_outcome_metrics_required");
  for (const [metricId, value] of entries) {
    if (!declared.has(metricId)) fail("recipe_outcome_metric_undeclared", metricId);
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") || (typeof value === "number" && !Number.isFinite(value))) {
      fail("recipe_outcome_metric_invalid", metricId);
    }
    metrics[metricId] = value;
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    eventName: "provider_recipe_outcome" as const,
    tenantId: identifier(input.tenantId, "outcome.tenantId"),
    campaignId: identifier(input.campaignId, "outcome.campaignId"),
    runId: identifier(input.runId, "outcome.runId"),
    recipeArtifactSha256: recipe.integrity.artifactSha256,
    recipeId: recipe.artifact.recipeId,
    recipeVersion: recipe.artifact.version,
    observedAt: timestamp(input.observedAt, "outcome.observedAt"),
    metrics,
  });
}
