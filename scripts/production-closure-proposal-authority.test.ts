import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  releaseTrainIntegrityDigest,
  type ProductionClosureMatrix,
} from "./production-closure-matrix.js";
import {
  verifyProductionClosureProposal,
  writeProposalAuthorityFailureObservation,
  type ProposalAuthorityClient,
} from "./production-closure-proposal-authority.js";

const root = resolve(import.meta.dirname, "..");
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
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

class FixtureClient implements ProposalAuthorityClient {
  truncated = false;
  readonly pathToSha = new Map<string, string>();
  readonly basePathToSha = new Map<string, string>();
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
  async getRecursiveTree(revision: string) {
    const source = revision === BASE ? this.basePathToSha : this.pathToSha;
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

  it("accepts an exhaustive authority-only rotation interpreted by the base revision", async () => {
    const client = new FixtureClient();
    const authority = baseAuthority();
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
    const rotation = {
      rotationId: "rotation-20260825-001",
      kind: "runtime" as const,
      issuedAt: "2026-08-25T11:00:00.000Z",
      expiresAt: "2026-08-26T11:00:00.000Z",
      basePolicySha256: sha256(authority.policyBytes),
      proposedPolicySha256: sha256(proposedPolicyBytes),
    };
    proposedMatrix.releaseTrain.currentPullRequestBootstrap!.authorityRotation = rotation;
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
      rotations: [{
        ...rotation,
        previousRotationId: null,
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
      OBSERVED_AT,
      authority,
    );

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(result.authorityRotation?.rotationId).toBe(rotation.rotationId);

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
      OBSERVED_AT,
      authority,
    );
    expect(rewritten.issues.map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_MATRIX_SCOPE_INVALID",
    );
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
});
