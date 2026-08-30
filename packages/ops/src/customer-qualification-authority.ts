import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  parseCustomerQualificationAttestation,
  type CustomerQualificationAttestation,
  type CustomerReadinessAuthority,
} from "./customer-readiness.js";

export const CUSTOMER_QUALIFICATION_BUNDLE_SCHEMA = "2026-08-30.v1" as const;

export type CustomerQualificationAuthorityLoadReason =
  | "authority_root_invalid"
  | "authority_root_reparse_point"
  | "bundle_invalid"
  | "bundle_missing"
  | "bundle_reparse_point"
  | "bundle_schema_invalid"
  | "bundle_path_invalid"
  | "artifact_missing"
  | "artifact_path_invalid"
  | "artifact_reparse_point"
  | "artifact_digest_mismatch"
  | "attestation_digest_mismatch"
  | "release_revision_invalid"
  | "release_revision_mismatch"
  | "authority_io_failed";

export type CustomerQualificationAuthorityLoadResult =
  | Readonly<{ status: "loaded"; authority: CustomerReadinessAuthority }>
  | Readonly<{
      status: "indeterminate";
      reason: CustomerQualificationAuthorityLoadReason;
      authority: CustomerReadinessAuthority;
    }>;

export type LoadCustomerQualificationAuthorityInput = Readonly<{
  authorityRoot: string;
  bundlePath: string;
  releaseRevision: string;
}>;

type ArtifactName = "requirementRegister" | "publicClaimsRegistry" | "evidenceManifest";
type ArtifactReference = Readonly<{ path: string; sha256: `sha256:${string}` }>;
type QualificationBundle = Readonly<{
  schemaVersion: typeof CUSTOMER_QUALIFICATION_BUNDLE_SCHEMA;
  attestation: CustomerQualificationAttestation;
  artifacts: Readonly<Record<ArtifactName, ArtifactReference>>;
  revokedEvidenceIds: readonly string[];
}>;

const RELEASE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const BUNDLE_KEYS = ["schemaVersion", "attestation", "artifacts", "revokedEvidenceIds"] as const;
const ARTIFACT_KEYS = ["requirementRegister", "publicClaimsRegistry", "evidenceManifest"] as const;
const ARTIFACT_REFERENCE_KEYS = ["path", "sha256"] as const;

class QualificationAuthorityError extends Error {
  constructor(readonly reason: CustomerQualificationAuthorityLoadReason) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const withoutExtendedPrefix = value.startsWith("\\\\?\\") ? value.slice(4) : value;
    const normalized = resolve(withoutExtendedPrefix);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function containedPath(root: string, target: string): boolean {
  const locator = relative(root, target);
  return locator === "" || (!locator.startsWith("..") && !isAbsolute(locator));
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/u);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function canonicalAuthorityRoot(rootInput: string): Promise<string> {
  const root = resolve(rootInput);
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new QualificationAuthorityError("authority_root_invalid");
    }
    throw new QualificationAuthorityError("authority_io_failed");
  }
  if (stats.isSymbolicLink()) throw new QualificationAuthorityError("authority_root_reparse_point");
  if (!stats.isDirectory()) throw new QualificationAuthorityError("authority_root_invalid");
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch {
    throw new QualificationAuthorityError("authority_io_failed");
  }
  if (!sameFilesystemPath(root, canonical)) {
    throw new QualificationAuthorityError("authority_root_reparse_point");
  }
  return canonical;
}

async function safeFilePath(
  canonicalRoot: string,
  locator: string,
  kind: "bundle" | "artifact",
): Promise<string> {
  const invalidReason = kind === "bundle" ? "bundle_path_invalid" : "artifact_path_invalid";
  const missingReason = kind === "bundle" ? "bundle_missing" : "artifact_missing";
  const reparseReason = kind === "bundle" ? "bundle_reparse_point" : "artifact_reparse_point";
  if (!isSafeRelativePath(locator)) throw new QualificationAuthorityError(invalidReason);
  const target = resolve(canonicalRoot, locator);
  if (!containedPath(canonicalRoot, target)) throw new QualificationAuthorityError(invalidReason);

  const segments = relative(canonicalRoot, target).split(sep);
  let current = canonicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new QualificationAuthorityError(missingReason);
      }
      throw new QualificationAuthorityError("authority_io_failed");
    }
    if (stats.isSymbolicLink()) throw new QualificationAuthorityError(reparseReason);
    const isTarget = index === segments.length - 1;
    if (isTarget ? !stats.isFile() : !stats.isDirectory()) {
      throw new QualificationAuthorityError(invalidReason);
    }
    let canonicalCurrent: string;
    try {
      canonicalCurrent = await realpath(current);
    } catch {
      throw new QualificationAuthorityError("authority_io_failed");
    }
    if (!containedPath(canonicalRoot, canonicalCurrent) || !sameFilesystemPath(current, canonicalCurrent)) {
      throw new QualificationAuthorityError(reparseReason);
    }
  }
  return target;
}

