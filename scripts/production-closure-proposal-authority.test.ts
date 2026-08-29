import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  releaseTrainIntegrityDigest,
  type ProductionClosureMatrix,
} from "./production-closure-matrix.js";
import {
  GitHubProposalAuthorityClient,
  verifyProductionClosureProposal,
  writeProposalAuthorityFailureObservation,
  type ProposalAuthorityClient,
} from "./production-closure-proposal-authority.js";

const root = resolve(import.meta.dirname, "..");
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const MERGE_BASE = "d".repeat(40);
const OBSERVED_AT = "2026-08-25T12:00:00.000Z";

function sha(value: Buffer): string {
  return createHash("sha1")
    .update(`blob ${value.length}\0`)
    .update(value)
    .digest("hex");
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function policy() {
  return JSON.parse(
    readFileSync(resolve(root, "config", "production-closure-authority.json"), "utf8"),
  );
}

function baseAuthority() {
  return {
    revision: BASE,
    policyBytes: readFileSync(resolve(root, "config", "production-closure-authority.json")),
    rotationLedgerBytes: readFileSync(
      resolve(root, "config", "production-closure-authority-rotation.json"),
    ),
  };
}

function createDivergedRepository(): {
  directory: string;
  baseRevision: string;
  headRevision: string;
  mainRevision: string;
  localOnlyRevision: string;
  headBlobSha: string;
  headBlobBytes: Buffer;
} {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-proposal-local-git-"));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "proposal-authority@example.invalid");
  git("config", "user.name", "Proposal Authority Test");
  writeFileSync(join(directory, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-m", "base");
  const baseRevision = git("rev-parse", "HEAD");

  git("switch", "-c", "feature");
  mkdirSync(join(directory, "nested"));
  const headBlobBytes = Buffer.from("exact proposal bytes\n");
  const proposalPath = join(directory, "nested", "proposal.txt");
  writeFileSync(proposalPath, headBlobBytes);
  chmodSync(proposalPath, 0o755);
  writeFileSync(join(directory, "literal#name.txt"), "literal Git path\n");
  git("add", "nested/proposal.txt");
  git("add", "literal#name.txt");
  git("update-index", "--chmod=+x", "nested/proposal.txt");
  git("commit", "-m", "proposal");
  const headRevision = git("rev-parse", "HEAD");
  const headBlobSha = git("rev-parse", "HEAD:nested/proposal.txt");

  git("switch", "main");
  writeFileSync(join(directory, "main.txt"), "main\n");
  git("add", "main.txt");
  git("commit", "-m", "main");
  const mainRevision = git("rev-parse", "HEAD");
  git("switch", "-c", "local-only", "feature");
  writeFileSync(join(directory, "local-only.txt"), "not published to origin\n");
  git("add", "local-only.txt");
  git("commit", "-m", "local only");
  const localOnlyRevision = git("rev-parse", "HEAD");
  git("switch", "main");
  git("update-ref", "refs/remotes/origin/main", mainRevision);
  git("update-ref", "refs/remotes/origin/feature", headRevision);
  return {
    directory,
    baseRevision,
    headRevision,
    mainRevision,
    localOnlyRevision,
    headBlobSha,
    headBlobBytes,
  };
}

class FixtureClient implements ProposalAuthorityClient {
  truncated = false;
  mergeBaseRevision: string = BASE;
  mergeBaseUnresolved = false;
  readonly pathToSha = new Map<string, string>();
  readonly basePathToSha = new Map<string, string>();
  readonly mergeBasePathToSha = new Map<string, string>();
  readonly blobs = new Map<string, Buffer>();
  readonly modes = new Map<string, string>();

  constructor() {
    const paths = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean));
    paths.add("config/production-closure-authority.json");
    paths.add("config/production-closure-authority-rotation.json");
    paths.add("scripts/production-closure-authority-rotation.ts");
    paths.add("scripts/production-closure-authority-rotation.test.ts");
    for (const path of Object.keys(policy().protectedFiles)) paths.add(path);
    for (const path of paths) {
      const bytes = readFileSync(resolve(root, path));
      const blobSha = sha(bytes);
      this.pathToSha.set(path.replace(/\\/g, "/"), blobSha);
      this.blobs.set(blobSha, bytes);
      this.modes.set(path.replace(/\\/g, "/"), "100644");
    }
    const matrix = JSON.parse(
      readFileSync(
        resolve(root, "scripts", "fixtures", "production-closure-matrix-v2.json"),
        "utf8",
      ),
    ) as ProductionClosureMatrix;
    this.replace("docs/PRODUCTION_CLOSURE_MATRIX.json", matrix);
    if (!matrix.releaseTrain.currentPullRequestBootstrap) {
      matrix.releaseTrain.currentPullRequestBootstrap = {
        observationSource: "github_api",
        number: 999,
        url: "https://github.com/gondalaimafia/mendpoint/pull/999",
        title: "Test production closure bootstrap",
        baseBranch: "main",
        headBranch: "codex/test-production-closure-bootstrap",
        owner: { actor: "Codex", source: "github_label", label: "release-owner:codex" },
        disposition: "merge_after_rebase_and_review",
        dependencies: { pullRequests: [], branches: [] },
        requirementIds: [],
        blockers: [],
        remediatesPullRequests: [],
      };
      matrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(matrix);
      this.replace("docs/PRODUCTION_CLOSURE_MATRIX.json", matrix);
    }
    for (const [path, blobSha] of this.pathToSha) this.basePathToSha.set(path, blobSha);
  }

  replace(path: string, value: unknown): void {
    const priorSha = this.pathToSha.get(path);
    if (!priorSha) throw new Error(`fixture path missing: ${path}`);
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    const blobSha = sha(bytes);
    this.blobs.set(blobSha, bytes);
    this.pathToSha.set(path, blobSha);
  }
  add(path: string, bytes: Buffer, includeInBase = true): void {
    const blobSha = sha(bytes);
    this.blobs.set(blobSha, bytes);
    this.pathToSha.set(path, blobSha);
    this.modes.set(path, "100644");
    if (includeInBase) this.basePathToSha.set(path, blobSha);
  }
  remove(path: string): void {
    this.pathToSha.delete(path);
    this.basePathToSha.delete(path);
    this.modes.delete(path);
  }
  async getRepositoryId(): Promise<number> {
    return 1309389373;
  }
  async proposalHeadIsSameRepository(): Promise<boolean> {
    return true;
  }
  /**
   * Move the base tip ahead of the branch point, leaving the proposal alone.
   *
   * This is the shape every unrebased pull request has: the base changed a
   * file after the branch point, the proposal still carries the older bytes it
   * never touched, and the merge base holds what both agreed on.
   */
  advanceBase(path: string, bytes: Buffer): void {
    if (this.mergeBaseRevision === BASE) {
      for (const [key, value] of this.basePathToSha) this.mergeBasePathToSha.set(key, value);
    }
    const blobSha = sha(bytes);
    this.blobs.set(blobSha, bytes);
    this.basePathToSha.set(path, blobSha);
    this.modes.set(path, "100644");
    this.mergeBaseRevision = MERGE_BASE;
  }
  async getMergeBase(): Promise<string | null> {
    return this.mergeBaseUnresolved ? null : this.mergeBaseRevision;
  }
  async getRecursiveTree(revision: string) {
    const source =
      revision === MERGE_BASE
        ? this.mergeBasePathToSha
        : revision === BASE
          ? this.basePathToSha
          : this.pathToSha;
    return {
      truncated: this.truncated,
      tree: [...source.entries()].map(([path, blobSha]) => ({
        path,
        mode: this.modes.get(path) ?? "100644",
        type: "blob" as const,
        sha: blobSha,
        size: this.blobs.get(blobSha)?.length ?? 0,
      })),
    };
  }
  async getBlob(blobSha: string): Promise<Buffer> {
    const value = this.blobs.get(blobSha);
    if (!value) throw new Error("blob missing");
    return value;
  }
  async revisionExists(): Promise<boolean> {
    return true;
  }
  async revisionIsAncestor(): Promise<boolean> {
    return true;
  }
}

describe("production closure proposal authority", () => {
  it("validates the exact proposed register, matrix, claims, evidence, and surfaces as blobs", async () => {
    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      new FixtureClient(),
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(result.issues).toEqual([]);
    expect(result.fetchedBlobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/PRODUCT_REQUIREMENTS.json" }),
        expect.objectContaining({ path: "docs/PRODUCTION_CLOSURE_MATRIX.json" }),
        expect.objectContaining({ path: "docs/PUBLIC_CLAIMS.json" }),
      ]),
    );
  });


  it("does not report an open pull request head the local object database cannot resolve, but still flags an unreachable merge revision", async () => {
    // #490 re-armed via #486's local-git oracle: closure:proposal:check resolves
    // revisions against the checked-out object database, which cannot see OTHER open
    // PRs' force-pushed heads. "Absent locally" must not read as "unreachable on
    // GitHub" for open-PR heads (openPullRequestHeadsVerifiable: false at the proposal
    // call site). Merge revisions are on main and stay locally checked (ungated).
    // Note (#530): open-PR heads/state are no longer re-verified live by github-
    // authority either; this remains a local reporting relaxation, not a delegation.
    const openHead = "63711d9aac1a2d9e89a50bd9b4a6b8f3b2ea3c3f"; // fixture open PR #284 head
    const mergeRevision = "b3279db5157a2a33c8684f1cf595356953ff2a96"; // fixture merged PR #333 merge revision
    class LocalObjectDatabaseClient extends FixtureClient {
      async revisionExists(revision?: string): Promise<boolean> {
        return revision !== openHead && revision !== mergeRevision;
      }
    }

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      new LocalObjectDatabaseClient(),
      OBSERVED_AT,
      baseAuthority(),
    );

    const codes = result.issues.map((issue) => issue.code);
    expect(codes, JSON.stringify(result.issues, null, 2)).not.toContain("PR_HEAD_REVISION_UNREACHABLE");
    expect(codes, JSON.stringify(result.issues, null, 2)).toContain("PR_MERGE_REVISION_UNREACHABLE");
  });

  it("fails closed when GitHub truncates the exact proposal tree", async () => {
    const client = new FixtureClient();
    client.truncated = true;

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_TREE_TRUNCATED");
  });

  it("rejects symlinked proposal evidence and surfaces", async () => {
    const client = new FixtureClient();
    client.modes.set("docs/PRODUCT_CONTRACT.md", "120000");

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_BLOB_INVALID");
  });

  it("detects a proposed requirement promotion that the matrix does not bind", async () => {
    const client = new FixtureClient();
    const manifest = JSON.parse(
      readFileSync(resolve(root, "docs", "PRODUCT_REQUIREMENTS.json"), "utf8"),
    );
    manifest.requirements[0].implementationStatus = "verified";
    client.replace("docs/PRODUCT_REQUIREMENTS.json", manifest);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues.map((issue) => issue.code)).toContain("STATUS_DRIFT");
  });

  it("prevents a proposal from rewriting the pinned authority policy", async () => {
    const client = new FixtureClient();
    const changedPolicy = policy();
    changedPolicy.externalCheckName = "spoofable-authority";
    client.replace("config/production-closure-authority.json", changedPolicy);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_AUTHORITY_POLICY_DRIFT");
  });

  it("does not charge a proposal for policy the base changed after it branched", async () => {
    // The real incident: a package.json re-pin landed on main, and five
    // unrelated pull requests that had touched neither the policy nor the
    // pinned file were told they had drifted the authority and owed a rotation
    // receipt. Each was clean against its own merge base.
    const client = new FixtureClient();
    const advanced = policy();
    advanced.protectedFiles["package.json"] = `sha256:${"0".repeat(64)}`;
    const advancedBytes = Buffer.from(JSON.stringify(advanced));
    client.advanceBase("config/production-closure-authority.json", advancedBytes);

    const result = await verifyProductionClosureProposal(
      advanced,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      { ...baseAuthority(), policyBytes: advancedBytes },
    );

    const codes = result.issues.map((issue) => issue.code);
    expect(codes).not.toContain("PROPOSAL_AUTHORITY_POLICY_DRIFT");
    expect(codes).not.toContain("PROPOSAL_AUTHORITY_SURFACE_DRIFT");
    expect(codes.filter((code) => code.startsWith("AUTHORITY_ROTATION_"))).toEqual([]);
  });

  it("does not charge a proposal for a protected surface the base added after it branched", async () => {
    const client = new FixtureClient();
    const addedPath = "scripts/production-closure-new-root.ts";
    const addedBytes = Buffer.from("export const protectedRoot = true;\n");
    const advanced = policy();
    advanced.protectedFiles[addedPath] = sha256(addedBytes);
    const advancedBytes = Buffer.from(JSON.stringify(advanced));
    client.advanceBase(addedPath, addedBytes);
    client.advanceBase("config/production-closure-authority.json", advancedBytes);

    const result = await verifyProductionClosureProposal(
      advanced,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      { ...baseAuthority(), policyBytes: advancedBytes },
    );

    const codes = result.issues.map((issue) => issue.code);
    expect(codes).not.toContain("PROPOSAL_AUTHORITY_SURFACE_DRIFT");
    expect(codes.filter((code) => code.startsWith("AUTHORITY_ROTATION_"))).toEqual([]);
  });

  it("still demands a rotation when the proposal itself edits the policy on a stale base", async () => {
    // The reprieve above is for untouched bytes only. A proposal that edits the
    // policy owes the full rotation whether or not the base has moved.
    const client = new FixtureClient();
    const advanced = policy();
    advanced.externalCheckName = "advanced-authority";
    const advancedBytes = Buffer.from(JSON.stringify(advanced));
    client.advanceBase("config/production-closure-authority.json", advancedBytes);
    const proposed = policy();
    proposed.externalCheckName = "spoofable-authority";
    client.replace("config/production-closure-authority.json", proposed);

    const result = await verifyProductionClosureProposal(
      advanced,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      { ...baseAuthority(), policyBytes: advancedBytes },
    );

    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_AUTHORITY_POLICY_DRIFT");
  });

  it("still demands a rotation when the proposal reverts the policy to older bytes", async () => {
    // A revert is an edit. The proposal's bytes differ from the merge base's,
    // so it changed the policy even though every byte it carries once existed.
    const client = new FixtureClient();
    const branchPoint = policy();
    branchPoint.externalCheckName = "branch-point-authority";
    client.advanceBase("config/production-closure-authority.json", Buffer.from(JSON.stringify(branchPoint)));
    client.mergeBasePathToSha.set(
      "config/production-closure-authority.json",
      client.basePathToSha.get("config/production-closure-authority.json")!,
    );

    const result = await verifyProductionClosureProposal(
      branchPoint,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      { ...baseAuthority(), policyBytes: Buffer.from(JSON.stringify(branchPoint)) },
    );

    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_AUTHORITY_POLICY_DRIFT");
  });

  it("still fails a proposal that edits a pinned surface without moving the pin", async () => {
    const client = new FixtureClient();
    client.replace("package.json", Buffer.from('{"name":"tampered"}'));

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_AUTHORITY_SURFACE_DRIFT");
  });

  it("fails closed when the merge base cannot be resolved", async () => {
    // "Could not determine what this proposal changed" must never read as
    // "this proposal changed nothing".
    const client = new FixtureClient();
    client.mergeBaseUnresolved = true;

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.verdict).toBe("fail");
    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_AUTHORITY_MERGE_BASE_UNRESOLVED");
  });

  it("queues changed historical declarations for exact provider validation", async () => {
    const client = new FixtureClient();
    const matrixPath = "docs/PRODUCTION_CLOSURE_MATRIX.json";
    const matrix = JSON.parse(
      client.blobs.get(client.pathToSha.get(matrixPath)!)!.toString("utf8"),
    ) as ProductionClosureMatrix;
    const changedPullRequest = matrix.releaseTrain.pullRequests[0];
    const changedIssue = matrix.issueAuthority.issues[0];
    changedPullRequest.title = `${changedPullRequest.title} corrected`;
    changedIssue.title = `${changedIssue.title} corrected`;
    matrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(matrix);
    client.replace(matrixPath, matrix);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.providerValidationPullRequests).toEqual([changedPullRequest.number]);
    expect(result.providerValidationIssues).toEqual([changedIssue.number]);
  });

  it("rejects removal of a provider declaration without a full observation", async () => {
    const client = new FixtureClient();
    const matrixPath = "docs/PRODUCTION_CLOSURE_MATRIX.json";
    const matrix = JSON.parse(
      client.blobs.get(client.pathToSha.get(matrixPath)!)!.toString("utf8"),
    ) as ProductionClosureMatrix;
    const removed = matrix.releaseTrain.pullRequests.shift()!;
    matrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(matrix);
    client.replace(matrixPath, matrix);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "PROPOSAL_PROVIDER_RECORD_REMOVAL_UNVERIFIED",
      subject: String(removed.number),
    }));
  });

  it("does not flag a base-tracked pull request that promotes itself into the bootstrap slot", async () => {
    const client = new FixtureClient();
    const matrixPath = "docs/PRODUCTION_CLOSURE_MATRIX.json";
    const matrix = JSON.parse(
      client.blobs.get(client.pathToSha.get(matrixPath)!)!.toString("utf8"),
    ) as ProductionClosureMatrix;
    // The proposal drops the PR from the tracked list AND claims the bootstrap slot for
    // it: promotion, not removal. Self-bootstrap must be satisfiable.
    const promoted = matrix.releaseTrain.pullRequests.shift()!;
    matrix.releaseTrain.currentPullRequestBootstrap!.number = promoted.number;
    matrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(matrix);
    client.replace(matrixPath, matrix);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(
      result.issues.filter(
        (issue) =>
          issue.code === "PROPOSAL_PROVIDER_RECORD_REMOVAL_UNVERIFIED" &&
          issue.subject === String(promoted.number),
      ),
      JSON.stringify(result.issues, null, 2),
    ).toEqual([]);
  });

  it("still flags a second tracked pull request removed alongside a self-bootstrap promotion", async () => {
    const client = new FixtureClient();
    const matrixPath = "docs/PRODUCTION_CLOSURE_MATRIX.json";
    const matrix = JSON.parse(
      client.blobs.get(client.pathToSha.get(matrixPath)!)!.toString("utf8"),
    ) as ProductionClosureMatrix;
    // Exactly one number is exempt (the self-promoted bootstrap PR); a SECOND tracked PR
    // removed in the same proposal is still an unverified removal.
    const promoted = matrix.releaseTrain.pullRequests.shift()!;
    const alsoRemoved = matrix.releaseTrain.pullRequests.shift()!;
    matrix.releaseTrain.currentPullRequestBootstrap!.number = promoted.number;
    matrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(matrix);
    client.replace(matrixPath, matrix);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    const removalSubjects = result.issues
      .filter((issue) => issue.code === "PROPOSAL_PROVIDER_RECORD_REMOVAL_UNVERIFIED")
      .map((issue) => issue.subject);
    expect(removalSubjects, JSON.stringify(result.issues, null, 2)).toContain(
      String(alsoRemoved.number),
    );
    expect(removalSubjects, JSON.stringify(result.issues, null, 2)).not.toContain(
      String(promoted.number),
    );
  });

  it("accepts an exhaustive authority-only rotation interpreted by the base revision", async () => {
    const client = new FixtureClient();
    const authority = baseAuthority();
    const baseLedger = JSON.parse(authority.rotationLedgerBytes.toString("utf8"));
    const baseReceipt = baseLedger.rotations.at(-1) ?? null;
    const rotationObservedAt = new Date(
      Math.max(Date.parse(OBSERVED_AT), Date.parse(baseReceipt?.issuedAt ?? OBSERVED_AT) + 60_000),
    ).toISOString();
    const basePolicy = policy();
    basePolicy.trustedReviewers = {
      Claude: [{ login: "claude-reviewer[bot]", userId: 71 }],
    };
    authority.policyBytes = Buffer.from(JSON.stringify(basePolicy));
    const basePolicyBlob = sha(authority.policyBytes);
    client.blobs.set(basePolicyBlob, authority.policyBytes);
    client.basePathToSha.set("config/production-closure-authority.json", basePolicyBlob);
    const runtimePath = "scripts/production-closure-authority-rotation.ts";
    const proposedRuntime = Buffer.from("export const rotatedAuthority = true;\n");
    const proposedPolicy = structuredClone(basePolicy);
    proposedPolicy.protectedFiles[runtimePath] = sha256(proposedRuntime);
    const proposedPolicyBytes = Buffer.from(JSON.stringify(proposedPolicy));
    client.replace(runtimePath, proposedRuntime);
    client.replace("config/production-closure-authority.json", proposedPolicyBytes);

    const matrixPath = "docs/PRODUCTION_CLOSURE_MATRIX.json";
    const matrixBytes = client.blobs.get(client.pathToSha.get(matrixPath)!)!;
    const proposedMatrix = JSON.parse(matrixBytes.toString("utf8")) as ProductionClosureMatrix;
    const bootstrapNumber = proposedMatrix.releaseTrain.currentPullRequestBootstrap!.number;
    const mappedRequirement = proposedMatrix.requirements[0];
    proposedMatrix.releaseTrain.currentPullRequestBootstrap!.requirementIds = [
      ...new Set([
        ...proposedMatrix.releaseTrain.currentPullRequestBootstrap!.requirementIds,
        mappedRequirement.requirementId,
      ]),
    ].sort();
    mappedRequirement.pullRequests = [...new Set([...mappedRequirement.pullRequests, bootstrapNumber])].sort(
      (left, right) => left - right,
    );
    const rotation = {
      rotationId: "rotation-20260825-001",
      kind: "runtime" as const,
      issuedAt: rotationObservedAt,
      expiresAt: new Date(Date.parse(rotationObservedAt) + 24 * 60 * 60 * 1000).toISOString(),
      basePolicySha256: sha256(authority.policyBytes),
      proposedPolicySha256: sha256(proposedPolicyBytes),
    };
    proposedMatrix.releaseTrain.currentPullRequestBootstrap!.authorityRotation = rotation;
    proposedMatrix.releaseTrain.observedAt = rotationObservedAt;
    proposedMatrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(proposedMatrix);
    const proposedMatrixBytes = Buffer.from(JSON.stringify(proposedMatrix));
    client.replace(matrixPath, proposedMatrixBytes);

    const baseMatrixBytes = client.blobs.get(client.basePathToSha.get(matrixPath)!)!;
    const changes = [
      {
        path: "config/production-closure-authority.json",
        fromSha256: sha256(authority.policyBytes),
        toSha256: sha256(proposedPolicyBytes),
        fromMode: "100644" as const,
        toMode: "100644" as const,
      },
      {
        path: matrixPath,
        fromSha256: sha256(baseMatrixBytes),
        toSha256: sha256(proposedMatrixBytes),
        fromMode: "100644" as const,
        toMode: "100644" as const,
      },
      {
        path: runtimePath,
        fromSha256: sha256(readFileSync(resolve(root, runtimePath))),
        toSha256: sha256(proposedRuntime),
        fromMode: "100644" as const,
        toMode: "100644" as const,
      },
    ];
    const proposedLedger = {
      schemaVersion: 1,
      rotations: [...baseLedger.rotations, {
        ...rotation,
        previousRotationId: baseReceipt?.rotationId ?? null,
        baseRevision: BASE,
        baseLedgerSha256: sha256(authority.rotationLedgerBytes),
        successor: null,
        changes,
      }],
    };
    client.replace("config/production-closure-authority-rotation.json", proposedLedger);

    const result = await verifyProductionClosureProposal(
      basePolicy,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      rotationObservedAt,
      authority,
    );

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(result.authorityRotation?.rotationId).toBe(rotation.rotationId);
    expect(result.providerValidationPullRequests).toEqual([]);
    expect(result.providerValidationIssues).toEqual([]);

    proposedMatrix.releaseTrain.observedAt = new Date(
      Date.parse(rotationObservedAt) + 1_000,
    ).toISOString();
    proposedMatrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(proposedMatrix);
    const mistimedMatrixBytes = Buffer.from(JSON.stringify(proposedMatrix));
    client.replace(matrixPath, mistimedMatrixBytes);
    changes.find((change) => change.path === matrixPath)!.toSha256 = sha256(mistimedMatrixBytes);
    client.replace("config/production-closure-authority-rotation.json", proposedLedger);

    const mistimed = await verifyProductionClosureProposal(
      basePolicy,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      rotationObservedAt,
      authority,
    );
    expect(mistimed.issues.map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_OBSERVATION_TIME_MISMATCH",
    );

    proposedMatrix.releaseTrain.observedAt = rotationObservedAt;
    proposedMatrix.issueAuthority.issues[0].title = "Rewritten authority evidence";
    proposedMatrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(proposedMatrix);
    const rewrittenMatrixBytes = Buffer.from(JSON.stringify(proposedMatrix));
    client.replace(matrixPath, rewrittenMatrixBytes);
    changes.find((change) => change.path === matrixPath)!.toSha256 = sha256(rewrittenMatrixBytes);
    client.replace("config/production-closure-authority-rotation.json", proposedLedger);

    const rewritten = await verifyProductionClosureProposal(
      basePolicy,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      rotationObservedAt,
      authority,
    );
    expect(rewritten.issues.map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_MATRIX_SCOPE_INVALID",
    );
    expect(rewritten.providerValidationIssues).toEqual([
      proposedMatrix.issueAuthority.issues[0].number,
    ]);
  });

  it("rejects another workflow that can spoof the controller authority surface", async () => {
    const client = new FixtureClient();
    client.replace(
      ".github/workflows/ci.yml",
      "name: Spoof\npermissions:\n  statuses: write\njobs: {}\n",
    );

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues.map((issue) => issue.code)).toContain(
      "PROPOSAL_CONTROLLER_SURFACE_COLLISION",
    );
  });

  it("prevents a proposal from changing a pinned authority runtime file", async () => {
    const client = new FixtureClient();
    client.replace(".github/workflows/ci.yml", "changed CI authority");

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.issues.map((issue) => issue.code)).toContain("PROPOSAL_AUTHORITY_SURFACE_DRIFT");
  });

  it("drifts when a product proposal neuters an authority-critical npm script", async () => {
    const client = new FixtureClient();
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    manifest.scripts["closure:proposal:check"] = "true";
    client.replace("package.json", manifest);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    const drift = result.issues.filter((issue) => issue.code === "PROPOSAL_AUTHORITY_SURFACE_DRIFT");
    expect(drift.map((issue) => issue.subject)).toEqual(["package.json"]);
  });

  it("accepts a product proposal that adds unrelated npm scripts", async () => {
    const client = new FixtureClient();
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    manifest.scripts["verifier:deepseek:smoke"] = "tsx scripts/verifier-deepseek-smoke.ts";
    manifest.scripts["graphify:process:smoke"] = "tsx scripts/graphify-process-smoke.ts";
    client.replace("package.json", manifest);

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
  });

  it("accepts a normal product proposal after successor activation removed the predecessor", async () => {
    const client = new FixtureClient();
    const predecessorPath = ".github/workflows/closure-authority-quiet-sweep.yml";
    const successorPath = ".github/workflows/closure-authority-v2.yml";
    const workflowBytes = client.blobs.get(client.pathToSha.get(predecessorPath)!)!;
    const activePolicy = policy();
    activePolicy.workflowPath = successorPath;
    activePolicy.externalCheckName = "mendpoint-production-closure-authority-v2";
    activePolicy.externalCheckAppId = 123;
    activePolicy.controllerCheckName = "mendpoint-production-closure-controller-v2";
    activePolicy.controllerCheckAppId = 15368;
    activePolicy.successor = null;
    delete activePolicy.protectedFiles[predecessorPath];
    activePolicy.protectedFiles[successorPath] = sha256(workflowBytes);
    // A post-activation proposal carries exactly one closure-authority controller
    // workflow: the newly-active successor. Any other closure-authority-*.yml that
    // happens to be tracked in the working tree (for example a successor template
    // staged by an in-flight rotation) is not part of THIS proposal's surface. Strip
    // it from the proposed tree, the base tree, AND the protectedFiles map so the
    // fixture models a clean single-controller activation regardless of repo state. A
    // naive client.remove alone is insufficient: a stray workflow the policy also pins
    // must leave protectedFiles too, or the proposal fails on a missing protected
    // surface instead of the collision this test is about.
    for (const trackedPath of [...client.pathToSha.keys()]) {
      if (
        /^\.github\/workflows\/closure-authority-[a-z0-9-]+\.ya?ml$/.test(trackedPath) &&
        trackedPath !== successorPath
      ) {
        client.remove(trackedPath);
        delete activePolicy.protectedFiles[trackedPath];
      }
    }
    const activePolicyBytes = Buffer.from(JSON.stringify(activePolicy));
    client.remove(predecessorPath);
    client.add(successorPath, workflowBytes);
    client.replace("config/production-closure-authority.json", activePolicyBytes);
    client.basePathToSha.set(
      "config/production-closure-authority.json",
      client.pathToSha.get("config/production-closure-authority.json")!,
    );
    const authority = {
      revision: BASE,
      policyBytes: activePolicyBytes,
      rotationLedgerBytes: readFileSync(
        resolve(root, "config", "production-closure-authority-rotation.json"),
      ),
    };

    const result = await verifyProductionClosureProposal(
      activePolicy,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      authority,
    );

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
  });

  it("exempts the newly-active successor from the controller-surface collision while an unrelated extra controller workflow still collides", async () => {
    const client = new FixtureClient();
    const activePath = ".github/workflows/closure-authority-quiet-sweep.yml";
    const successorPath = ".github/workflows/closure-authority-v3.yml";
    const roguePath = ".github/workflows/closure-authority-rogue.yml";
    // Controller-surface bytes: statuses: write + environment: production-closure-authority.
    const controllerBytes = client.blobs.get(client.pathToSha.get(activePath)!)!;
    // Base policy: the quiet-sweep controller is the active controller on the base; this
    // proposal activates a further successor, so proposedPolicy.workflowPath !== policy.workflowPath
    // and ONLY the proposedPolicy.workflowPath exemption can spare the newly-active workflow.
    const basePolicy = policy();
    // Proposed policy: the activate_successor transition flips the active controller to
    // the successor and clears the staged slot.
    const proposedPolicy = policy();
    proposedPolicy.workflowPath = successorPath;
    proposedPolicy.externalCheckName = "mendpoint-production-closure-authority-v3";
    proposedPolicy.controllerCheckName = "mendpoint-production-closure-controller-v3";
    proposedPolicy.successor = null;
    proposedPolicy.protectedFiles[successorPath] = sha256(controllerBytes);
    const proposedPolicyBytes = Buffer.from(JSON.stringify(proposedPolicy));
    // Proposed tree: the newly-active successor present, plus an unrelated extra controller
    // workflow that is neither the active path nor a staged successor slot and so must still
    // be treated as a spoof.
    client.add(successorPath, controllerBytes, false);
    client.add(roguePath, controllerBytes, false);
    client.replace("config/production-closure-authority.json", proposedPolicyBytes);

    const result = await verifyProductionClosureProposal(
      basePolicy,
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    const collisions = result.issues
      .filter((issue) => issue.code === "PROPOSAL_CONTROLLER_SURFACE_COLLISION")
      .map((issue) => issue.subject);
    expect(collisions, JSON.stringify(result.issues, null, 2)).toContain(roguePath);
    expect(collisions, JSON.stringify(result.issues, null, 2)).not.toContain(successorPath);
  });

  it("writes a secret-free failure artifact when protected configuration fails early", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-proposal-authority-"));
    const path = join(directory, "observation.json");
    try {
      writeProposalAuthorityFailureObservation(path, OBSERVED_AT);
      const artifact = readFileSync(path, "utf8");
      expect(JSON.parse(artifact)).toMatchObject({
        verdict: "fail",
        issues: [{ code: "PROPOSAL_AUTHORITY_CONFIGURATION_INVALID" }],
      });
      expect(artifact).not.toContain("token");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries a throttled proposal read without exposing the token", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const client = new GitHubProposalAuthorityClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(null, {
            status: 429,
            headers: { "retry-after": "1" },
          });
        }
        return new Response(JSON.stringify({ id: 1309389373 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    await expect(client.getRepositoryId()).resolves.toBe(1309389373);
    expect(attempts).toBe(2);
    expect(waits).toEqual([1_000]);
    expect(JSON.stringify({ attempts, waits })).not.toContain("sensitive-token");
  });

  it("reads immutable proposal objects locally and performs one cached provider identity read", async () => {
    const repository = createDivergedRepository();
    const requests: string[] = [];
    const client = new GitHubProposalAuthorityClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ id: 1309389373 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        throw new Error("unexpected retry");
      },
      repository.directory,
    );

    try {
      const tree = await client.getRecursiveTree(repository.headRevision);
      expect(tree.truncated).toBe(false);
      expect(tree.tree).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "literal#name.txt", mode: "100644", type: "blob" }),
        expect.objectContaining({
          path: "nested/proposal.txt",
          mode: "100755",
          type: "blob",
          sha: repository.headBlobSha,
          size: repository.headBlobBytes.length,
        }),
      ]));
      await expect(client.getBlob(repository.headBlobSha)).resolves.toEqual(repository.headBlobBytes);
      await expect(client.proposalHeadIsSameRepository(repository.headRevision)).resolves.toBe(true);
      await expect(client.proposalHeadIsSameRepository(repository.localOnlyRevision)).resolves.toBe(false);
      await expect(client.revisionExists(repository.headRevision)).resolves.toBe(true);
      await expect(client.revisionIsAncestor(repository.baseRevision, repository.headRevision)).resolves.toBe(true);
      await expect(client.revisionIsAncestor(repository.mainRevision, repository.headRevision)).resolves.toBe(false);
      await expect(client.getMergeBase(repository.mainRevision, repository.headRevision)).resolves.toBe(
        repository.baseRevision,
      );
      await expect(client.getRepositoryId()).resolves.toBe(1309389373);
      await expect(client.getRepositoryId()).resolves.toBe(1309389373);
      expect(requests).toEqual(["https://api.github.com/repos/gondalaimafia/mendpoint"]);
    } finally {
      rmSync(repository.directory, { recursive: true, force: true });
    }
  });

  it("fails closed on absent local objects without falling back to GitHub", async () => {
    const repository = createDivergedRepository();
    let requests = 0;
    const client = new GitHubProposalAuthorityClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        requests += 1;
        return new Response(JSON.stringify({ id: 1309389373 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        throw new Error("unexpected retry");
      },
      repository.directory,
    );
    const absentRevision = "f".repeat(40);

    try {
      await expect(client.getRecursiveTree(absentRevision)).rejects.toThrow();
      await expect(client.getBlob(absentRevision)).rejects.toThrow();
      await expect(client.revisionExists(absentRevision)).resolves.toBe(false);
      await expect(client.revisionIsAncestor(absentRevision, repository.headRevision)).rejects.toThrow();
      await expect(client.getMergeBase(absentRevision, repository.headRevision)).rejects.toThrow();
      await expect(client.getBlob("HEAD")).rejects.toThrow("exact Git object SHA");
      expect(requests).toBe(0);
    } finally {
      rmSync(repository.directory, { recursive: true, force: true });
    }
  });

  it("rejects a proposal head that is not reachable from the protected repository", async () => {
    const client = new FixtureClient();
    client.proposalHeadIsSameRepository = async () => false;

    const result = await verifyProductionClosureProposal(
      policy(),
      "gondalaimafia/mendpoint",
      HEAD,
      client,
      OBSERVED_AT,
      baseAuthority(),
    );

    expect(result.verdict).toBe("fail");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "PROPOSAL_HEAD_NOT_SAME_REPOSITORY",
      subject: HEAD,
    }));
  });
});
