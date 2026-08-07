import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recipeFilesDigest, type RecipeFiles } from "./recipe.js";
import {
  discardAdaptiveCandidate,
  promoteAdaptiveCandidateFiles,
  readAdaptiveCandidateArtifact,
  reconcileAdaptiveCandidateArtifacts,
  sealAdaptiveCandidate,
} from "./adaptive-candidate.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore Windows lock races */
      }
    }
  }
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-adaptive-seal-"));
  dirs.push(dir);
  return dir;
}

const RECIPE_FILES: RecipeFiles = Object.freeze({
  "package.json": '{\n  "engines": { "node": ">=18" }\n}\n',
  "src/index.ts": "export const value = 1;\n",
});

const CONVERGED_FILES: RecipeFiles = Object.freeze({
  "package.json": '{\n  "engines": { "node": ">=20" }\n}\n',
  "src/index.ts": "export const value = 1;\n",
});

function baseInput(env: NodeJS.ProcessEnv) {
  return {
    tenantId: "tenant-a",
    campaignId: "campaign-1",
    unitId: "unit-1",
    attemptId: "tfattempt_abc",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "e".repeat(40),
    divergedFromDigest: recipeFilesDigest(RECIPE_FILES),
    candidateDigest: recipeFilesDigest(CONVERGED_FILES),
    failingCommandId: "verify:typecheck",
    changedPaths: ["package.json"],
    files: CONVERGED_FILES,
    fileModes: Object.freeze({
      "package.json": "100644" as const,
      "src/index.ts": "100755" as const,
    }),
    review: Object.freeze({
      schemaVersion: 1 as const,
      edits: Object.freeze([Object.freeze({
        path: "package.json",
        changeType: "modify" as const,
        beforeContent: RECIPE_FILES["package.json"]!,
        beforeDigest: `sha256:${createHash("sha256").update(RECIPE_FILES["package.json"]!).digest("hex")}`,
        beforeMode: "100644" as const,
        afterDigest: `sha256:${createHash("sha256").update(CONVERGED_FILES["package.json"]!).digest("hex")}`,
        afterMode: "100644" as const,
        semanticCategory: "configuration" as const,
        rationale: "Raise the declared Node runtime to the verified target.",
        risk: "low" as const,
        confidence: 96,
      })]),
      verification: Object.freeze({
        passed: true as const,
        commandId: "verify:typecheck",
        summary: "The objective verification passed on the sealed candidate.",
        outputDigest: `sha256:${createHash("sha256").update("typecheck passed").digest("hex")}`,
      }),
      overallRisk: "low" as const,
      confidence: 96,
    }),
    env,
  };
}