function parseArtifactReference(value: unknown): ArtifactReference | null {
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_REFERENCE_KEYS)) return null;
  if (
    typeof value.path !== "string" ||
    !isSafeRelativePath(value.path) ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256)
  ) return null;
  return value as ArtifactReference;
}

function parseQualificationBundle(value: unknown): QualificationBundle | null {
  if (!isRecord(value) || !hasExactKeys(value, BUNDLE_KEYS)) return null;
  if (value.schemaVersion !== CUSTOMER_QUALIFICATION_BUNDLE_SCHEMA) return null;
  const attestation = parseCustomerQualificationAttestation(value.attestation);
  if (!attestation || !isRecord(value.artifacts) || !hasExactKeys(value.artifacts, ARTIFACT_KEYS)) return null;
  const requirementRegister = parseArtifactReference(value.artifacts.requirementRegister);
  const publicClaimsRegistry = parseArtifactReference(value.artifacts.publicClaimsRegistry);
  const evidenceManifest = parseArtifactReference(value.artifacts.evidenceManifest);
  if (!requirementRegister || !publicClaimsRegistry || !evidenceManifest) return null;
  if (!Array.isArray(value.revokedEvidenceIds)) return null;
  const revokedEvidenceIds = value.revokedEvidenceIds;
  if (
    !revokedEvidenceIds.every((entry) => typeof entry === "string" && entry.trim() === entry && entry.length > 0) ||
    new Set(revokedEvidenceIds).size !== revokedEvidenceIds.length
  ) return null;
  const paths = [requirementRegister.path, publicClaimsRegistry.path, evidenceManifest.path];
  if (new Set(paths.map((path) => process.platform === "win32" ? path.toLowerCase() : path)).size !== paths.length) {
    return null;
  }
  return {
    schemaVersion: CUSTOMER_QUALIFICATION_BUNDLE_SCHEMA,
    attestation,
    artifacts: { requirementRegister, publicClaimsRegistry, evidenceManifest },
    revokedEvidenceIds: [...revokedEvidenceIds],
  };
}

function rawDigest(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function indeterminate(
  reason: CustomerQualificationAuthorityLoadReason,
  releaseRevision?: string,
): CustomerQualificationAuthorityLoadResult {
  return {
    status: "indeterminate",
    reason,
    authority: RELEASE_REVISION.test(releaseRevision ?? "") ? { releaseRevision } : {},
  };
}

/**
 * Loads a protected qualification bundle without creating or interpreting its
 * evidence. Every authority file is bound by its raw bytes and confined to an
 * explicit, non-reparse local root. Any ambiguity produces an indeterminate
 * authority that cannot satisfy customer-readiness qualification.
 */
export async function loadCustomerQualificationAuthority(
  input: LoadCustomerQualificationAuthorityInput,
): Promise<CustomerQualificationAuthorityLoadResult> {
  if (!RELEASE_REVISION.test(input.releaseRevision)) return indeterminate("release_revision_invalid");
  try {
    const root = await canonicalAuthorityRoot(input.authorityRoot);
    const bundleFile = await safeFilePath(root, input.bundlePath, "bundle");
    let bundleValue: unknown;
    try {
      bundleValue = JSON.parse(await readFile(bundleFile, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new QualificationAuthorityError("bundle_invalid");
      throw new QualificationAuthorityError("authority_io_failed");
    }
    const bundle = parseQualificationBundle(bundleValue);
    if (!bundle) throw new QualificationAuthorityError("bundle_schema_invalid");
    if (bundle.attestation.qualifiedRevision !== input.releaseRevision) {
      throw new QualificationAuthorityError("release_revision_mismatch");
    }

    const artifactEntries = await Promise.all(ARTIFACT_KEYS.map(async (name) => {
      const reference = bundle.artifacts[name];
      const file = await safeFilePath(root, reference.path, "artifact");
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        throw new QualificationAuthorityError("authority_io_failed");
      }
      const digest = rawDigest(bytes);
      if (digest !== reference.sha256) throw new QualificationAuthorityError("artifact_digest_mismatch");
      return [name, digest] as const;
    }));
    const digests = Object.fromEntries(artifactEntries) as Record<ArtifactName, `sha256:${string}`>;
    if (
      bundle.attestation.requirementRegisterDigest !== digests.requirementRegister ||
      bundle.attestation.publicClaimsRegistryDigest !== digests.publicClaimsRegistry ||
      bundle.attestation.evidenceManifestDigest !== digests.evidenceManifest
    ) throw new QualificationAuthorityError("attestation_digest_mismatch");

    return {
      status: "loaded",
      authority: {
        qualificationAttestation: bundle.attestation,
        trustRoots: {
          requirementRegisterDigest: digests.requirementRegister,
          publicClaimsRegistryDigest: digests.publicClaimsRegistry,
          evidenceManifestDigest: digests.evidenceManifest,
        },
        revokedEvidenceIds: bundle.revokedEvidenceIds,
        releaseRevision: input.releaseRevision,
      },
    };
  } catch (error) {
    if (error instanceof QualificationAuthorityError) return indeterminate(error.reason, input.releaseRevision);
    return indeterminate("authority_io_failed", input.releaseRevision);
  }
}
