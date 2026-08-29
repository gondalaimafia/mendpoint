import { createHash } from "node:crypto";
import type { EvidenceState, LearningCase, RepositoryProvenance } from "./schema.js";

export interface FixtureManifest {
  schemaVersion: "mendpoint.fixture-manifest.v1";
  manifestId: string;
  caseId: string;
  repository: {
    provenanceId: string;
    immutableCommit: string;
    pristineSnapshotSha256: string;
  };
  mutation: {
    id: string;
    kind: "patch" | "historical_bug";
    patchPath: string;
    patchSha256: string;
    seededFailure: string;
  };
  expectedImpactGraph: {
    nodes: string[];
    edges: Array<{ from: string; to: string; relation: string }>;
    evidenceState: EvidenceState;
  };
  failingOracle: {
    id: string;
    argv: string[];
    expectedExitCode: number;
    expectedOutputPattern: string;
  };
  allowedEditPaths: string[];
  expectedFixOrMigration: string;
  rollback: {
    id: string;
    reversePatchSha256: string;
    oracleId: string;
  };
  cleanup: {
    id: string;
    removePaths: string[];
    pristineTreeSha256: string;
  };
}

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_RELATIVE_PATH = /^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fixtureManifestDigest(manifest: FixtureManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function validateFixtureManifest(
  manifest: FixtureManifest,
  learningCase: LearningCase,
  repository: RepositoryProvenance,
): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== "mendpoint.fixture-manifest.v1") {
    errors.push("schemaVersion must be mendpoint.fixture-manifest.v1");
  }
  if (manifest.manifestId !== learningCase.fixture.manifestId) {
    errors.push("manifestId must match the learning case");
  }
  if (manifest.caseId !== learningCase.id) errors.push("caseId must match the learning case");
  if (manifest.repository.provenanceId !== learningCase.repository.provenanceId) {
    errors.push("repository provenanceId must match the learning case");
  }
  if (manifest.repository.provenanceId !== repository.id) {
    errors.push("repository provenanceId must match admitted repository provenance");
  }
  if (!GIT_SHA.test(manifest.repository.immutableCommit)) {
    errors.push("repository immutableCommit must be a 40 character lowercase git sha");
  }
  if (manifest.repository.immutableCommit !== repository.immutableCommit) {
    errors.push("repository immutableCommit must match admitted repository provenance");
  }
  for (const [path, value] of [
    ["repository.pristineSnapshotSha256", manifest.repository.pristineSnapshotSha256],
    ["mutation.patchSha256", manifest.mutation.patchSha256],
    ["rollback.reversePatchSha256", manifest.rollback.reversePatchSha256],
    ["cleanup.pristineTreeSha256", manifest.cleanup.pristineTreeSha256],
  ] as const) {
    if (!SHA256.test(value)) errors.push(`${path} must be a 64 character lowercase sha256`);
  }
  if (!SAFE_RELATIVE_PATH.test(manifest.mutation.patchPath)) {
    errors.push("mutation.patchPath must be a safe repository relative path");
  }
  if (manifest.mutation.id !== learningCase.fixture.mutationId) {
    errors.push("mutation id must match the learning case");
  }
  if (manifest.mutation.seededFailure !== learningCase.pattern.seededFailure) {
    errors.push("mutation seededFailure must match the learning case");
  }
  if (manifest.expectedImpactGraph.nodes.length === 0) {
    errors.push("expectedImpactGraph nodes must not be empty");
  }
  const expectedNodes = [...new Set(learningCase.pattern.expectedImpactGraph)].sort();
  const manifestNodes = [...new Set(manifest.expectedImpactGraph.nodes)].sort();
  if (JSON.stringify(manifestNodes) !== JSON.stringify(expectedNodes)) {
    errors.push("expectedImpactGraph nodes must match the learning case");
  }
  if (manifest.expectedImpactGraph.evidenceState !== learningCase.pattern.evidenceState) {
    errors.push("expectedImpactGraph evidenceState must match the learning case");
  }
  if (manifest.expectedImpactGraph.evidenceState === "unknown" && manifest.expectedImpactGraph.edges.length > 0) {
    errors.push("unknown expectedImpactGraph must not claim verified edges");
  }
  if (manifest.failingOracle.id !== learningCase.expected.oracleIds[0]) {
    errors.push("failingOracle id must match the learning case primary oracle");
  }
  if (manifest.failingOracle.argv.length === 0) errors.push("failingOracle argv must not be empty");
  if (!Number.isInteger(manifest.failingOracle.expectedExitCode)) {
    errors.push("failingOracle expectedExitCode must be an integer");
  }
  if (manifest.allowedEditPaths.length === 0) errors.push("allowedEditPaths must not be empty");
  for (const path of [...manifest.allowedEditPaths, ...manifest.cleanup.removePaths]) {
    if (!SAFE_RELATIVE_PATH.test(path)) errors.push(`unsafe repository relative path: ${path}`);
  }
  if (manifest.allowedEditPaths.some((path) => !learningCase.fixture.allowedEditPaths.includes(path))) {
    errors.push("allowedEditPaths must stay within the learning case boundary");
  }
  if (manifest.expectedFixOrMigration !== learningCase.expected.repairOrMigration) {
    errors.push("expectedFixOrMigration must match the sealed learning case expectation");
  }
  if (manifest.rollback.id !== learningCase.fixture.rollbackId) {
    errors.push("rollback id must match the learning case");
  }
  if (manifest.rollback.oracleId !== manifest.failingOracle.id) {
    errors.push("rollback oracleId must match the failing oracle");
  }
  if (manifest.cleanup.id !== learningCase.fixture.cleanupId) {
    errors.push("cleanup id must match the learning case");
  }
  if (manifest.cleanup.pristineTreeSha256 !== manifest.repository.pristineSnapshotSha256) {
    errors.push("cleanup pristineTreeSha256 must restore the pristine snapshot");
  }
  return errors;
}

export interface FixtureAdmission {
  admitted: boolean;
  errors: string[];
}

export function admitFixture(
  manifest: FixtureManifest,
  learningCase: LearningCase,
  repository: RepositoryProvenance,
): FixtureAdmission {
  const errors = validateFixtureManifest(manifest, learningCase, repository);
  return { admitted: errors.length === 0, errors };
}
