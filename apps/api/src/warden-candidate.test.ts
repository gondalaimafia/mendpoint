import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discardWardenCandidate,
  parseWardenCandidateReviewResult,
  readWardenApprovalArtifact,
  readWardenCandidate,
  sealWardenCandidateApproval,
} from "./warden-candidate.js";

const roots: string[] = [];
const REVIEW_BINDING = {
  baseBranch: "main",
  reviewerPrincipalId: "human:reviewer@example.com",
  rationale: "The target and regression checks pass.",
} as const;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(deleted = false) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-candidate-api-"));
  roots.push(root);
  const source = join(root, "source");
  const tenantRoot = join(root, "data", "warden-candidates", "tenant-a");
  const candidate = join(tenantRoot, "attempt-a");
  mkdirSync(source, { recursive: true });
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(source, "client.js"), "export const path = '/old';\n");
  if (!deleted) writeFileSync(join(candidate, "client.js"), "export const path = '/new';\n");
  const evidenceRoot = join(root, "data", "warden-evidence", "tenant-a");
  mkdirSync(evidenceRoot, { recursive: true });
  const entry = (tree: string) => {
    const content = readFileSync(join(tree, "client.js"));
    return {
      path: "client.js",
      size: content.byteLength,
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      executable: (lstatSync(join(tree, "client.js")).mode & 0o111) !== 0,
    };
  };
  const treeDigest = (value: ReturnType<typeof entry> | null) => `sha256:${createHash("sha256")
    .update(JSON.stringify(value ? [{ executable: value.executable, path: value.path, sha256: value.sha256, size: value.size }] : []))
    .digest("hex")}`;
  const sourceEntry = entry(source);
  const candidateEntry = deleted ? null : entry(candidate);
  const sourceDigest = treeDigest(sourceEntry);
  const candidateDigest = treeDigest(candidateEntry);
  const manifest = join(tenantRoot, "manifest.json");
  const evidence = join(evidenceRoot, "evidence.json");
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1,
    source: { digest: sourceDigest },
    candidate: { digest: candidateDigest, entries: candidateEntry ? [candidateEntry] : [] },
    changedPaths: ["client.js"],
  }));
  writeFileSync(evidence, JSON.stringify({
    schemaVersion: 1,
    sourceDigest,
    candidateDigest,
    changedPaths: ["client.js"],
    review: {
      schemaVersion: 1,
      summary: "The exact candidate passed every configured check.",
      verification: {
        summary: "The target and regression checks passed.",
        commands: [{
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputSha256: `sha256:${"f".repeat(64)}`,
        }],
      },
      edits: [{
        path: "client.js",
        rationale: "This source change addresses the bounded API repair.",
        category: "api_repair",
        risk: "medium",
        confidence: 1,
        assessmentSource: "planner",
        verification: {
          summary: "The target and regression checks passed.",
          commandOutputSha256: [`sha256:${"f".repeat(64)}`],
        },
      }],
    },
  }));
  const result = {
    source: { repositoryId: "repo-1", snapshotId: "snapshot-1", revision: "a".repeat(40) },
    changedPaths: ["client.js"],
    artifacts: {
      candidateWorkspace: candidate,
      candidateManifest: manifest,
      evidence,
      sourceDigest,
      candidateDigest,
      candidateManifestSha256: undefined as string | undefined,
      evidenceSha256: undefined as string | undefined,
    },
    retention: { expiresAt: "2035-08-12T00:00:00.000Z" },
  };
  const resultJson = JSON.stringify(result);
  return { root, source, candidate, manifest, evidence, result, resultJson };
}

