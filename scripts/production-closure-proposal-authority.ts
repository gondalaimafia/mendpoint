import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultGitHubSleep,
  fetchGitHubReadWithRetry,
  type GitHubSleep,
} from "./production-closure-github-authority.js";
import { parse } from "yaml";
import {
  verifyAuthorityRotation,
  type AuthorityRotationFileChange,
  type AuthorityRotationLedger,
  type AuthoritySuccessorTuple,
  type ClosureAuthorityPolicy,
} from "./production-closure-authority-rotation.js";
import {
  canonicalTextSha256,
  validateProductRequirements,
  type ProductRequirement,
  type ProductRequirementManifest,
} from "../packages/contract/src/product-requirements.js";
import {
  validatePublicClaimRegistry,
  type PublicClaimRegistry,
} from "../packages/contract/src/public-claims.js";
import {
  parseProductionEvidenceTrustRoots,
  releaseTrainObservationIssues,
  validateProductionClosureMatrix,
  type ProductionClosureMatrix,
  type ProductionClosureMatrixIssue,
  type ProductionEvidenceTrustRoot,
} from "./production-closure-matrix.js";
import { revisionReachabilityIssues } from "./public-claims-check.js";

const SHA = /^[a-f0-9]{40}$/;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_TREE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_TREE_ENTRIES = 200_000;

interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface ProposalBlobObservation {
  path: string;
  gitBlobSha: string;
  sha256: string;
  size: number;
}

export interface ProposalAuthorityObservation {
  schemaVersion: 1;
  repository: string;
  repositoryId: number;
  proposalRevision: string;
  observedAt: string;
  fetchedBlobs: ProposalBlobObservation[];
  providerValidationPullRequests: number[];
  providerValidationIssues: number[];
  authorityRotation: {
    rotationId: string;
    kind: "runtime" | "stage_successor" | "activate_successor";
    issuedAt: string;
    expiresAt: string;
    basePolicySha256: string;
    proposedPolicySha256: string;
    successor: AuthoritySuccessorTuple | null;
  } | null;
  verdict: "pass" | "fail";
  issues: ProductionClosureMatrixIssue[];
}

