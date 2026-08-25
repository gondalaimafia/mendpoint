import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  getRecursiveTree(revision: string): Promise<{ truncated: boolean; tree: GitTreeEntry[] }>;
  getBlob(sha: string): Promise<Buffer>;
  revisionExists(revision: string): Promise<boolean>;
  revisionIsAncestor(revision: string, descendant: string): Promise<boolean>;
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

function normalizedPath(locator: string): string | null {
  const path = locator.split("#", 1)[0];
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
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
  for (const path of Object.keys(policy.protectedFiles ?? {})) paths.add(path);
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

function stableAuthorityRotationMatrixView(matrix: ProductionClosureMatrix): unknown {
  const copy = JSON.parse(JSON.stringify(matrix)) as ProductionClosureMatrix;
  const releaseTrain = copy.releaseTrain as unknown as Record<string, unknown>;
  delete releaseTrain.observedMainRevision;
  delete releaseTrain.observationDigest;
  delete releaseTrain.currentPullRequestBootstrap;
  delete releaseTrain.pullRequests;
  return copy;
}

function successorWorkflowSafetyIssues(
  path: string,
  contents: Buffer | undefined,
  successor: AuthoritySuccessorTuple,
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
        "a staged successor must be a pinned default-branch controller with least authority and unique declared checks",
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

    const bootstrapRotation = matrix.releaseTrain?.currentPullRequestBootstrap?.authorityRotation;
    const policyChanged = !proposedPolicyBytes.equals(basePolicyBytes);
    const ledgerChanged = !proposedLedgerBytes.equals(baseLedgerBytes);
    const rotationRequested = policyChanged || ledgerChanged || bootstrapRotation !== undefined;
    if (!rotationRequested) {
      for (const [path, expectedDigest] of Object.entries(policy.protectedFiles)) {
        const bytes = bytesByPath.get(normalizedPath(path) ?? "");
        if (!bytes || digest(bytes) !== expectedDigest) {
          add(
            issues,
            "PROPOSAL_AUTHORITY_SURFACE_DRIFT",
            path,
            "a product proposal cannot modify or remove a pinned authority surface",
          );
        }
      }
    } else {
      const baseTree = await client.getRecursiveTree(baseRevision);
      if (baseTree.truncated) {
        add(issues, "PROPOSAL_BASE_TREE_TRUNCATED", baseRevision, "GitHub did not return the complete base authority tree");
        return observation;
      }
      const baseEntries = new Map(baseTree.tree.map((entry) => [entry.path, entry] as const));
      const baseBytesByPath = new Map<string, Buffer>();
      const readBasePath = async (path: string): Promise<Buffer | null> => {
        const cached = baseBytesByPath.get(path);
        if (cached) return cached;
        const entry = baseEntries.get(path);
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
        baseBytesByPath.set(path, bytes);
        return bytes;
      };
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
      for (const [path, bytes] of bytesByPath) proposedFileDigests.set(path, digest(bytes));
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
            receipt.successor,
          ),
        );
      }
      try {
        const baseMatrixBytes = await readBasePath("docs/PRODUCTION_CLOSURE_MATRIX.json");
        if (
          !baseMatrixBytes ||
          JSON.stringify(stableAuthorityRotationMatrixView(JSON.parse(baseMatrixBytes.toString("utf8")))) !==
            JSON.stringify(stableAuthorityRotationMatrixView(matrix))
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

  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, allowMissing = false): Promise<T | null> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "mendpoint-production-closure-proposal-authority",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async getRepositoryId(): Promise<number> {
    const result = await this.request<{ id?: unknown }>(`/repos/${this.repository}`);
    if (!result || !Number.isInteger(result.id)) throw new Error("repository identity is invalid");
    return result.id as number;
  }
  async getRecursiveTree(revision: string): Promise<{ truncated: boolean; tree: GitTreeEntry[] }> {
    const result = await this.request<{ truncated?: unknown; tree?: unknown }>(
      `/repos/${this.repository}/git/trees/${revision}?recursive=1`,
    );
    if (!result || typeof result.truncated !== "boolean" || !Array.isArray(result.tree)) {
      throw new Error("proposal tree response is invalid");
    }
    return { truncated: result.truncated, tree: result.tree as GitTreeEntry[] };
  }
  async getBlob(sha: string): Promise<Buffer> {
    const result = await this.request<{ encoding?: unknown; content?: unknown; size?: unknown }>(
      `/repos/${this.repository}/git/blobs/${sha}`,
    );
    if (!result || result.encoding !== "base64" || typeof result.content !== "string") {
      throw new Error("proposal blob response is invalid");
    }
    const bytes = Buffer.from(result.content.replace(/\s+/g, ""), "base64");
    if (typeof result.size === "number" && result.size !== bytes.length) {
      throw new Error("proposal blob size is invalid");
    }
    return bytes;
  }
  async revisionExists(revision: string): Promise<boolean> {
    return (await this.request(`/repos/${this.repository}/git/commits/${revision}`, true)) !== null;
  }
  async revisionIsAncestor(revision: string, descendant: string): Promise<boolean> {
    const result = await this.request<{ status?: unknown }>(
      `/repos/${this.repository}/compare/${revision}...${descendant}`,
    );
    return result?.status === "ahead" || result?.status === "identical";
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