describe("Warden candidate API", () => {
  it("fails closed when a review row contains malformed result JSON", () => {
    expect(() => parseWardenCandidateReviewResult("{ malformed"))
      .toThrow("warden_candidate_result_invalid");
    expect(() => parseWardenCandidateReviewResult(JSON.stringify([])))
      .toThrow("warden_candidate_result_invalid");
  });

  it("returns bounded before and after content from the tenant candidate root", async () => {
    const value = fixture();
    const result = await readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    });
    expect(result.files[0]).toMatchObject({
      path: "client.js",
      before: expect.stringContaining("/old"),
      after: expect.stringContaining("/new"),
      beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.reviewEvidence).toMatchObject({
      schemaVersion: 1,
      edits: [{ path: "client.js", risk: "medium", confidence: 1, assessmentSource: "planner" }],
      verification: { commands: [{ command: "npm test", ok: true, exitCode: 0 }] },
    });
  });

  it("rejects an artifact outside the tenant candidate root", async () => {
    const value = fixture();
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: JSON.stringify({
        changedPaths: ["client.js"],
        artifacts: { candidateWorkspace: value.source },
        retention: { expiresAt: "2035-08-12T00:00:00.000Z" },
      }),
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    })).rejects.toThrow("warden_candidate_workspace_escape");
  });

  it("removes a rejected candidate only inside its tenant roots", async () => {
    const value = fixture();
    discardWardenCandidate({
      tenantId: "tenant-a",
      status: "candidate_ready",
      resultJson: JSON.stringify({
        artifacts: {
          candidateWorkspace: value.candidate,
          candidateManifest: value.manifest,
          evidence: value.evidence,
        },
      }),
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    });
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    })).rejects.toThrow("warden_candidate_workspace_invalid");
  });

  it("rejects a candidate at the exact expiry instant", async () => {
    const value = fixture();
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
      nowMs: Date.parse("2035-08-12T00:00:00.000Z"),
    })).rejects.toThrow("warden_candidate_expired");
  });

  it("keeps an approved candidate readable across the delivery retention boundary", async () => {
    const value = fixture();
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_approved",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
      nowMs: Date.parse("2035-08-12T00:00:00.000Z"),
    })).resolves.toMatchObject({
      changedPaths: ["client.js"],
      reviewEvidence: { edits: [{ path: "client.js" }] },
    });
  });

  it("rejects source drift and a nested candidate junction", async () => {
    const value = fixture();
    writeFileSync(join(value.source, "client.js"), "export const path = '/tampered';\n");
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    })).rejects.toThrow("warden_candidate_integrity_failed");

    const second = fixture();
    const outside = join(second.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "client.js"), "outside\n");
    rmSync(join(second.candidate, "client.js"));
    symlinkSync(outside, join(second.candidate, "nested"), "junction");
    const result = JSON.parse(second.resultJson) as Record<string, unknown>;
    result.changedPaths = ["nested/client.js"];
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: second.source,
      status: "candidate_ready",
      resultJson: JSON.stringify(result),
      env: { MENDPOINT_DATA_DIR: join(second.root, "data") },
    })).rejects.toThrow(/warden_candidate_(symlink_path|integrity_failed)/);
  });

  it("rejects a parent-directory junction above the tenant candidate root", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const candidatesDir = join(dataDir, "warden-candidates");
    const relocated = join(dataDir, "warden-candidates-real");
    renameSync(candidatesDir, relocated);
    symlinkSync(relocated, candidatesDir, "junction");
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    })).rejects.toThrow(/warden_candidate_(symlink_path|tenant_root_invalid)/);
  });

  it("rejects a parent-directory junction above the tenant evidence root", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const evidenceDir = join(dataDir, "warden-evidence");
    const relocated = join(dataDir, "warden-evidence-real");
    renameSync(evidenceDir, relocated);
    symlinkSync(relocated, evidenceDir, "junction");
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    })).rejects.toThrow(/warden_candidate_(symlink_path|evidence_root_invalid)/);
  });
});