export function writeProposalAuthorityFailureObservation(
  path: string,
  observedAt = new Date().toISOString(),
): void {
  const observation: ProposalAuthorityObservation = {
    schemaVersion: 1,
    repository: "unavailable",
    repositoryId: 0,
    proposalRevision: "unavailable",
    observedAt,
    fetchedBlobs: [],
    providerValidationPullRequests: [],
    providerValidationIssues: [],
    authorityRotation: null,
    verdict: "fail",
    issues: [{
      code: "PROPOSAL_AUTHORITY_CONFIGURATION_INVALID",
      subject: "configuration",
      message: "protected proposal authority configuration or execution failed closed",
    }],
  };
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`, { mode: 0o600 });
}

export interface ProposalAuthorityClient {
  getRepositoryId(): Promise<number>;
  proposalHeadIsSameRepository(revision: string): Promise<boolean>;
  getRecursiveTree(revision: string): Promise<{ truncated: boolean; tree: GitTreeEntry[] }>;
  getBlob(sha: string): Promise<Buffer>;
  revisionExists(revision: string): Promise<boolean>;
  revisionIsAncestor(revision: string, descendant: string): Promise<boolean>;
  /**
   * Common ancestor of base and head, or null when it cannot be determined.
   *
   * Authority drift must be judged against what the PROPOSAL changed, not
   * against how far the base has moved since it branched. Comparing head to the
   * base tip marks every unrebased pull request as having modified the policy
   * the moment any policy edit lands on the base — demanding a rotation receipt
   * from proposals that touched nothing. Null is never "unchanged": callers
   * fail closed.
   */
  getMergeBase(base: string, head: string): Promise<string | null>;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function gitBlobDigest(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

// The root package.json is a high-churn product manifest: product proposals add
// and remove npm scripts and dependencies constantly. Pinning its whole-file
// sha256 froze the entire file, so any script or dependency edit tripped
// PROPOSAL_AUTHORITY_SURFACE_DRIFT. What actually needs protecting is the
// authority wiring: the exact commands of the scripts that CI and the closure
// controller invoke to enforce a gate. A hostile proposal that rewrote, for
// example, "closure:proposal:check" to "true" would neuter the gate while
// leaving the rest of the manifest untouched. AUTHORITY_CRITICAL_SCRIPTS is that
// enforcement surface, enumerated from .github/workflows/ci.yml and
// .github/workflows/closure-authority.yml plus the fan-out of the "ga:check"
// aggregate in this package.json (each constituent is listed so the aggregate
// cannot be hollowed out one script at a time). package.json is validated by an
// exact digest over this slice; every other script and dependency may change
// freely. To change a pinned command, rotate this pin like any other protected
// surface.
const AUTHORITY_MANIFEST_PATH = "package.json";
const AUTHORITY_CRITICAL_SCRIPTS = [
  "test",
  "typecheck",
  "ga:check",
  "spec:check",
  "closure:check",
  "closure:github:check",
  "closure:proposal:check",
  "claims:check",
  "actions:check",
  "architecture:check",
  "model:check",
  "names:check",
  "adr:check",
  "third-state:check",
  "evidence:reachability:check",
  "reverts:check",
  "eval:agents",
  "eval:synthetic:check",
] as const;

// Deterministic digest over the authority-critical script slice of the root
// manifest. Every pinned script name maps to its exact command string, or to
// null when the script is absent or not a string, so removing or renaming a
// pinned script changes the digest and fails closed. A manifest that does not
// parse as an object also fails closed, because its slice can never equal a
// pinned value.
function authorityScriptSliceDigest(bytes: Buffer): string {
  let scripts: Record<string, unknown> = {};
  try {
    const manifest = JSON.parse(bytes.toString("utf8")) as { scripts?: unknown };
    if (manifest && typeof manifest === "object" && manifest.scripts && typeof manifest.scripts === "object") {
      scripts = manifest.scripts as Record<string, unknown>;
    } else {
      return "sha256:invalid-package-manifest";
    }
  } catch {
    return "sha256:invalid-package-manifest";
  }
  const slice = [...AUTHORITY_CRITICAL_SCRIPTS]
    .sort()
    .map((name) => [name, typeof scripts[name] === "string" ? (scripts[name] as string) : null] as const);
  return digest(Buffer.from(JSON.stringify(slice)));
}

// The pinned digest for an authority surface. package.json is pinned to its
// authority-critical script slice; every other protected file is pinned to its
// exact whole-file bytes.
function protectedSurfaceDigest(path: string, bytes: Buffer): string {
  return path === AUTHORITY_MANIFEST_PATH ? authorityScriptSliceDigest(bytes) : digest(bytes);
}

function validGitTreePath(path: string): boolean {
  return Boolean(
    path &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === "" || part === "." || part === ".."),
  );
}

function normalizedPath(locator: string): string | null {
  const path = locator.split("#", 1)[0];
  if (
    !validGitTreePath(path) ||
    path.includes("\\")
  ) {
    return null;
  }
  return path;
}

function add(
  issues: ProductionClosureMatrixIssue[],
  code: string,
  subject: string,
  message: string,
): void {
  issues.push({ code, subject, message });
}

function allRequirements(manifest: ProductRequirementManifest): ProductRequirement[] {
  return [
    ...(Array.isArray(manifest.requirements) ? manifest.requirements : []),
    ...(Array.isArray(manifest.additionalRegisterSets)
      ? manifest.additionalRegisterSets.flatMap((set) =>
          Array.isArray(set.requirements) ? set.requirements : [],
        )
      : []),
  ];
}

function referencedPaths(
  manifest: ProductRequirementManifest,
  matrix: ProductionClosureMatrix,
  claims: PublicClaimRegistry,
  policy: ClosureAuthorityPolicy,
  proposedPolicy: ClosureAuthorityPolicy,
): Set<string> {
  const paths = new Set([
    "docs/PRODUCT_REQUIREMENTS.json",
    "docs/PRODUCTION_CLOSURE_MATRIX.json",
    "docs/PUBLIC_CLAIMS.json",
    "config/production-closure-authority.json",
  ]);
  if (typeof manifest.spec?.path === "string") paths.add(manifest.spec.path);
  for (const requirement of allRequirements(manifest)) {
    for (const criterion of requirement.acceptance ?? []) {
      for (const evidence of criterion.evidence ?? []) {
        if (!["planned", "external", "live"].includes(evidence.type)) {
          paths.add(evidence.locator);
        }
      }
    }
  }
  for (const row of matrix.requirements ?? []) {
    for (const binding of row.productionEvidenceBindings ?? []) {
      const receipt = binding.receipt;
      for (const artifact of [
        receipt.observationEvidence,
        receipt.versionEvidence,
        receipt.rollbackEvidence,
        receipt.failureEvidence,
      ]) paths.add(artifact.locator);
    }
  }
  for (const claim of claims.claims ?? []) {
    for (const path of claim.surfacePaths ?? []) paths.add(path);
    for (const evidence of claim.evidence ?? []) {
      if (!["live", "external"].includes(evidence.type)) paths.add(evidence.locator);
    }
  }
  for (const path of Object.keys(proposedPolicy.protectedFiles ?? {})) paths.add(path);
  paths.add(policy.authorityRotationManifestPath);
  for (const path of policy.authorityRotationAuxiliaryFiles ?? []) paths.add(path);
  return paths;
}

function referencedRevisions(
  matrix: ProductionClosureMatrix,
  claims: PublicClaimRegistry,
): Set<string> {
  const revisions = new Set<string>();
  const addRevision = (value: unknown) => {
    if (typeof value === "string" && SHA.test(value)) revisions.add(value);
  };
  addRevision(matrix.releaseTrain?.observedMainRevision);
  for (const pullRequest of matrix.releaseTrain?.pullRequests ?? []) {
    addRevision(pullRequest.headRevision);
    addRevision(pullRequest.mergeRevision);
  }
  for (const row of matrix.requirements ?? []) {
    for (const binding of row.productionEvidenceBindings ?? []) {
      addRevision(binding.receipt.deployedRevision);
    }
  }
  addRevision(claims.auditedRevision);
  for (const claim of claims.claims ?? []) {
    for (const evidence of claim.evidence ?? []) {
      if (evidence.type === "live") addRevision(evidence.revision);
    }
  }
  return revisions;
}

function stableAuthorityRotationMatrixView(
  matrix: ProductionClosureMatrix,
  currentPullRequestNumber: number,
): unknown {
  const copy = JSON.parse(JSON.stringify(matrix)) as ProductionClosureMatrix;
  for (const row of copy.requirements ?? []) {
    row.pullRequests = (row.pullRequests ?? []).filter(
      (pullRequest) => pullRequest !== currentPullRequestNumber,
    );
  }
  const releaseTrain = copy.releaseTrain as unknown as Record<string, unknown>;
  delete releaseTrain.observedAt;
  delete releaseTrain.observedMainRevision;
  delete releaseTrain.observationDigest;
  delete releaseTrain.currentPullRequestBootstrap;
  delete releaseTrain.pullRequests;
  return copy;
}

function successorWorkflowSafetyIssues(
  path: string,
  contents: Buffer | undefined,
  templateContents: Buffer | undefined,
  successor: AuthoritySuccessorTuple,
  basePolicy: ClosureAuthorityPolicy,
): ProductionClosureMatrixIssue[] {
  const issues: ProductionClosureMatrixIssue[] = [];
  try {
    const source = contents?.toString("utf8") ?? "";
    const workflow = parse(source) as Record<string, unknown>;
    const triggers = workflow.on as Record<string, unknown> | undefined;
    const permissions = workflow.permissions as Record<string, unknown> | undefined;
    const jobs = workflow.jobs as Record<string, { environment?: unknown; steps?: unknown[] }> | undefined;
    const uses = [...source.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
    const checkoutRefs = [...source.matchAll(/uses:\s*actions\/checkout@[a-f0-9]{40}[\s\S]{0,400}?\n\s*ref:\s*([^\r\n]+)/g)]
      .map((match) => match[1].trim());
    if (
      !contents ||
      !templateContents ||
      !contents.equals(templateContents) ||
      basePolicy.protectedFiles[successor.templatePath] !== successor.workflowSha256 ||
      digest(contents) !== successor.workflowSha256 ||
      digest(templateContents) !== successor.workflowSha256 ||
      !triggers?.pull_request_target ||
      triggers.pull_request !== undefined ||
      permissions?.statuses !== "write" ||
      permissions?.checks !== "read" ||
      !jobs ||
      !Object.values(jobs).some((job) => job.environment === "production-closure-authority") ||
      uses.length === 0 ||
      uses.some((use) => !/@[a-f0-9]{40}$/.test(use)) ||
      checkoutRefs.length === 0 ||
      checkoutRefs.some((ref) => ref !== "${{ needs.discover.outputs.main_sha }}") ||
      source.includes("github.event.pull_request.head") ||
      !source.includes(successor.externalCheckName) ||
      !source.includes(successor.controllerCheckName)
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_WORKFLOW_UNSAFE",
        path,
        "a staged successor must be an exact workflow digest pre-authorized on the base revision, with a pinned default-branch controller, least authority, and unique declared checks",
      );
    }
  } catch {
    add(issues, "AUTHORITY_SUCCESSOR_WORKFLOW_UNSAFE", path, "staged successor workflow YAML is invalid");
  }
  return issues;
}

export async function verifyProductionClosureProposal(
  policy: ClosureAuthorityPolicy,
  repository: string,
  proposalRevision: string,
  client: ProposalAuthorityClient,
  observedAt = new Date().toISOString(),
  baseAuthority: {
    revision?: string;
    policyBytes?: Buffer;
    rotationLedgerBytes?: Buffer;
  } = {},
): Promise<ProposalAuthorityObservation> {
  const issues: ProductionClosureMatrixIssue[] = [];
  const observation: ProposalAuthorityObservation = {
    schemaVersion: 1,
    repository,
    repositoryId: policy.repositoryId,
    proposalRevision,
    observedAt,
    fetchedBlobs: [],
    providerValidationPullRequests: [],
    providerValidationIssues: [],
    authorityRotation: null,
    verdict: "fail",
    issues,
  };
  try {
    if (
      policy.schemaVersion !== 1 ||
      repository !== policy.repository ||
      (await client.getRepositoryId()) !== policy.repositoryId ||
      !policy.protectedFiles ||
      Object.keys(policy.protectedFiles).length === 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(policy.legacyBootstrapMatrixDigest) ||
      !SHA.test(proposalRevision)
    ) {
      add(issues, "PROPOSAL_AUTHORITY_IDENTITY_INVALID", "policy", "repository policy and proposal identity must match");
      return observation;
    }
    if (!(await client.proposalHeadIsSameRepository(proposalRevision))) {
      add(
        issues,
        "PROPOSAL_HEAD_NOT_SAME_REPOSITORY",
        proposalRevision,
        "proposal head must be reachable from an exact fetched branch in the protected repository",
      );
      return observation;
    }
    const tree = await client.getRecursiveTree(proposalRevision);
    if (tree.truncated) {
      add(issues, "PROPOSAL_TREE_TRUNCATED", proposalRevision, "GitHub did not return the complete proposal tree");
      return observation;
    }
    const entries = new Map(tree.tree.map((entry) => [entry.path, entry] as const));
    const bytesByPath = new Map<string, Buffer>();
    let totalBytes = 0;
    const readProposalPath = async (locator: string): Promise<Buffer | null> => {
      const path = normalizedPath(locator);
      if (!path) {
        add(issues, "PROPOSAL_PATH_INVALID", locator, "proposal paths must be normalized repository relative paths");
        return null;
      }
      const cached = bytesByPath.get(path);
      if (cached) return cached;
      const entry = entries.get(path);
      if (
        !entry ||
        entry.type !== "blob" ||
        !["100644", "100755"].includes(entry.mode) ||
        !SHA.test(entry.sha) ||
        (entry.size ?? 0) > MAX_BLOB_BYTES
      ) {
        add(issues, "PROPOSAL_BLOB_INVALID", path, "referenced proposal content must be a bounded regular Git blob");
        return null;
      }
      const bytes = await client.getBlob(entry.sha);
      totalBytes += bytes.length;
      if (bytes.length > MAX_BLOB_BYTES || totalBytes > MAX_TOTAL_BYTES) {
        add(issues, "PROPOSAL_BLOB_BUDGET_EXCEEDED", path, "proposal validation exceeded its bounded content budget");
        return null;
      }
      if (gitBlobDigest(bytes) !== entry.sha) {
        add(issues, "PROPOSAL_BLOB_DIGEST_MISMATCH", path, "proposal bytes do not match the exact Git blob identity");
        return null;
      }
      bytesByPath.set(path, bytes);
      observation.fetchedBlobs.push({
        path,
        gitBlobSha: entry.sha,
        sha256: digest(bytes),
        size: bytes.length,
      });
      return bytes;
    };
    const readJson = async <T>(path: string): Promise<T | null> => {
      const bytes = await readProposalPath(path);
      if (!bytes) return null;
      try {
        return JSON.parse(bytes.toString("utf8")) as T;
      } catch {
        add(issues, "PROPOSAL_JSON_INVALID", path, "proposal authority input is not valid JSON");
        return null;
      }
    };
    const manifest = await readJson<ProductRequirementManifest>("docs/PRODUCT_REQUIREMENTS.json");
    const matrix = await readJson<ProductionClosureMatrix>("docs/PRODUCTION_CLOSURE_MATRIX.json");
    const claims = await readJson<PublicClaimRegistry>("docs/PUBLIC_CLAIMS.json");
    const proposedPolicy = await readJson<ClosureAuthorityPolicy>("config/production-closure-authority.json");
    const proposedLedger = await readJson<AuthorityRotationLedger>(policy.authorityRotationManifestPath);
    if (!manifest || !matrix || !claims || !proposedPolicy || !proposedLedger) return observation;

    const baseRevision = baseAuthority.revision;
    const basePolicyBytes = baseAuthority.policyBytes;
    const baseLedgerBytes = baseAuthority.rotationLedgerBytes;
    const proposedPolicyBytes = bytesByPath.get("config/production-closure-authority.json");
    const proposedLedgerBytes = bytesByPath.get(policy.authorityRotationManifestPath);
    if (
      !baseRevision ||
      !SHA.test(baseRevision) ||
      !basePolicyBytes ||
      !baseLedgerBytes ||
      !proposedPolicyBytes ||
      !proposedLedgerBytes
    ) {
      add(
        issues,
        "PROPOSAL_BASE_AUTHORITY_INVALID",
        "configuration",
        "proposal validation requires the exact checked-out base revision, policy, and rotation ledger bytes",
      );
      return observation;
    }
    let baseLedger: AuthorityRotationLedger;
    try {
      const parsedBasePolicy = JSON.parse(basePolicyBytes.toString("utf8")) as ClosureAuthorityPolicy;
      baseLedger = JSON.parse(baseLedgerBytes.toString("utf8")) as AuthorityRotationLedger;
      if (JSON.stringify(parsedBasePolicy) !== JSON.stringify(policy)) throw new Error("base policy mismatch");
    } catch {
      add(
        issues,
        "PROPOSAL_BASE_AUTHORITY_INVALID",
        "configuration",
        "checked-out base authority bytes are not the configured authority",
      );
      return observation;
    }

    for (const path of referencedPaths(manifest, matrix, claims, policy, proposedPolicy)) {
      await readProposalPath(path);
    }
    for (const [path, entry] of entries) {
      if (
        !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
        path === policy.workflowPath ||
        // The workflow that IS the proposed active controller cannot be a
        // "second workflow spoofing the controller surface": it is the surface.
        // proposedPolicy.workflowPath only differs from policy.workflowPath in an
        // activate_successor rotation, and that new active path is exactly the
        // just-activated successor whose digest was pre-authorized by a staged
        // rotation, proven live, and attested through verifyAuthorityRotation.
        // Without this exemption the activate PR fails the very gate it executes,
        // because at activation proposedPolicy.successor is cleared to null while
        // the successor workflow remains present as the new active controller.
        // This exemption is not reachable by an ordinary proposal (workflowPath is
        // immutable outside an activate_successor rotation).
        path === proposedPolicy.workflowPath ||
        path === proposedPolicy.successor?.workflowPath
      ) {
        continue;
      }
      if (entry.type !== "blob") continue;
      const contents = (await readProposalPath(path))?.toString("utf8");
      if (
        contents &&
        (/\bstatuses\s*:\s*write\b/.test(contents) ||
          /\bchecks\s*:\s*write\b/.test(contents) ||
          contents.includes(policy.controllerCheckName) ||
          /environment\s*:\s*production-closure-authority\b/.test(contents))
      ) {
        add(
          issues,
          "PROPOSAL_CONTROLLER_SURFACE_COLLISION",
          path,
          "only the exact pinned controller workflow may write or host production closure authority",
        );
      }
    }

    // Authority drift is a property of THIS proposal, not of how far the base
    // has moved since the proposal branched. Anchoring these comparisons to the
    // base tip makes every unrebased pull request look like it edited the
    // policy the moment any policy edit lands on the base, and the gate then
    // demands a rotation receipt from proposals that changed nothing. Anchor to
    // the merge base instead: bytes a proposal never touched are not its drift.
    const revisionReaders = new Map<
      string,
      { entries: Map<string, GitTreeEntry>; read: (path: string) => Promise<Buffer | null> }
    >();
    const readerFor = async (
      revision: string,
    ): Promise<{ entries: Map<string, GitTreeEntry>; read: (path: string) => Promise<Buffer | null> } | null> => {
      const cachedReader = revisionReaders.get(revision);
      if (cachedReader) return cachedReader;
      const revisionTree = await client.getRecursiveTree(revision);
      if (revisionTree.truncated) {
        add(issues, "PROPOSAL_BASE_TREE_TRUNCATED", revision, "GitHub did not return the complete base authority tree");
        return null;
      }
      const revisionEntries = new Map(revisionTree.tree.map((entry) => [entry.path, entry] as const));
      const revisionBytes = new Map<string, Buffer>();
      const read = async (path: string): Promise<Buffer | null> => {
        const cached = revisionBytes.get(path);
        if (cached) return cached;
        const entry = revisionEntries.get(path);
        if (
          !entry ||
          entry.type !== "blob" ||
          !["100644", "100755"].includes(entry.mode) ||
          !SHA.test(entry.sha) ||
          (entry.size ?? 0) > MAX_BLOB_BYTES
        ) {
          add(issues, "PROPOSAL_BASE_BLOB_INVALID", path, "base authority content must be a bounded regular Git blob");
          return null;
        }
        const bytes = await client.getBlob(entry.sha);
        totalBytes += bytes.length;
        if (
          bytes.length > MAX_BLOB_BYTES ||
          totalBytes > MAX_TOTAL_BYTES ||
          gitBlobDigest(bytes) !== entry.sha
        ) {
          add(issues, "PROPOSAL_BASE_BLOB_INVALID", path, "base authority bytes must be bounded and match the exact Git blob");
          return null;
        }
        revisionBytes.set(path, bytes);
        return bytes;
      };
      const reader = { entries: revisionEntries, read };
      revisionReaders.set(revision, reader);
      return reader;
    };

    const mergeBase = await client.getMergeBase(baseRevision, proposalRevision);
    if (!mergeBase) {
      add(
        issues,
        "PROPOSAL_AUTHORITY_MERGE_BASE_UNRESOLVED",
        proposalRevision,
        "authority drift cannot be judged without the proposal's merge base with the base revision",
      );
      return observation;
    }
    const mergeBaseReader = await readerFor(mergeBase);
    if (!mergeBaseReader) return observation;
    const mergeBaseMatrixBytes = await mergeBaseReader.read(
      "docs/PRODUCTION_CLOSURE_MATRIX.json",
    );
    if (!mergeBaseMatrixBytes) return observation;
    let mergeBaseMatrix: ProductionClosureMatrix;
    try {
      mergeBaseMatrix = JSON.parse(
        mergeBaseMatrixBytes.toString("utf8"),
      ) as ProductionClosureMatrix;
    } catch {
      add(
        issues,
        "PROPOSAL_BASE_MATRIX_INVALID",
        mergeBase,
        "merge-base closure matrix must be valid JSON",
      );
      return observation;
    }
    const changedProviderRecords = <T extends { number: number }>(
      baseRecords: readonly T[],
      proposedRecords: readonly T[],
      kind: "pull request" | "issue",
      exemptRemovedNumber?: number,
    ): number[] => {
      const baseByNumber = new Map(baseRecords.map((record) => [record.number, record]));
      const proposedByNumber = new Map(proposedRecords.map((record) => [record.number, record]));
      for (const number of baseByNumber.keys()) {
        if (!proposedByNumber.has(number)) {
          // Promotion is not removal. A base-tracked pull request that the proposal
          // moves into currentPullRequestBootstrap is not dropped from provider
          // verification: the bootstrap slot subjects exactly that PR to the strictest
          // live provider proof (bootstrap.number must equal the judged PR, its
          // metadata is compared live, and an exact-head trusted review is required),
          // so its tracking is upgraded, not lost. A proposal can only ever exempt
          // ITSELF this way, and exactly one number; any OTHER removed record — a
          // second tracked PR, or a PR removed without claiming the bootstrap slot —
          // still flags.
          if (exemptRemovedNumber !== undefined && number === exemptRemovedNumber) {
            continue;
          }
          add(
            issues,
            "PROPOSAL_PROVIDER_RECORD_REMOVAL_UNVERIFIED",
            String(number),
            `${kind} declarations cannot be removed without a provider-verified full observation`,
          );
        }
      }
      return proposedRecords
        .filter((record) =>
          JSON.stringify(baseByNumber.get(record.number)) !== JSON.stringify(record)
        )
        .map((record) => record.number)
        .sort((left, right) => left - right);
    };
    observation.providerValidationPullRequests = changedProviderRecords(
      mergeBaseMatrix.releaseTrain?.pullRequests ?? [],
      matrix.releaseTrain?.pullRequests ?? [],
      "pull request",
      matrix.releaseTrain?.currentPullRequestBootstrap?.number,
    );
    observation.providerValidationIssues = changedProviderRecords(
      mergeBaseMatrix.issueAuthority?.issues ?? [],
      matrix.issueAuthority?.issues ?? [],
      "issue",
    );
    // Identical Git blob sha and mode is identical content, so the proposal did
    // not touch this path; a path absent on both sides is untouched too. This
    // never reads "could not tell" as "unchanged": an unresolvable merge base
    // or an incomplete merge-base tree returned above, before any comparison.
    const proposalTouched = (path: string): boolean => {
      const from = mergeBaseReader.entries.get(path);
      const to = entries.get(path);
      return from?.sha !== to?.sha || from?.mode !== to?.mode;
    };

    const policyLocator = normalizedPath("config/production-closure-authority.json");
    const ledgerLocator = normalizedPath(policy.authorityRotationManifestPath);
    if (!policyLocator || !ledgerLocator) {
      add(
        issues,
        "PROPOSAL_PATH_INVALID",
        policy.authorityRotationManifestPath,
        "authority paths must be normalized repository relative paths",
      );
      return observation;
    }
    const bootstrapRotation = matrix.releaseTrain?.currentPullRequestBootstrap?.authorityRotation;
    const policyChanged = proposalTouched(policyLocator);
    const ledgerChanged = proposalTouched(ledgerLocator);
    const rotationRequested = policyChanged || ledgerChanged || bootstrapRotation !== undefined;
    if (!rotationRequested) {
      for (const [path, expectedDigest] of Object.entries(policy.protectedFiles)) {
        const locator = normalizedPath(path) ?? "";
        const bytes = bytesByPath.get(locator);
        // A surface this proposal never touched has not drifted, however far
        // the pin has moved on the base since the branch point. A surface it
        // did touch still has to match the pin exactly.
        if (!proposalTouched(locator)) continue;
        if (!bytes || protectedSurfaceDigest(path, bytes) !== expectedDigest) {
          add(
            issues,
            "PROPOSAL_AUTHORITY_SURFACE_DRIFT",
            path,
            "a product proposal cannot modify or remove a pinned authority surface",
          );
        }
      }
    } else {
      // The rotation receipt is pinned to the exact base revision, so a
      // rotating proposal is still judged against the base tip and must be up
      // to date with it. Only untouched surfaces get the merge-base reprieve.
      const baseReader = await readerFor(baseRevision);
      if (!baseReader) return observation;
      const baseEntries = baseReader.entries;
      const readBasePath = baseReader.read;
      const exactBasePolicyBytes = await readBasePath("config/production-closure-authority.json");
      const exactBaseLedgerBytes = await readBasePath(policy.authorityRotationManifestPath);
      if (
        !exactBasePolicyBytes?.equals(basePolicyBytes) ||
        !exactBaseLedgerBytes?.equals(baseLedgerBytes)
      ) {
        add(
          issues,
          "PROPOSAL_BASE_AUTHORITY_MISMATCH",
          baseRevision,
          "checked-out base policy and ledger must match the exact provider base revision",
        );
        return observation;
      }
      const changedFiles: AuthorityRotationFileChange[] = [];
      const allPaths = new Set([...baseEntries.keys(), ...entries.keys()]);
      for (const path of [...allPaths].sort()) {
        const from = baseEntries.get(path);
        const to = entries.get(path);
        if (from?.sha === to?.sha && from?.mode === to?.mode && from?.type === to?.type) continue;
        if (from?.type === "tree" && to?.type === "tree") continue;
        if ((!from && to?.type === "tree") || (!to && from?.type === "tree")) continue;
        if (path === policy.authorityRotationManifestPath) continue;
        if (
          (from && (from.type !== "blob" || !["100644", "100755"].includes(from.mode))) ||
          (to && (to.type !== "blob" || !["100644", "100755"].includes(to.mode)))
        ) {
          add(issues, "AUTHORITY_ROTATION_TREE_ENTRY_INVALID", path, "rotation changes must be regular Git blobs");
          continue;
        }
        let fromSha256: string | null = null;
        if (from) {
          const bytes = await readBasePath(path);
          if (!bytes) continue;
          fromSha256 = digest(bytes);
        }
        const proposedBytes = to ? await readProposalPath(path) : null;
        changedFiles.push({
          path,
          fromSha256,
          toSha256: proposedBytes ? digest(proposedBytes) : null,
          fromMode: from?.mode as "100644" | "100755" | undefined ?? null,
          toMode: to?.mode as "100644" | "100755" | undefined ?? null,
        });
      }
      const proposedFileDigests = new Map<string, string>();
      for (const [path, bytes] of bytesByPath) proposedFileDigests.set(path, protectedSurfaceDigest(path, bytes));
      const rotationIssues = verifyAuthorityRotation({
        basePolicy: policy,
        proposedPolicy,
        basePolicyBytes,
        proposedPolicyBytes,
        baseLedgerBytes,
        baseLedger,
        proposedLedger,
        baseRevision,
        observedAt,
        changedFiles,
        proposedFileDigests,
        proposedFileContents: bytesByPath,
        proposedPaths: new Set(entries.keys()),
      });
      issues.push(...rotationIssues);
      const receipt = proposedLedger.rotations?.at(-1) ?? null;
      if (receipt?.kind === "stage_successor" && receipt.successor) {
        issues.push(
          ...successorWorkflowSafetyIssues(
            receipt.successor.workflowPath,
            bytesByPath.get(receipt.successor.workflowPath),
            bytesByPath.get(receipt.successor.templatePath),
            receipt.successor,
            policy,
          ),
        );
      }
      try {
        const baseMatrixBytes = await readBasePath("docs/PRODUCTION_CLOSURE_MATRIX.json");
        const currentPullRequestNumber = matrix.releaseTrain.currentPullRequestBootstrap?.number ?? -1;
        if (
          !baseMatrixBytes ||
          JSON.stringify(stableAuthorityRotationMatrixView(
            JSON.parse(baseMatrixBytes.toString("utf8")),
            currentPullRequestNumber,
          )) !==
            JSON.stringify(stableAuthorityRotationMatrixView(matrix, currentPullRequestNumber))
        ) {
          add(
            issues,
            "AUTHORITY_ROTATION_MATRIX_SCOPE_INVALID",
            "docs/PRODUCTION_CLOSURE_MATRIX.json",
            "authority rotation may update only provider-verified release-train observation fields",
          );
        }
      } catch {
        add(
          issues,
          "AUTHORITY_ROTATION_MATRIX_SCOPE_INVALID",
          "docs/PRODUCTION_CLOSURE_MATRIX.json",
          "base and proposed closure matrices must remain structurally comparable",
        );
      }
      if (matrix.releaseTrain.observedAt !== receipt?.issuedAt) {
        add(
          issues,
          "AUTHORITY_ROTATION_OBSERVATION_TIME_MISMATCH",
          "releaseTrain.observedAt",
          "provider observation time must equal the exact authority rotation receipt issue time",
        );
      }
      if (
        !receipt ||
        !bootstrapRotation ||
        bootstrapRotation.rotationId !== receipt.rotationId ||
        bootstrapRotation.kind !== receipt.kind ||
        bootstrapRotation.issuedAt !== receipt.issuedAt ||
        bootstrapRotation.expiresAt !== receipt.expiresAt ||
        bootstrapRotation.basePolicySha256 !== receipt.basePolicySha256 ||
        bootstrapRotation.proposedPolicySha256 !== receipt.proposedPolicySha256 ||
        JSON.stringify(bootstrapRotation.successor ?? null) !== JSON.stringify(receipt.successor)
      ) {
        add(
          issues,
          "AUTHORITY_ROTATION_BOOTSTRAP_MISMATCH",
          String(matrix.releaseTrain?.currentPullRequestBootstrap?.number ?? "current pull request"),
          "the current pull request declaration must bind the exact authority rotation receipt",
        );
      } else if (rotationIssues.length === 0) {
        observation.authorityRotation = {
          rotationId: receipt.rotationId,
          kind: receipt.kind,
          issuedAt: receipt.issuedAt,
          expiresAt: receipt.expiresAt,
          basePolicySha256: receipt.basePolicySha256,
          proposedPolicySha256: receipt.proposedPolicySha256,
          successor: receipt.successor,
        };
      }
    }
    if (policyChanged && !ledgerChanged && bootstrapRotation === undefined) {
      add(
        issues,
        "PROPOSAL_AUTHORITY_POLICY_DRIFT",
        "config/production-closure-authority.json",
        "a product proposal cannot modify its own pinned trust policy",
      );
    }
    issues.push(...validateProductRequirements(manifest));
    const specBytes = typeof manifest.spec?.path === "string"
      ? bytesByPath.get(normalizedPath(manifest.spec.path) ?? "")
      : undefined;
    if (!specBytes) {
      add(issues, "SPEC_MISSING", String(manifest.spec?.path ?? "spec"), "canonical specification is absent from the exact proposal tree");
    } else if (canonicalTextSha256(specBytes.toString("utf8")) !== manifest.spec.sha256) {
      add(issues, "SPEC_HASH_MISMATCH", manifest.spec.path, "canonical specification digest does not match the proposed register");
    }

    const revisionResults = new Map<string, boolean>();
    for (const revision of referencedRevisions(matrix, claims)) {
      revisionResults.set(revision, await client.revisionExists(revision));
    }
    const ancestryResults = new Map<string, boolean>();
    for (const pullRequest of matrix.releaseTrain?.pullRequests ?? []) {
      if (pullRequest.checkState !== "current_checks_green") continue;
      for (const dependencyNumber of pullRequest.dependencies?.pullRequests ?? []) {
        const dependency = matrix.releaseTrain.pullRequests.find((candidate) => candidate.number === dependencyNumber);
        if (dependency?.state !== "merged" || !dependency.mergeRevision) continue;
        const key = `${dependency.mergeRevision}:${matrix.releaseTrain.observedMainRevision}`;
        ancestryResults.set(
          key,
          await client.revisionIsAncestor(dependency.mergeRevision, matrix.releaseTrain.observedMainRevision),
        );
      }
    }
    issues.push(
      ...releaseTrainObservationIssues(matrix, {
        revisionExists: (revision) => revisionResults.get(revision) === true,
        revisionIsAncestor: (revision, descendant) => ancestryResults.get(`${revision}:${descendant}`) === true,
        readArtifact: (locator) => bytesByPath.get(normalizedPath(locator) ?? "") ?? null,
        now: new Date(observedAt),
      }),
      ...validateProductionClosureMatrix(manifest, matrix, {
        trustedProductionEvidenceAuthorities:
          policy.productionEvidenceAuthorities as ProductionEvidenceTrustRoot[],
        requireCurrentPullRequestBootstrap: true,
      }),
    );

    const requirements = allRequirements(manifest);
    issues.push(...validatePublicClaimRegistry(claims, { requirements, asOf: new Date(observedAt) }));
    for (const claim of claims.claims ?? []) {
      if (!(claim.surfacePaths ?? []).some((path) =>
        bytesByPath.get(normalizedPath(path) ?? "")?.toString("utf8").includes(claim.id),
      )) {
        add(issues, "CLAIM_SURFACE_BINDING_MISSING", claim.id, "a proposed claim must be bound by ID on at least one proposed surface");
      }
    }
    issues.push(
      ...revisionReachabilityIssues(claims, (revision) => revisionResults.get(revision) === true),
    );
  } catch {
    add(issues, "PROPOSAL_AUTHORITY_UNAVAILABLE", "github", "proposal bytes or Git authority could not be read completely");
  }
  observation.fetchedBlobs.sort((left, right) => left.path.localeCompare(right.path));
  observation.issues.sort(
    (left, right) => left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject),
  );
  observation.verdict = observation.issues.length === 0 ? "pass" : "fail";
  return observation;
}

export class GitHubProposalAuthorityClient implements ProposalAuthorityClient {
  private readonly apiBase = "https://api.github.com";
  private repositoryIdPromise: Promise<number> | undefined;

  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: GitHubSleep = defaultGitHubSleep,
    private readonly checkoutRoot: string = process.cwd(),
  ) {}

  private async request<T>(path: string): Promise<T> {
    const response = await fetchGitHubReadWithRetry(`${this.apiBase}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "mendpoint-production-closure-proposal-authority",
        "x-github-api-version": "2022-11-28",
      },
    }, this.fetchImpl, this.sleepImpl);
    if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private async readRepositoryId(): Promise<number> {
    const result = await this.request<{ id?: unknown }>(`/repos/${this.repository}`);
    if (!Number.isInteger(result.id)) throw new Error("repository identity is invalid");
    return result.id as number;
  }

  async getRepositoryId(): Promise<number> {
    this.repositoryIdPromise ??= this.readRepositoryId();
    return this.repositoryIdPromise;
  }

  private exactSha(value: string): string {
    if (!SHA.test(value)) throw new Error("local authority reads require an exact Git object SHA");
    return value;
  }

  private gitEnvironment(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  }

  private gitOutput(args: string[], maxBuffer: number): Buffer {
    return execFileSync("git", args, {
      cwd: resolve(this.checkoutRoot),
      env: this.gitEnvironment(),
      maxBuffer,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  private gitStatus(args: string[]): number {
    try {
      execFileSync("git", args, {
        cwd: resolve(this.checkoutRoot),
        env: this.gitEnvironment(),
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      return 0;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number") return status;
      throw error;
    }
  }

  async proposalHeadIsSameRepository(revision: string): Promise<boolean> {
    const refs = this.gitOutput(
      [
        "for-each-ref",
        "--contains",
        this.exactSha(revision),
        "--format=%(refname)",
        "refs/remotes/origin/",
      ],
      1024 * 1024,
    ).toString("utf8").split(/\r?\n/).filter(Boolean);
    return refs.some((ref) => /^refs\/remotes\/origin\/[^/].*$/.test(ref));
  }

  async getRecursiveTree(revision: string): Promise<{ truncated: boolean; tree: GitTreeEntry[] }> {
    const output = this.gitOutput(
      ["ls-tree", "-r", "-t", "-z", "-l", "--full-tree", this.exactSha(revision)],
      MAX_TREE_OUTPUT_BYTES,
    );
    if (output.length > 0 && output.at(-1) !== 0) {
      throw new Error("local proposal tree is not NUL terminated");
    }
    const tree: GitTreeEntry[] = [];
    const paths = new Set<string>();
    let start = 0;
    while (start < output.length) {
      const end = output.indexOf(0, start);
      if (end < 0) throw new Error("local proposal tree record is incomplete");
      const record = output.subarray(start, end);
      start = end + 1;
      const separator = record.indexOf(0x09);
      if (separator <= 0 || separator === record.length - 1) {
        throw new Error("local proposal tree record is invalid");
      }
      const header = record.subarray(0, separator).toString("ascii");
      const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}) +([0-9]+|-)$/.exec(header);
      if (!match) throw new Error("local proposal tree header is invalid");
      const [, mode, type, sha, sizeText] = match;
      const pathBytes = record.subarray(separator + 1);
      const path = pathBytes.toString("utf8");
      if (!Buffer.from(path, "utf8").equals(pathBytes) || !validGitTreePath(path)) {
        throw new Error("local proposal tree path is invalid");
      }
      if (paths.has(path)) throw new Error("local proposal tree contains duplicate paths");
      paths.add(path);
      const validMode =
        (type === "blob" && ["100644", "100755", "120000"].includes(mode)) ||
        (type === "tree" && mode === "040000") ||
        (type === "commit" && mode === "160000");
      const size = sizeText === "-" ? undefined : Number(sizeText);
      if (
        !validMode ||
        (type === "blob" && (!Number.isSafeInteger(size) || (size ?? -1) < 0)) ||
        (type !== "blob" && size !== undefined)
      ) {
        throw new Error("local proposal tree entry is invalid");
      }
      tree.push({ path, mode, type, sha, ...(size === undefined ? {} : { size }) });
      if (tree.length > MAX_TREE_ENTRIES) throw new Error("local proposal tree entry budget exceeded");
    }
    return { truncated: false, tree };
  }

  async getBlob(sha: string): Promise<Buffer> {
    return this.gitOutput(["cat-file", "blob", this.exactSha(sha)], MAX_BLOB_BYTES + 1);
  }

  async revisionExists(revision: string): Promise<boolean> {
    const status = this.gitStatus(["cat-file", "-e", `${this.exactSha(revision)}^{commit}`]);
    if (status === 0) return true;
    if (status === 1 || status === 128) return false;
    throw new Error(`local Git revision check failed with status ${status}`);
  }

  async revisionIsAncestor(revision: string, descendant: string): Promise<boolean> {
    const status = this.gitStatus([
      "merge-base",
      "--is-ancestor",
      this.exactSha(revision),
      this.exactSha(descendant),
    ]);
    if (status === 0) return true;
    if (status === 1) return false;
    throw new Error(`local Git ancestry check failed with status ${status}`);
  }

  async getMergeBase(base: string, head: string): Promise<string | null> {
    try {
      const result = this.gitOutput(
        ["merge-base", this.exactSha(base), this.exactSha(head)],
        1024,
      ).toString("ascii").trim();
      if (!SHA.test(result)) throw new Error("local Git merge base is invalid");
      return result;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status === 1) return null;
      throw error;
    }
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const policyPath = process.env.MENDPOINT_CLOSURE_AUTHORITY_POLICY_PATH?.trim() ||
    resolve(process.cwd(), "config", "production-closure-authority.json");
  const policyBytes = readFileSync(policyPath);
  const policy = JSON.parse(policyBytes.toString("utf8")) as ClosureAuthorityPolicy;
  const rotationLedgerBytes = readFileSync(
    resolve(process.cwd(), policy.authorityRotationManifestPath),
  );
  const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const configuredBaseRevision = requiredEnvironment("MENDPOINT_AUTHORITY_BASE_SHA");
  if (baseRevision !== configuredBaseRevision) throw new Error("checked-out base authority revision is not exact");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const observation = await verifyProductionClosureProposal(
    policy,
    repository,
    requiredEnvironment("MENDPOINT_PROPOSAL_HEAD_SHA"),
    new GitHubProposalAuthorityClient(repository, requiredEnvironment("GITHUB_TOKEN")),
    new Date().toISOString(),
    {
      revision: baseRevision,
      policyBytes,
      rotationLedgerBytes,
    },
  );
  const outputPath = requiredEnvironment("MENDPOINT_PROPOSAL_OBSERVATION_PATH");
  writeFileSync(outputPath, `${JSON.stringify(observation, null, 2)}\n`, { mode: 0o600 });
  if (observation.verdict === "pass") {
    console.log(`PRODUCTION CLOSURE PROPOSAL AUTHORITY PASS: ${observation.fetchedBlobs.length} exact proposal blobs`);
    return;
  }
  for (const issue of observation.issues) console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    const outputPath = process.env.MENDPOINT_PROPOSAL_OBSERVATION_PATH?.trim();
    if (outputPath) {
      try {
        writeProposalAuthorityFailureObservation(outputPath);
      } catch {
        // The console verdict remains fail closed if the artifact path is also unavailable.
      }
    }
    console.error("PROPOSAL_AUTHORITY_UNAVAILABLE github: protected proposal authority failed closed");
    process.exitCode = 1;
  });
}