describe("adaptive-candidate seal", () => {
  it("seals a converged candidate and reverifies its digest on read", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const seal = sealAdaptiveCandidate(baseInput(env));
    expect(seal.created).toBe(true);
    expect(seal.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);

    const artifact = readAdaptiveCandidateArtifact({
      tenantId: "tenant-a",
      path: seal.path,
      sha256: seal.sha256,
      env,
    });
    expect(artifact.kind).toBe("adaptive");
    expect(artifact.candidateDigest).toBe(recipeFilesDigest(CONVERGED_FILES));
    expect(artifact.divergedFromDigest).toBe(recipeFilesDigest(RECIPE_FILES));
    expect(artifact.adaptiveChangedPaths).toEqual(["package.json"]);
    expect(artifact.failingCommandId).toBe("verify:typecheck");
    expect(artifact.repositoryId).toBe("repo-1");
    expect(artifact.snapshotId).toBe("snapshot-1");
    expect(artifact.expectedBaseRevision).toBe("e".repeat(40));
    expect(artifact.baseBranch).toBe("main");
    expect(artifact.files).toEqual(CONVERGED_FILES);
    expect(artifact.fileModes["src/index.ts"]).toBe("100755");
    expect(artifact.schemaVersion).toBe(5);
    expect(artifact.review.edits[0]).toMatchObject({
      path: "package.json",
      beforeContent: RECIPE_FILES["package.json"],
      semanticCategory: "configuration",
      rationale: "Raise the declared Node runtime to the verified target.",
      risk: "low",
      confidence: 96,
    });
    expect(artifact.reviewDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifact.review.verification).toMatchObject({
      passed: true,
      commandId: "verify:typecheck",
    });
  });

  it("fails closed for legacy schema 4 seals without semantic review evidence", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const seal = sealAdaptiveCandidate(baseInput(env));
    const legacy = JSON.parse(readFileSync(seal.path, "utf8")) as Record<string, unknown>;
    legacy.schemaVersion = 4;
    delete legacy.review;
    delete legacy.reviewDigest;
    const serialized = JSON.stringify(legacy);
    writeFileSync(seal.path, serialized, "utf8");

    expect(() => readAdaptiveCandidateArtifact({
      tenantId: "tenant-a",
      path: seal.path,
      sha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
      env,
    })).toThrow("adaptive_candidate_review_evidence_missing");
  });

  it("rejects review evidence whose before bytes, modes, or after digest drift", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const input = baseInput(env);
    const edit = input.review.edits[0]!;
    expect(() => sealAdaptiveCandidate({
      ...input,
      review: { ...input.review, edits: [{ ...edit, beforeContent: "different\n" }] },
    })).toThrow("adaptive_candidate_review_before_digest_mismatch");
    expect(() => sealAdaptiveCandidate({
      ...input,
      review: { ...input.review, edits: [{ ...edit, beforeMode: "100755" }] },
    })).toThrow("adaptive_candidate_review_before_mode_invalid");
    expect(() => sealAdaptiveCandidate({
      ...input,
      review: { ...input.review, edits: [{ ...edit, afterDigest: edit.beforeDigest }] },
    })).toThrow("adaptive_candidate_review_after_digest_mismatch");
  });

  it("binds new executable files with an absent base into review evidence", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const files = { ...CONVERGED_FILES, "scripts/check.sh": "#!/bin/sh\nexit 0\n" };
    const input = baseInput(env);
    const review = {
      ...input.review,
      edits: [{
        path: "scripts/check.sh",
        changeType: "add" as const,
        beforeContent: null,
        beforeDigest: `sha256:${createHash("sha256").update("").digest("hex")}`,
        beforeMode: null,
        afterDigest: `sha256:${createHash("sha256").update(files["scripts/check.sh"]).digest("hex")}`,
        afterMode: "100755" as const,
        semanticCategory: "tests" as const,
        rationale: "Add the verified repository check entry point.",
        risk: "medium" as const,
        confidence: 90,
      }],
      overallRisk: "medium" as const,
      confidence: 90,
    };
    const seal = sealAdaptiveCandidate({
      ...input,
      files,
      fileModes: { ...input.fileModes, "scripts/check.sh": "100755" },
      changedPaths: ["scripts/check.sh"],
      candidateDigest: recipeFilesDigest(files),
      review,
    });
    expect(readAdaptiveCandidateArtifact({
      tenantId: "tenant-a",
      path: seal.path,
      sha256: seal.sha256,
      env,
    }).review.edits[0]).toMatchObject({
      changeType: "add",
      beforeContent: null,
      beforeMode: null,
      afterMode: "100755",
    });
  });

  it("fails closed for legacy schema 3 seals without authoritative file modes", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const seal = sealAdaptiveCandidate(baseInput(env));
    const legacy = JSON.parse(readFileSync(seal.path, "utf8")) as Record<string, unknown>;
    legacy.schemaVersion = 3;
    delete legacy.fileModes;
    const serialized = JSON.stringify(legacy);
    writeFileSync(seal.path, serialized, "utf8");

    expect(() => readAdaptiveCandidateArtifact({
      tenantId: "tenant-a",
      path: seal.path,
      sha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
      env,
    })).toThrow("adaptive_candidate_file_modes_missing");
  });

  it("rejects incomplete or unsupported file mode authority before sealing", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    expect(() => sealAdaptiveCandidate({
      ...baseInput(env),
      fileModes: { "package.json": "100644" },
    })).toThrow("recipe_file_modes_paths_mismatch");
    expect(() => sealAdaptiveCandidate({
      ...baseInput(env),
      fileModes: {
        "package.json": "100644",
        "src/index.ts": "120000" as "100644",
      },
    })).toThrow("recipe_file_mode_unsupported:src/index.ts");
  });

  it("binds file modes into the content addressed seal without changing the content digest", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const executable = sealAdaptiveCandidate(baseInput(env));
    const regular = sealAdaptiveCandidate({
      ...baseInput(env),
      fileModes: {
        "package.json": "100644",
        "src/index.ts": "100644",
      },
    });

    expect(regular.sha256).not.toBe(executable.sha256);
    expect(readAdaptiveCandidateArtifact({
      tenantId: "tenant-a",
      path: regular.path,
      sha256: regular.sha256,
      env,
    }).candidateDigest).toBe(readAdaptiveCandidateArtifact({
      tenantId: "tenant-a",
      path: executable.path,
      sha256: executable.sha256,
      env,
    }).candidateDigest);
  });

  it("is content-addressed and idempotent for the same converged output", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const first = sealAdaptiveCandidate(baseInput(env));
    const second = sealAdaptiveCandidate(baseInput(env));
    expect(second.sha256).toBe(first.sha256);
    expect(second.path).toBe(first.path);
    expect(second.created).toBe(false);
  });

  it("refuses to seal a candidate that does not diverge from the recipe output", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    expect(() =>
      sealAdaptiveCandidate({
        ...baseInput(env),
        divergedFromDigest: recipeFilesDigest(CONVERGED_FILES),
      }),
    ).toThrow("adaptive_candidate_not_divergent");
  });

  it("refuses to seal when the declared digest does not match the files", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    expect(() =>
      sealAdaptiveCandidate({
        ...baseInput(env),
        candidateDigest: recipeFilesDigest(RECIPE_FILES).replace(/.$/, "0"),
      }),
    ).toThrow();
  });

  it("rejects candidates that cannot fit the complete customer review envelope", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const oversizedFile = { "package.json": "x".repeat(256 * 1024 + 1) };
    expect(() => sealAdaptiveCandidate({
      ...baseInput(env),
      files: oversizedFile,
      changedPaths: ["package.json"],
      fileModes: { "package.json": "100644" },
      candidateDigest: recipeFilesDigest(oversizedFile),
    })).toThrow("adaptive_candidate_file_too_large");

    const oversizedTotal = {
      "a.txt": "a".repeat(256 * 1024),
      "b.txt": "b".repeat(256 * 1024),
      "c.txt": "c",
    };
    expect(() => sealAdaptiveCandidate({
      ...baseInput(env),
      files: oversizedTotal,
      changedPaths: Object.keys(oversizedTotal),
      fileModes: { "a.txt": "100644", "b.txt": "100644", "c.txt": "100644" },
      candidateDigest: recipeFilesDigest(oversizedTotal),
    })).toThrow("adaptive_candidate_too_large");
  });

  it("promotion reads only the sealed artifact; later mutation of the source does not change it", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const mutableFiles: Record<string, string> = { ...CONVERGED_FILES };
    const seal = sealAdaptiveCandidate({
      ...baseInput(env),
      files: mutableFiles,
      candidateDigest: recipeFilesDigest(mutableFiles),
    });
    // Mutate the in-memory source AFTER sealing; the seal must be unaffected.
    mutableFiles["package.json"] = "tampered\n";
    const promoted = promoteAdaptiveCandidateFiles({
      tenantId: "tenant-a",
      path: seal.path,
      sha256: seal.sha256,
      env,
    });
    expect(promoted.files).toEqual(CONVERGED_FILES);
    expect(promoted.candidateDigest).toBe(recipeFilesDigest(CONVERGED_FILES));
  });

  it("fails closed when the sealed artifact bytes are tampered with", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const seal = sealAdaptiveCandidate(baseInput(env));
    const tampered = JSON.parse(readFileSync(seal.path, "utf8")) as Record<string, unknown>;
    (tampered.files as Record<string, string>)["package.json"] =
      Buffer.from("malicious\n", "utf8").toString("base64");
    writeFileSync(seal.path, JSON.stringify(tampered));
    expect(() =>
      readAdaptiveCandidateArtifact({
        tenantId: "tenant-a",
        path: seal.path,
        sha256: seal.sha256,
        env,
      }),
    ).toThrow("adaptive_candidate_seal_digest_mismatch");
  });

  it("fails closed on corrupt (non-JSON) stored state", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const seal = sealAdaptiveCandidate(baseInput(env));
    writeFileSync(seal.path, "not json at all");
    expect(() =>
      readAdaptiveCandidateArtifact({
        tenantId: "tenant-a",
        path: seal.path,
        sha256: seal.sha256,
        env,
      }),
    ).toThrow("adaptive_candidate_seal_digest_mismatch");
  });

  it("isolates tenants: a seal cannot be read under a different tenant", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const seal = sealAdaptiveCandidate(baseInput(env));
    expect(() =>
      readAdaptiveCandidateArtifact({
        tenantId: "tenant-b",
        path: seal.path,
        sha256: seal.sha256,
        env,
      }),
    ).toThrow();
  });

  it("discards the sealed artifact on rejection cleanup", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const seal = sealAdaptiveCandidate(baseInput(env));
    discardAdaptiveCandidate({ tenantId: "tenant-a", path: seal.path, sha256: seal.sha256, env });
    expect(() =>
      readAdaptiveCandidateArtifact({
        tenantId: "tenant-a",
        path: seal.path,
        sha256: seal.sha256,
        env,
      }),
    ).toThrow("adaptive_candidate_seal_missing");
  });

  it("enforces tenant artifact count quota without rejecting idempotent reseals", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const quota = { maxArtifacts: 1, maxBytes: 1024 * 1024, maxScanEntries: 8 };
    const first = sealAdaptiveCandidate({ ...baseInput(env), quota });
    const replay = sealAdaptiveCandidate({ ...baseInput(env), quota });

    expect(replay).toMatchObject({ path: first.path, sha256: first.sha256, created: false });
    expect(() => sealAdaptiveCandidate({
      ...baseInput(env),
      attemptId: "tfattempt_other",
      quota,
    })).toThrow("adaptive_candidate_quota_count_exceeded");
  });

  it("enforces tenant byte quota against the prospective serialized seal", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const first = sealAdaptiveCandidate(baseInput(env));
    const existingBytes = lstatSync(first.path).size;

    expect(() => sealAdaptiveCandidate({
      ...baseInput(env),
      attemptId: "tfattempt_other",
      quota: { maxArtifacts: 8, maxBytes: existingBytes, maxScanEntries: 8 },
    })).toThrow("adaptive_candidate_quota_bytes_exceeded");
  });

  it("requires an explicit offline-maintenance acknowledgement before reconciliation", () => {
    expect(() => reconcileAdaptiveCandidateArtifacts({
      offlineMaintenance: false,
      tenantId: "tenant-a",
      referencedSealedPaths: [],
    } as unknown as Parameters<typeof reconcileAdaptiveCandidateArtifacts>[0])).toThrow(
      "adaptive_candidate_reconcile_offline_acknowledgement_required",
    );
  });

  it("retains an old seal when its exact path is referenced by durable state", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const active = sealAdaptiveCandidate(baseInput(env));
    utimesSync(active.path, new Date(1_000), new Date(1_000));

    const result = reconcileAdaptiveCandidateArtifacts({
      offlineMaintenance: true,
      tenantId: "tenant-a",
      referencedSealedPaths: [active.path],
      env,
      nowMs: 100_000,
      bounds: { gracePeriodMs: 1_000, maxScanEntries: 8, maxRemovals: 8, maxRemovalBytes: 1024 * 1024 },
    });

    expect(existsSync(active.path)).toBe(true);
    expect(result).toMatchObject({
      scannedArtifacts: 1,
      referencedArtifacts: 1,
      orphanArtifacts: 0,
      removedArtifacts: 0,
      removedBytes: 0,
      errors: [],
    });
  });

  it("retains an unreferenced seal until the grace period expires", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const recent = sealAdaptiveCandidate(baseInput(env));
    utimesSync(recent.path, new Date(99_500), new Date(99_500));

    const result = reconcileAdaptiveCandidateArtifacts({
      offlineMaintenance: true,
      tenantId: "tenant-a",
      referencedSealedPaths: [],
      env,
      nowMs: 100_000,
      bounds: { gracePeriodMs: 1_000, maxScanEntries: 8, maxRemovals: 8, maxRemovalBytes: 1024 * 1024 },
    });

    expect(existsSync(recent.path)).toBe(true);
    expect(result).toMatchObject({
      orphanArtifacts: 1,
      graceRetainedArtifacts: 1,
      removedArtifacts: 0,
      removedBytes: 0,
      errors: [],
    });
  });

  it("removes only expired orphan seals and preserves the approvals directory", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const active = sealAdaptiveCandidate(baseInput(env));
    const orphan = sealAdaptiveCandidate({ ...baseInput(env), attemptId: "tfattempt_orphan" });
    utimesSync(active.path, new Date(1_000), new Date(1_000));
    utimesSync(orphan.path, new Date(1_000), new Date(1_000));
    const orphanBytes = lstatSync(orphan.path).size;
    const approvalsDir = join(env.MENDPOINT_DATA_DIR!, "transformer-adaptive-candidates", "tenant-a", "approvals");

    const result = reconcileAdaptiveCandidateArtifacts({
      offlineMaintenance: true,
      tenantId: "tenant-a",
      referencedSealedPaths: [active.path],
      env,
      nowMs: 100_000,
      bounds: { gracePeriodMs: 1_000, maxScanEntries: 8, maxRemovals: 8, maxRemovalBytes: 1024 * 1024 },
    });

    expect(existsSync(active.path)).toBe(true);
    expect(existsSync(orphan.path)).toBe(false);
    expect(existsSync(approvalsDir)).toBe(true);
    expect(result).toMatchObject({
      scannedArtifacts: 2,
      referencedArtifacts: 1,
      orphanArtifacts: 1,
      removedArtifacts: 1,
      removedBytes: orphanBytes,
      errors: [],
    });
  });

  it("never follows or removes a linked entry during reconciliation", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const orphan = sealAdaptiveCandidate(baseInput(env));
    utimesSync(orphan.path, new Date(1_000), new Date(1_000));
    const approvalsDir = join(env.MENDPOINT_DATA_DIR!, "transformer-adaptive-candidates", "tenant-a", "approvals");
    const outside = dataDir();
    const outsideFile = join(outside, "keep.txt");
    writeFileSync(outsideFile, "keep");
    const linked = join(approvalsDir, "linked-artifacts");
    symlinkSync(outside, linked, "junction");

    const result = reconcileAdaptiveCandidateArtifacts({
      offlineMaintenance: true,
      tenantId: "tenant-a",
      referencedSealedPaths: [],
      env,
      nowMs: 100_000,
      bounds: { gracePeriodMs: 1_000, maxScanEntries: 8, maxRemovals: 8, maxRemovalBytes: 1024 * 1024 },
    });

    expect(existsSync(orphan.path)).toBe(false);
    expect(existsSync(linked)).toBe(true);
    expect(readFileSync(outsideFile, "utf8")).toBe("keep");
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: linked, code: "adaptive_candidate_reconcile_symlink" }),
    ]));
  });

  it("bounds cleanup work and reports expired artifacts left for a later run", () => {
    const env = { MENDPOINT_DATA_DIR: dataDir() } as NodeJS.ProcessEnv;
    const first = sealAdaptiveCandidate(baseInput(env));
    const second = sealAdaptiveCandidate({ ...baseInput(env), attemptId: "tfattempt_second" });
    utimesSync(first.path, new Date(1_000), new Date(1_000));
    utimesSync(second.path, new Date(1_000), new Date(1_000));

    const result = reconcileAdaptiveCandidateArtifacts({
      offlineMaintenance: true,
      tenantId: "tenant-a",
      referencedSealedPaths: [],
      env,
      nowMs: 100_000,
      bounds: { gracePeriodMs: 1_000, maxScanEntries: 8, maxRemovals: 1, maxRemovalBytes: 1024 * 1024 },
    });

    expect(result).toMatchObject({
      scannedArtifacts: 2,
      orphanArtifacts: 2,
      removedArtifacts: 1,
      limitRetainedArtifacts: 1,
    });
    expect([existsSync(first.path), existsSync(second.path)].filter(Boolean)).toHaveLength(1);
  });
});
