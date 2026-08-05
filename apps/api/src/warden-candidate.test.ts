import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discardWardenCandidate,
  readWardenApprovalArtifact,
  readWardenCandidate,
  sealWardenCandidateApproval,
} from "./warden-candidate.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-candidate-api-"));
  roots.push(root);
  const source = join(root, "source");
  const tenantRoot = join(root, "data", "warden-candidates", "tenant-a");
  const candidate = join(tenantRoot, "attempt-a");
  mkdirSync(source, { recursive: true });
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(source, "client.js"), "export const path = '/old';\n");
  writeFileSync(join(candidate, "client.js"), "export const path = '/new';\n");
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
  const treeDigest = (value: ReturnType<typeof entry>) => `sha256:${createHash("sha256")
    .update(JSON.stringify([{ executable: value.executable, path: value.path, sha256: value.sha256, size: value.size }]))
    .digest("hex")}`;
  const sourceEntry = entry(source);
  const candidateEntry = entry(candidate);
  const sourceDigest = treeDigest(sourceEntry);
  const candidateDigest = treeDigest(candidateEntry);
  const manifest = join(tenantRoot, "manifest.json");
  const evidence = join(evidenceRoot, "evidence.json");
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1,
    source: { digest: sourceDigest },
    candidate: { digest: candidateDigest, entries: [candidateEntry] },
    changedPaths: ["client.js"],
  }));
  writeFileSync(evidence, JSON.stringify({
    schemaVersion: 1,
    sourceDigest,
    candidateDigest,
    changedPaths: ["client.js"],
  }));
  const resultJson = JSON.stringify({
    changedPaths: ["client.js"],
    artifacts: {
      candidateWorkspace: candidate,
      candidateManifest: manifest,
      evidence,
      sourceDigest,
      candidateDigest,
    },
    retention: { expiresAt: "2035-08-12T00:00:00.000Z" },
  });
  return { root, source, candidate, manifest, evidence, resultJson };
}

describe("Warden candidate API", () => {
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
  it("seals an immutable approval artifact that survives workspace mutation", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const sealed = await sealWardenCandidateApproval({
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

  it("rejects re-sealing over a corrupt artifact at the content-addressed path", async () => {
    const value = fixture();
    const dataDir = join(value.root, "data");
    const input = {
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
      tenantId: "tenant-a",
      repoPath: value.source,
      status: "candidate_ready",
      resultJson: value.resultJson,
      env: { MENDPOINT_DATA_DIR: dataDir },
    });
    const tampered = readFileSync(sealed.path, "utf8").replace("\"schemaVersion\":1", "\"schemaVersion\":2");
    writeFileSync(sealed.path, tampered);
    expect(() => readWardenApprovalArtifact({
      tenantId: "tenant-a",
      path: sealed.path,
      sha256: sealed.sha256,
      env: { MENDPOINT_DATA_DIR: dataDir },
    })).toThrow("warden_candidate_approval_digest_mismatch");
  });
});