describe("Warden approval sealing", () => {
  it("seals production provider, graph, impact, and uncertainty lineage", async () => {
    const value = fixture();
    (value.result as Record<string, unknown>).intake = {
      fettlerProviderChange: {
        schemaVersion: 1,
        providerSlug: "stripe",
        changeId: "change-stripe-2026-08-31",
        pipelineJobId: "pipeline-job-1",
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        revision: "a".repeat(40),
        graphVersionId: "graph-version-1",
        graphContextArtifactId: "graph-context-1",
        impactEvidenceDigest: `sha256:${"d".repeat(64)}`,
        overallConfidence: "high",
        whatChanged: "The provider removed the legacy request field.",
        knownFacts: ["The removed request field is used by client.js."],
        unknowns: ["Runtime-only callers were not observed."],
        whyAffected: "client.js sends the removed request field at the confirmed call site.",
      },
    };
    const sealed = await sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: JSON.stringify(value.result),
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    });
    expect(readWardenApprovalArtifact({
      tenantId: "tenant-a", path: sealed.path, sha256: sealed.sha256,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    })).toMatchObject({
      schemaVersion: 5,
      fettlerProviderChange: {
        providerSlug: "stripe",
        graphVersionId: "graph-version-1",
        impactEvidenceDigest: `sha256:${"d".repeat(64)}`,
      },
    });
  });

  it("rejects provider change evidence bound to another snapshot", async () => {
    const value = fixture();
    (value.result as Record<string, unknown>).intake = {
      fettlerProviderChange: {
        schemaVersion: 1,
        providerSlug: "stripe",
        changeId: "change-stripe-2026-08-31",
        pipelineJobId: "pipeline-job-1",
        repositoryId: "repo-1",
        snapshotId: "snapshot-other",
        revision: "a".repeat(40),
        graphVersionId: null,
        graphContextArtifactId: null,
        impactEvidenceDigest: `sha256:${"d".repeat(64)}`,
        overallConfidence: "medium",
        whatChanged: "The provider renamed a request field.",
        knownFacts: ["A bounded call site was found."],
        unknowns: ["Graph coverage was insufficient."],
        whyAffected: "Raw retrieval found a matching request field.",
      },
    };
    await expect(sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: JSON.stringify(value.result),
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    })).rejects.toThrow("fettler_provider_change_evidence_binding_mismatch");
  });

  it("seals complete version two edit authority as a version four approval artifact", async () => {
    const value = fixture();
    const evidence = JSON.parse(readFileSync(value.evidence, "utf8")) as Record<string, unknown>;
    const review = evidence.review as Record<string, unknown>;
    const edit = (review.edits as Array<Record<string, unknown>>)[0]!;
    review.schemaVersion = 2;
    delete edit.rationale;
    delete edit.category;
    Object.assign(edit, {
      hypothesis: "The observed legacy endpoint causes the failing request.",
      targetSymbol: "path",
      sourceEvidence: [{ path: "client.js", digest: `sha256:${"b".repeat(64)}` }],
      precondition: "The exact legacy endpoint is still present.",
      expectedObservation: "The endpoint changes exactly once.",
      postcondition: "The approved request and regression checks pass.",
      rollback: "Restore the exact observed source bytes.",
      stopCondition: "Stop if the source evidence digest changes.",
    });
    writeFileSync(value.evidence, JSON.stringify(evidence));
    value.result.artifacts.candidateManifestSha256 = `sha256:${createHash("sha256")
      .update(readFileSync(value.manifest)).digest("hex")}`;
    value.result.artifacts.evidenceSha256 = `sha256:${createHash("sha256")
      .update(readFileSync(value.evidence)).digest("hex")}`;
    const sealed = await sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: JSON.stringify(value.result),
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    });
    expect(readWardenApprovalArtifact({
      tenantId: "tenant-a", path: sealed.path, sha256: sealed.sha256,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    })).toMatchObject({ schemaVersion: 4, reviewEvidence: { schemaVersion: 2 } });
  });

  it("returns and seals an exact approved deletion with an absent post-state", async () => {
    const value = fixture(true);
    const env = { MENDPOINT_DATA_DIR: join(value.root, "data") };
    const result = await readWardenCandidate({
      tenantId: "tenant-a", repoPath: value.source, status: "candidate_ready",
      resultJson: value.resultJson, env,
    });
    expect(result.files).toEqual([expect.objectContaining({
      path: "client.js", before: expect.stringContaining("/old"), after: null,
      beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/), afterSha256: null,
    })]);
    const seal = await sealWardenCandidateApproval({
      tenantId: "tenant-a", repoPath: value.source, status: "candidate_ready",
      resultJson: value.resultJson, env, ...REVIEW_BINDING,
    });
    const approval = readWardenApprovalArtifact({
      tenantId: "tenant-a", path: seal.path, sha256: seal.sha256, env,
    });
    expect(approval.files).toEqual([expect.objectContaining({
      path: "client.js", before: expect.any(String), after: null,
      beforeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), afterSha256: null,
    })]);
    expect(approval.candidate).toMatchObject({ entries: [] });
  });

  it("rejects rewritten version two edit authority even when its JSON remains valid", async () => {
    const value = fixture();
    const evidence = JSON.parse(readFileSync(value.evidence, "utf8")) as Record<string, unknown>;
    const review = evidence.review as Record<string, unknown>;
    const edit = (review.edits as Array<Record<string, unknown>>)[0]!;
    review.schemaVersion = 2;
    delete edit.rationale;
    delete edit.category;
    Object.assign(edit, {
      hypothesis: "The observed legacy endpoint causes the failing request.",
      targetSymbol: "path",
      sourceEvidence: [{ path: "client.js", digest: `sha256:${"b".repeat(64)}` }],
      precondition: "The exact legacy endpoint is still present.",
      expectedObservation: "The endpoint changes exactly once.",
      postcondition: "The approved request and regression checks pass.",
      rollback: "Restore the exact observed source bytes.",
      stopCondition: "Stop if the source evidence digest changes.",
    });
    writeFileSync(value.evidence, JSON.stringify(evidence));
    value.result.artifacts.candidateManifestSha256 = `sha256:${createHash("sha256")
      .update(readFileSync(value.manifest)).digest("hex")}`;
    value.result.artifacts.evidenceSha256 = `sha256:${createHash("sha256")
      .update(readFileSync(value.evidence)).digest("hex")}`;
    const resultJson = JSON.stringify(value.result);

    edit.rollback = "Run an unrelated command instead.";
    writeFileSync(value.evidence, JSON.stringify(evidence));

    await expect(sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson,
      env: { MENDPOINT_DATA_DIR: join(value.root, "data") },
    })).rejects.toThrow("warden_candidate_integrity_failed");
  });

  it("seals an immutable approval artifact that survives workspace mutation", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const sealed = await sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    });
    expect(sealed.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sealed.path.endsWith(".json")).toBe(true);
    expect(sealed.created).toBe(true);

    // Mutate the candidate workspace AFTER sealing.
    writeFileSync(join(value.candidate, "client.js"), "export const path = '/mutated';\n");

    // The sealed artifact still reverifies and holds the pre-mutation content.
    const artifact = readWardenApprovalArtifact({
      tenantId: "tenant-a",
      path: sealed.path,
      sha256: sealed.sha256,
      env: { MENDPOINT_DATA_DIR: dataDir },
    });
    const files = artifact.files as Array<Record<string, unknown>>;
    const after = Buffer.from(files[0].after as string, "base64").toString("utf8");
    expect(after).toContain("/new");
    expect(after).not.toContain("/mutated");
    expect(artifact).toMatchObject({
      schemaVersion: 3,
      reviewEvidence: {
        edits: [{
          path: "client.js",
          rationale: expect.any(String),
          risk: "medium",
          confidence: 1,
          assessmentSource: "planner",
        }],
      },
    });

    // Workspace-based reads and re-sealing now see the mutation, proving the
    // seal (not the mutable workspace) is what protects the approval.
    await expect(readWardenCandidate({
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    })).rejects.toThrow("warden_candidate_integrity_failed");
    await expect(sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    })).rejects.toThrow("warden_candidate_integrity_failed");
  });

  it("returns the same content-addressed seal on a concurrent double approve", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const input = {
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    } as const;
    const first = await sealWardenCandidateApproval(input);
    expect(first.created).toBe(true);
    // A second approve of the same candidate (same content-addressed path)
    // must not clobber or delete the committed artifact.
    const second = await sealWardenCandidateApproval(input);
    expect(second.path).toBe(first.path);
    expect(second.sha256).toBe(first.sha256);
    expect(second.created).toBe(false);
    const artifact = readWardenApprovalArtifact({
      tenantId: "tenant-a",
      path: first.path,
      sha256: first.sha256,
      env: { MENDPOINT_DATA_DIR: dataDir },
    });
    const files = artifact.files as Array<Record<string, unknown>>;
    const after = Buffer.from(files[0].after as string, "base64").toString("utf8");
    expect(after).toContain("/new");
  });

  it("recovers safely around interrupted temp and post-publication seal writes", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const input = {
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    } as const;
    const first = await sealWardenCandidateApproval(input);
    const exact = readFileSync(first.path);

    // A process death before atomic publication can leave an incomplete temp
    // inode. Replay must publish the complete seal without treating that temp as
    // authoritative.
    rmSync(first.path);
    const interrupted = `${first.path}.interrupted.tmp`;
    writeFileSync(interrupted, exact.subarray(0, Math.max(1, Math.floor(exact.byteLength / 2))));
    const recovered = await sealWardenCandidateApproval(input);
    expect(recovered.created).toBe(true);
    expect(readFileSync(recovered.path)).toEqual(exact);

    // A death after publication but before temp cleanup leaves a complete final
    // seal. Replay must verify the exact bytes and reuse it without clobbering.
    const replay = await sealWardenCandidateApproval(input);
    expect(replay).toEqual({ path: recovered.path, sha256: recovered.sha256, created: false });
    expect(readFileSync(replay.path)).toEqual(exact);
  });

  it("rejects re-sealing over a corrupt artifact at the content-addressed path", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const input = {
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    } as const;
    const sealed = await sealWardenCandidateApproval(input);
    // Corrupt the bytes at the sealed content-addressed path.
    writeFileSync(sealed.path, "{\"schemaVersion\":1,\"corrupt\":true}");
    await expect(sealWardenCandidateApproval(input))
      .rejects.toThrow("warden_candidate_approval_conflict");
  });

  it("rejects a tampered sealed approval artifact", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const sealed = await sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    });
    const artifact = JSON.parse(readFileSync(sealed.path, "utf8")) as Record<string, unknown>;
    const reviewEvidence = artifact.reviewEvidence as Record<string, unknown>;
    reviewEvidence.edits = [];
    const tampered = JSON.stringify(artifact);
    writeFileSync(sealed.path, tampered);
    const tamperedSha256 = `sha256:${createHash("sha256").update(tampered).digest("hex")}`;
    expect(() => readWardenApprovalArtifact({
      tenantId: "tenant-a",
      path: sealed.path,
      sha256: tamperedSha256,
      env: { MENDPOINT_DATA_DIR: dataDir },
    })).toThrow("warden_candidate_approval_invalid");
  });

  it("rejects an approval schema that is paired with the wrong review evidence version", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const sealed = await sealWardenCandidateApproval({
      ...REVIEW_BINDING,
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    });
    const artifact = JSON.parse(readFileSync(sealed.path, "utf8")) as Record<string, unknown>;
    artifact.schemaVersion = 4;
    const bytes = JSON.stringify(artifact);
    writeFileSync(sealed.path, bytes);
    expect(() => readWardenApprovalArtifact({
      tenantId: "tenant-a",
      path: sealed.path,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      env: { MENDPOINT_DATA_DIR: dataDir },
    })).toThrow("warden_candidate_approval_invalid");
  });
});
