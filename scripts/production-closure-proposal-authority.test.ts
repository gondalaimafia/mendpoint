import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
const IMMUTABLE_BASE_REVISION = "7f74e609ca0c9f05fa1deaaded76c9d7b2d2fbd6";

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

async function loadImmutableBaseVerifier(): Promise<{
  verify: typeof verifyProductionClosureProposal;
  cleanup: () => void;
}> {
  const temporaryRoot = mkdtempSync(join(root, ".proposal-authority-base-"));
  const checkoutRoot = join(temporaryRoot, "checkout");
  try {
    execFileSync(
      "git",
      ["clone", "--quiet", "--shared", "--no-checkout", root, checkoutRoot],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    execFileSync(
      "git",
      ["checkout", "--quiet", "--detach", IMMUTABLE_BASE_REVISION],
      { cwd: checkoutRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const moduleUrl = pathToFileURL(
      join(checkoutRoot, "scripts", "production-closure-proposal-authority.ts"),
    );
    moduleUrl.searchParams.set("revision", IMMUTABLE_BASE_REVISION);
    const immutableModule = await import(/* @vite-ignore */ moduleUrl.href) as {
      verifyProductionClosureProposal?: unknown;
    };
    if (typeof immutableModule.verifyProductionClosureProposal !== "function") {
      throw new Error("immutable base proposal verifier export is unavailable");
    }
    return {
      verify: immutableModule.verifyProductionClosureProposal as typeof verifyProductionClosureProposal,
      cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function gitBytes(args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(args: string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function bytesAtRevision(revision: string, path: string): Buffer {
  return gitBytes(["show", `${revision}:${path}`]);
}

class ExactRepositoryTransitionClient implements ProposalAuthorityClient {
  private readonly baseEntries = new Map<string, {
    path: string;
    mode: string;
    type: "blob" | "commit";
    sha: string;
    size?: number;
  }>();
  private readonly proposalEntries = new Map<string, {
    path: string;
    mode: string;
    type: "blob" | "commit";
    sha: string;
    size?: number;
  }>();
  private readonly blobs = new Map<string, Buffer>();
  private readonly revisionExistence = new Map<string, boolean>();
  private readonly ancestry = new Map<string, boolean>();

  constructor(
    private readonly baseRevision: string,
    private readonly proposalRevision: string,
    private readonly repositoryId: number,
  ) {
    const baseTree = gitBytes([
      "ls-tree",
      "-r",
      "-z",
      "-l",
      "--full-tree",
      baseRevision,
    ]).toString("utf8");
    for (const record of baseTree.split("\0").filter(Boolean)) {
      const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error(`invalid immutable base tree record: ${record}`);
      const [, mode, type, blobSha, sizeText, path] = match;
      this.baseEntries.set(path, {
        path,
        mode,
        type: type as "blob" | "commit",
        sha: blobSha,
        ...(sizeText === "-" ? {} : { size: Number(sizeText) }),
      });
    }

    const tracked = gitBytes(["ls-files", "-s", "-z"]).toString("utf8");
    for (const record of tracked.split("\0").filter(Boolean)) {
      const separator = record.indexOf("\t");
      const header = separator < 0 ? "" : record.slice(0, separator);
      const path = separator < 0 ? "" : record.slice(separator + 1);
      const match = /^([0-7]{6}) ([a-f0-9]{40}) ([0-3])$/.exec(header);
      if (!match || !path || match[3] !== "0") {
        throw new Error(`invalid proposed tracked-tree record: ${record}`);
      }
      const [, mode, indexedSha] = match;
      if (mode === "160000") {
        this.proposalEntries.set(path, {
          path,
          mode,
          type: "commit",
          sha: indexedSha,
        });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(resolve(root, path));
      } catch {
        continue;
      }
      const blobSha = sha(bytes);
      this.blobs.set(blobSha, bytes);
      this.proposalEntries.set(path, {
        path,
        mode,
        type: "blob",
        sha: blobSha,
        size: bytes.length,
      });
    }
  }

  proposalPathBytes(path: string): Buffer {
    const entry = this.proposalEntries.get(path);
    const bytes = entry?.type === "blob" ? this.blobs.get(entry.sha) : undefined;
    if (!bytes) throw new Error(`proposed tracked path is unavailable: ${path}`);
    return bytes;
  }

  replaceProposalPath(path: string, bytes: Buffer): void {
    const entry = this.proposalEntries.get(path);
    if (!entry || entry.type !== "blob") throw new Error(`proposed tracked path is unavailable: ${path}`);
    const blobSha = sha(bytes);
    this.blobs.set(blobSha, bytes);
    this.proposalEntries.set(path, {
      ...entry,
      sha: blobSha,
      size: bytes.length,
    });
  }

  async getRepositoryId(): Promise<number> {
    return this.repositoryId;
  }

  async getRecursiveTree(revision: string) {
    if (revision === this.baseRevision) {
      return { truncated: false, tree: [...this.baseEntries.values()] };
    }
    if (revision === this.proposalRevision) {
      return { truncated: false, tree: [...this.proposalEntries.values()] };
    }
    throw new Error(`unexpected repository transition revision: ${revision}`);
  }

  async getBlob(blobSha: string): Promise<Buffer> {
    const proposed = this.blobs.get(blobSha);
    if (proposed) return proposed;
    const base = gitBytes(["cat-file", "blob", blobSha]);
    this.blobs.set(blobSha, base);
    return base;
  }

  async revisionExists(revision: string): Promise<boolean> {
    const cached = this.revisionExistence.get(revision);
    if (cached !== undefined) return cached;
    let exists = false;
    try {
      gitBytes(["cat-file", "-e", `${revision}^{commit}`]);
      exists = true;
    } catch {
      exists = false;
    }
    this.revisionExistence.set(revision, exists);
    return exists;
  }

  async revisionIsAncestor(revision: string, descendant: string): Promise<boolean> {
    const key = `${revision}:${descendant}`;
    const cached = this.ancestry.get(key);
    if (cached !== undefined) return cached;
    let isAncestor = false;
    try {
      gitBytes(["merge-base", "--is-ancestor", revision, descendant]);
      isAncestor = true;
    } catch {
      isAncestor = false;
    }
    this.ancestry.set(key, isAncestor);
    return isAncestor;
  }

  async getMergeBase(base: string, head: string): Promise<string | null> {
    try {
      const mergeBase = gitText(["merge-base", base, head]);
      return /^[a-f0-9]{40}$/.test(mergeBase) ? mergeBase : null;
    } catch {
      return null;
    }
  }
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

  it("executes the exact bootstrap transition under the immutable and proposed verifiers", async () => {
    const proposalRevision = gitText(["rev-parse", "HEAD"]);
    const basePolicyBytes = bytesAtRevision(
      IMMUTABLE_BASE_REVISION,
      "config/production-closure-authority.json",
    );
    const baseRotationLedgerBytes = bytesAtRevision(
      IMMUTABLE_BASE_REVISION,
      "config/production-closure-authority-rotation.json",
    );
    const basePolicy = JSON.parse(basePolicyBytes.toString("utf8"));
    const client = new ExactRepositoryTransitionClient(
      IMMUTABLE_BASE_REVISION,
      proposalRevision,
      basePolicy.repositoryId,
    );
    const proposedMatrix = JSON.parse(
      client.proposalPathBytes("docs/PRODUCTION_CLOSURE_MATRIX.json").toString("utf8"),
    ) as ProductionClosureMatrix;
    const authority = {
      revision: IMMUTABLE_BASE_REVISION,
      policyBytes: basePolicyBytes,
      rotationLedgerBytes: baseRotationLedgerBytes,
    };
    const immutableBase = await loadImmutableBaseVerifier();
    try {
      const immutableResult = await immutableBase.verify(
        basePolicy,
        "gondalaimafia/mendpoint",
        proposalRevision,
        client,
        proposedMatrix.releaseTrain.observedAt,
        authority,
      );
      expect(immutableResult.issues.map((issue) => issue.code)).toEqual([
        "AUTHORITY_ROTATION_MATRIX_SCOPE_INVALID",
      ]);

      const proposedResult = await verifyProductionClosureProposal(
        basePolicy,
        "gondalaimafia/mendpoint",
        proposalRevision,
        client,
        proposedMatrix.releaseTrain.observedAt,
        authority,
      );
      expect(proposedResult.verdict, JSON.stringify(proposedResult.issues, null, 2)).toBe("pass");
      expect(proposedResult.issues).toEqual([]);
    } finally {
      immutableBase.cleanup();
    }
  }, 30_000);

  it("rejects an exact bootstrap transition whose provider observation is one second late", async () => {
    const proposalRevision = gitText(["rev-parse", "HEAD"]);
    const basePolicyBytes = bytesAtRevision(
      IMMUTABLE_BASE_REVISION,
      "config/production-closure-authority.json",
    );
    const baseRotationLedgerBytes = bytesAtRevision(
      IMMUTABLE_BASE_REVISION,
      "config/production-closure-authority-rotation.json",
    );
    const basePolicy = JSON.parse(basePolicyBytes.toString("utf8"));
    const client = new ExactRepositoryTransitionClient(
      IMMUTABLE_BASE_REVISION,
      proposalRevision,
      basePolicy.repositoryId,
    );
    const matrixPath = "docs/PRODUCTION_CLOSURE_MATRIX.json";
    const ledgerPath = "config/production-closure-authority-rotation.json";
    const proposedMatrix = JSON.parse(
      client.proposalPathBytes(matrixPath).toString("utf8"),
    ) as ProductionClosureMatrix;
    proposedMatrix.releaseTrain.observedAt = new Date(
      Date.parse(proposedMatrix.releaseTrain.observedAt) + 1_000,
    ).toISOString();
    proposedMatrix.releaseTrain.observationDigest = releaseTrainIntegrityDigest(proposedMatrix);
    const mistimedMatrixBytes = Buffer.from(`${JSON.stringify(proposedMatrix, null, 2)}\n`);
    client.replaceProposalPath(matrixPath, mistimedMatrixBytes);

    const proposedLedger = JSON.parse(client.proposalPathBytes(ledgerPath).toString("utf8"));
    const matrixChange = proposedLedger.rotations.at(-1)?.changes.find(
      (change: { path?: unknown }) => change.path === matrixPath,
    );
    if (!matrixChange) throw new Error("exact authority rotation does not bind the closure matrix");
    matrixChange.toSha256 = sha256(mistimedMatrixBytes);
    client.replaceProposalPath(
      ledgerPath,
      Buffer.from(`${JSON.stringify(proposedLedger, null, 2)}\n`),
    );

    const result = await verifyProductionClosureProposal(
      basePolicy,
      "gondalaimafia/mendpoint",
      proposalRevision,
      client,
      proposedMatrix.releaseTrain.observedAt,
      {
        revision: IMMUTABLE_BASE_REVISION,
        policyBytes: basePolicyBytes,
        rotationLedgerBytes: baseRotationLedgerBytes,
      },
    );
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "AUTHORITY_ROTATION_OBSERVATION_TIME_MISMATCH",
    ]);
  }, 30_000);

  it("records the immutable-base bootstrap rejection before the proposed verifier accepts exact evidence", async () => {
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

    const immutableBase = await loadImmutableBaseVerifier();
    try {
      const baseResult = await immutableBase.verify(
        basePolicy,
        "gondalaimafia/mendpoint",
        HEAD,
        client,
        rotationObservedAt,
        authority,
      );
      expect(baseResult.verdict).toBe("fail");
      expect(baseResult.issues.map((issue) => issue.code)).toContain(
        "AUTHORITY_ROTATION_MATRIX_SCOPE_INVALID",
      );

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
    } finally {
      immutableBase.cleanup();
    }

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
  }, 15_000);

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
    const predecessorPath = ".github/workflows/closure-authority.yml";
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

  it("keeps an allowed missing revision as a single non-retried read", async () => {
    let attempts = 0;
    const client = new GitHubProposalAuthorityClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        attempts += 1;
        return new Response(null, { status: 404 });
      },
      async () => {
        throw new Error("unexpected retry");
      },
    );

    await expect(client.revisionExists(HEAD)).resolves.toBe(false);
    expect(attempts).toBe(1);
  });
});
