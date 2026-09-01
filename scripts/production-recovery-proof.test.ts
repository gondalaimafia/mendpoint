import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openChangeSourceStore } from "@mendpoint/change-intel";
import { createDb } from "@mendpoint/db";
import { openGraphLearnDb } from "@mendpoint/graph-learn";
import {
  CORE_DISASTER_RECOVERY_POLICY,
  createBackupBundle,
  createObjectBackupRecoveryReceipt,
  type ObjectBackupRecoveryReceipt,
  type RecoveryResourceKind,
} from "@mendpoint/ops";
import {
  TransformerControlPlaneStore,
  TransformerPilotExecutionStore,
} from "@mendpoint/transformer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertRestoredTreeMatchesRestore,
  main,
  RECOVERY_PROOF_ENV_NAMES,
  runProductionRecoveryProof,
  safeFailureCode,
  type ProductionRecoveryProofInput,
  type RecoverySemanticCanary,
} from "./production-recovery-proof.js";

const KEY = Buffer.alloc(32, 17);
const KEY_ID = "recovery-key-2026-08";
const CREATED_AT = "2026-08-30T11:59:00.000Z";
const STARTED_AT = "2026-08-30T12:00:00.000Z";
const REVISION = "1".repeat(40);
// Reserved-TLD host: an accidental real request from a test cannot resolve.
const VERSION_URL = "https://recovery-proof-target.invalid/version";
const roots: string[] = [];

type Fixture = ReturnType<typeof fixture>;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function makeCurrentResources(sourceRoot: string): Record<RecoveryResourceKind, string> {
  mkdirSync(sourceRoot, { recursive: true });
  const database = createDb(join(sourceRoot, "mendpoint.sqlite"));
  database.raw.close();

  const graph = openGraphLearnDb(join(sourceRoot, "graph-learn.sqlite"));
  graph.raw.close();

  const changes = openChangeSourceStore(join(sourceRoot, "change-sources.sqlite"));
  changes.close();
  const control = new TransformerControlPlaneStore(join(sourceRoot, "transformer-control-plane.sqlite"));
  control.close();
  const pilot = new TransformerPilotExecutionStore(join(sourceRoot, "transformer-pilot.sqlite"));
  pilot.close();

  for (const name of [
    "transformer-candidates",
    "transformer-evidence",
    "warden-candidates",
    "warden-evidence",
  ]) {
    const root = join(sourceRoot, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "canary.json"), `${JSON.stringify({ name })}\n`, "utf8");
  }
  writeFileSync(
    join(sourceRoot, "recovery-config.json"),
    `${JSON.stringify({ deployment: "customer", tenant: "tenant-a" })}\n`,
    "utf8",
  );
  return {
    artifacts: ".",
    changeSources: "change-sources.sqlite",
    configuration: "recovery-config.json",
    database: "mendpoint.sqlite",
    graph: "graph-learn.sqlite",
    transformerControlPlane: "transformer-control-plane.sqlite",
    transformerPilot: "transformer-pilot.sqlite",
  };
}

function fixture(options: { createdAt?: string; unsupportedChangeSchema?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-production-recovery-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const publishedRoot = join(root, "published", "backup-a");
  mkdirSync(join(root, "published"), { recursive: true });
  const resources = makeCurrentResources(sourceRoot);
  if (options.unsupportedChangeSchema) {
    const raw = new DatabaseSync(join(sourceRoot, resources.changeSources));
    raw.prepare("UPDATE change_source_schema_migrations SET version = 99").run();
    raw.close();
  }
  const manifest = createBackupBundle({
    policy: CORE_DISASTER_RECOVERY_POLICY,
    backupId: "backup-a",
    createdAt: options.createdAt ?? CREATED_AT,
    sourceRoot,
    backupRoot: publishedRoot,
    resources,
    key: KEY,
    keyId: KEY_ID,
  });
  const manifestBytes = readFileSync(join(publishedRoot, "manifest.json"));
  const publication = Object.freeze({
    kind: "s3" as const,
    backupId: manifest.backupId,
    bucket: "mendpoint-production-backups",
    prefix: `backups/tenant-a/${manifest.backupId}`,
    endpointOrigin: "https://fly.storage.tigris.dev",
    commitDigest: "a".repeat(64),
    manifestSha256: sha256(manifestBytes),
  });
  const receipt = createObjectBackupRecoveryReceipt({
    backupId: manifest.backupId,
    keyId: KEY_ID,
    verifiedAt: "2026-08-30T11:59:30.000Z",
    manifestAuthentication: manifest.integrity.digest,
    publication,
  }, KEY);
  const input: ProductionRecoveryProofInput = {
    proofId: "proof-a",
    tenantId: "tenant-a",
    environment: "synthetic",
    key: KEY,
    keyId: KEY_ID,
    receipt,
    expectedPublication: {
      bucket: publication.bucket,
      prefix: publication.prefix,
      endpointOrigin: publication.endpointOrigin,
    },
    evidencePath: join(root, "evidence", "proof.json"),
    backupRoot: join(root, "staging", "backup-a"),
    targetRoot: join(root, "targets", "restored"),
    rollbackRoot: join(root, "targets", "rollback"),
    dataRoot: join(root, "live-data"),
    sourceRoot,
    fenceRoot: join(root, "fence"),
    repositoryRevision: REVISION,
    expectedDeployedRevision: REVISION,
    sourceRegion: "ord",
    recoveryRegion: "sjc",
    startedAt: STARTED_AT,
  };
  mkdirSync(input.dataRoot, { recursive: true });
  const download = vi.fn(async ({ destination }: { destination: string }) => {
    cpSync(publishedRoot, destination, { recursive: true, errorOnExist: true, force: false });
    return destination;
  });
  return { root, sourceRoot, publishedRoot, manifest, receipt, input, download };
}

function dependencies(run: Fixture, overrides: Record<string, unknown> = {}) {
  let tick = 0;
  return {
    downloadBackup: run.download,
    now: () => Date.parse(STARTED_AT),
    monotonic: () => tick++ === 0 ? 0 : 500,
    ...overrides,
  } as Parameters<typeof runProductionRecoveryProof>[1];
}

function allCanaries(): readonly RecoverySemanticCanary[] {
  return ([
    "artifacts",
    "changeSources",
    "configuration",
    "database",
    "graph",
    "transformerControlPlane",
    "transformerPilot",
  ] satisfies RecoveryResourceKind[]).map((kind) => ({
    kind,
    status: "passed" as const,
    identitySha256: "b".repeat(64),
    detail: Object.freeze({ tested: 1 }),
  }));
}

describe("production recovery qualification", () => {
  it("runs the vertical tracer through authenticated restore, current migrations, canaries, and rollback", async () => {
    const run = fixture();
    const proof = await runProductionRecoveryProof(run.input, dependencies(run));

    expect(proof).toMatchObject({
      schemaVersion: 1,
      proofId: "proof-a",
      tenantId: "tenant-a",
      state: "passed",
      environment: "synthetic",
      revisions: {
        repository: REVISION,
        deployed: { state: "not_observed", expected: REVISION, reason: "non_production_environment" },
      },
      regionalFailure: { sourceRegion: "ord", recoveryRegion: "sjc", productionProven: false },
      externalProof: { state: "pending_external_observation", productionProven: false },
      rollback: { verified: true },
      objectives: { rtoMet: true, rpoMet: true },
    });
    expect(proof.resources).toHaveLength(7);
    expect(proof.schemaConvergence).toHaveLength(7);
    expect(proof.canaries).toHaveLength(7);
    expect(proof.rollback.restoredDigest).toBe(proof.rollback.expectedDigest);
    expect(proof.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(run.input.targetRoot)).toBe(true);
    expect(run.download).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("authenticates an exact completed replay without another download, restore, or migration", async () => {
    const run = fixture();
    const converge = vi.fn();
    const canaries = vi.fn(() => allCanaries());
    const first = await runProductionRecoveryProof(run.input, dependencies(run, {
      convergeStores: converge,
      runCanaries: canaries,
    }));
    const replayDownload = vi.fn(async () => { throw new Error("must_not_download"); });
    const replayConverge = vi.fn(() => { throw new Error("must_not_migrate"); });
    const second = await runProductionRecoveryProof(run.input, {
      downloadBackup: replayDownload,
      convergeStores: replayConverge,
    });

    expect(second).toEqual(first);
    expect(run.download).toHaveBeenCalledTimes(1);
    expect(converge).toHaveBeenCalledTimes(1);
    expect(canaries).toHaveBeenCalledTimes(1);
    expect(replayDownload).not.toHaveBeenCalled();
    expect(replayConverge).not.toHaveBeenCalled();
  }, 120_000);

  it("rejects replay under a different tenant before any external work", async () => {
    const run = fixture();
    await runProductionRecoveryProof(run.input, dependencies(run));
    const replayDownload = vi.fn();
    await expect(runProductionRecoveryProof({ ...run.input, tenantId: "tenant-b" }, {
      downloadBackup: replayDownload,
    })).rejects.toThrow("production_recovery_replay_binding_mismatch");
    expect(replayDownload).not.toHaveBeenCalled();
  }, 120_000);

  it("rejects a tampered receipt before download", async () => {
    const run = fixture();
    const receipt = {
      ...run.receipt,
      verifiedAt: "2026-08-30T11:58:00.000Z",
    } as ObjectBackupRecoveryReceipt;
    await expect(runProductionRecoveryProof({ ...run.input, receipt }, dependencies(run)))
      .rejects.toThrow("production_recovery_receipt_invalid");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("rejects an authenticated receipt under the wrong object locator", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof({
      ...run.input,
      expectedPublication: { ...run.input.expectedPublication, bucket: "other-bucket" },
    }, dependencies(run))).rejects.toThrow("production_recovery_publication_binding_mismatch");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("retains a failed dependency observation and will not retry it as passing", async () => {
    const run = fixture();
    const failedDownload = vi.fn(async () => { throw new Error("production_recovery_object_store_unavailable"); });
    await expect(runProductionRecoveryProof(run.input, dependencies(run, {
      downloadBackup: failedDownload,
    }))).rejects.toThrow("production_recovery_object_store_unavailable");
    const persisted = JSON.parse(readFileSync(run.input.evidencePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ state: "failed", externalProof: { productionProven: false } });

    const healthyDownload = vi.fn();
    await expect(runProductionRecoveryProof(run.input, { downloadBackup: healthyDownload }))
      .rejects.toThrow("production_recovery_prior_failure_retained");
    expect(healthyDownload).not.toHaveBeenCalled();
  }, 120_000);

  it("fails closed when the downloaded object bundle is tampered", async () => {
    const run = fixture();
    const tamperingDownload = vi.fn(async ({ destination }: { destination: string }) => {
      cpSync(run.publishedRoot, destination, { recursive: true });
      writeFileSync(join(destination, "manifest.json"), "{}\n", "utf8");
      return destination;
    });
    await expect(runProductionRecoveryProof(run.input, dependencies(run, {
      downloadBackup: tamperingDownload,
    }))).rejects.toThrow("backup_integrity_failed");
    expect(JSON.parse(readFileSync(run.input.evidencePath, "utf8"))).toMatchObject({ state: "failed" });
  }, 120_000);

  it("rejects a partial restore target rather than resuming into it", async () => {
    const run = fixture();
    mkdirSync(run.input.targetRoot, { recursive: true });
    writeFileSync(join(run.input.targetRoot, "partial"), "partial", "utf8");
    await expect(runProductionRecoveryProof(run.input, dependencies(run)))
      .rejects.toThrow("production_recovery_target_not_empty");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("rejects a target that overlaps live data", async () => {
    const run = fixture();
    const targetRoot = join(run.input.dataRoot, "restore");
    await expect(runProductionRecoveryProof({
      ...run.input,
      targetRoot,
      rollbackRoot: join(run.input.dataRoot, "rollback"),
    }, dependencies(run))).rejects.toThrow("customer_restore_target_data_overlap");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("rejects a filesystem redirect in the isolated target path", async () => {
    const run = fixture();
    const actual = join(run.root, "actual-target-parent");
    const redirect = join(run.root, "redirect-target-parent");
    mkdirSync(actual, { recursive: true });
    symlinkSync(actual, redirect, process.platform === "win32" ? "junction" : "dir");
    await expect(runProductionRecoveryProof({
      ...run.input,
      targetRoot: join(redirect, "restored"),
    }, dependencies(run))).rejects.toThrow("customer_restore_target_filesystem_redirect_rejected");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("rejects an existing unauthenticated output instead of overwriting it", async () => {
    const run = fixture();
    mkdirSync(join(run.root, "evidence"), { recursive: true });
    writeFileSync(run.input.evidencePath, "{}\n", "utf8");
    await expect(runProductionRecoveryProof(run.input, dependencies(run)))
      .rejects.toThrow("production_recovery_existing_evidence_invalid");
    expect(readFileSync(run.input.evidencePath, "utf8")).toBe("{}\n");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("fails closed on an unsupported prior schema", async () => {
    const run = fixture({ unsupportedChangeSchema: true });
    await expect(runProductionRecoveryProof(run.input, dependencies(run)))
      .rejects.toThrow("change_source_schema_newer_than_runtime");
    expect(JSON.parse(readFileSync(run.input.evidencePath, "utf8"))).toMatchObject({ state: "failed" });
  }, 120_000);

  it("retains migration failure without publishing passing evidence", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof(run.input, dependencies(run, {
      convergeStores: () => { throw new Error("production_recovery_migration_failed"); },
    }))).rejects.toThrow("production_recovery_migration_failed");
    expect(JSON.parse(readFileSync(run.input.evidencePath, "utf8"))).toMatchObject({
      state: "failed",
      failure: { code: "production_recovery_migration_failed" },
    });
  }, 120_000);

  it("rejects a partial semantic canary matrix", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof(run.input, dependencies(run, {
      convergeStores: () => undefined,
      runCanaries: () => allCanaries().slice(0, 6),
    }))).rejects.toThrow("production_recovery_canary_matrix_incomplete");
  }, 120_000);

  it("fails closed when rollback does not restore the exact digest", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof(run.input, dependencies(run, {
      convergeStores: () => undefined,
      runCanaries: () => allCanaries(),
      rollback: (targetRoot: string) => {
        rmSync(targetRoot, { recursive: true, force: true });
        mkdirSync(targetRoot, { recursive: true });
        writeFileSync(join(targetRoot, "wrong"), "wrong", "utf8");
      },
    }))).rejects.toThrow("production_recovery_rollback_integrity_failed");
  }, 120_000);

  it("fails closed when the measured recovery time misses the objective", async () => {
    const run = fixture();
    let tick = 0;
    await expect(runProductionRecoveryProof(run.input, dependencies(run, {
      convergeStores: () => undefined,
      runCanaries: () => allCanaries(),
      monotonic: () => tick++ === 0 ? 0 : (CORE_DISASTER_RECOVERY_POLICY.rtoSeconds + 1) * 1000,
    }))).rejects.toThrow("production_recovery_rto_missed");
  }, 120_000);

  it("fails closed when the authenticated recovery point misses the objective", async () => {
    const run = fixture({ createdAt: "2026-08-30T10:00:00.000Z" });
    await expect(runProductionRecoveryProof(run.input, dependencies(run, {
      convergeStores: () => undefined,
      runCanaries: () => allCanaries(),
    }))).rejects.toThrow("production_recovery_rpo_missed");
  }, 120_000);

  it("requires the exact deployed revision for a production-targeted run", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof({
      ...run.input,
      environment: "production",
      expectedDeployedRevision: "2".repeat(40),
      deployedRevisionSource: VERSION_URL,
    }, dependencies(run))).rejects.toThrow("production_recovery_revision_mismatch");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it.each(["local", "synthetic", "production"] as const)(
    "keeps %s evidence below the external production proof boundary",
    async (environment) => {
      const run = fixture();
      const proof = await runProductionRecoveryProof({
        ...run.input,
        environment,
        deployedRevisionSource: VERSION_URL,
      }, dependencies(run, {
        convergeStores: () => undefined,
        runCanaries: () => allCanaries(),
        observeDeployedRevision: async () => REVISION,
      }));
      expect(proof.externalProof).toMatchObject({
        state: "pending_external_observation",
        productionProven: false,
      });
      expect(proof.regionalFailure.productionProven).toBe(false);
    },
    120_000,
  );

  it("binds a production proof to the revision the target is actually serving", async () => {
    const run = fixture();
    const observe = vi.fn(async () => REVISION);
    const proof = await runProductionRecoveryProof({
      ...run.input,
      environment: "production",
      deployedRevisionSource: VERSION_URL,
    }, dependencies(run, { observeDeployedRevision: observe }));

    expect(observe).toHaveBeenCalledWith(VERSION_URL);
    expect(proof.revisions.deployed).toEqual({
      state: "observed",
      expected: REVISION,
      observed: REVISION,
      observedFrom: VERSION_URL,
    });
  }, 120_000);

  it("refuses a production proof when the target serves a different revision", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof({
      ...run.input,
      environment: "production",
      deployedRevisionSource: VERSION_URL,
    }, dependencies(run, {
      observeDeployedRevision: async () => "3".repeat(40),
    }))).rejects.toThrow("production_recovery_deployed_revision_mismatch");
    // The operator-supplied expectation still matches itself; only the
    // observation of the running target can reject this run.
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("fails closed when the deployed revision cannot be observed", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof({
      ...run.input,
      environment: "production",
      deployedRevisionSource: VERSION_URL,
    }, dependencies(run, {
      observeDeployedRevision: async () => { throw new Error("production_recovery_deployed_revision_unreachable"); },
    }))).rejects.toThrow("production_recovery_deployed_revision_unreachable");

    const retained = JSON.parse(readFileSync(run.input.evidencePath, "utf8")) as {
      state: string;
      revisions: { deployed: { state: string; reason?: string } };
    };
    expect(retained.state).toBe("failed");
    expect(retained.revisions.deployed).toEqual({
      state: "not_observed",
      expected: REVISION,
      reason: "observation_not_reached",
    });
  }, 120_000);

  it("rejects a production run with no observation endpoint to read", async () => {
    const run = fixture();
    await expect(runProductionRecoveryProof({
      ...run.input,
      environment: "production",
      deployedRevisionSource: undefined,
    }, dependencies(run))).rejects.toThrow("production_recovery_deployed_revision_source_invalid");
    await expect(runProductionRecoveryProof({
      ...run.input,
      environment: "production",
      deployedRevisionSource: "http://recovery-proof-target.invalid/version",
    }, dependencies(run))).rejects.toThrow("production_recovery_deployed_revision_source_invalid");
    expect(run.download).not.toHaveBeenCalled();
  }, 120_000);

  it("names the restored-tree guard rather than trusting the restore's own digest", () => {
    const digest = "c".repeat(64);
    expect(() => assertRestoredTreeMatchesRestore(digest, digest)).not.toThrow();
    expect(() => assertRestoredTreeMatchesRestore(digest, "d".repeat(64)))
      .toThrow("production_recovery_restore_digest_mismatch");
    expect(() => assertRestoredTreeMatchesRestore(digest, "not-a-digest"))
      .toThrow("production_recovery_restore_digest_mismatch");
  });

  it("echoes only known failure codes, never opaque material", () => {
    // The defect this replaced: 64 hex characters satisfy a lowercase
    // alphanumeric charset, so a digest or a key would have been echoed verbatim.
    expect(safeFailureCode(new Error("a".repeat(64)))).toBe("production_recovery_dependency_failed");
    expect(safeFailureCode(new Error("Zm9vYmFyYmF6cXV4"))).toBe("production_recovery_dependency_failed");
    expect(safeFailureCode(new Error("sqlite_integrity_check_failed")))
      .toBe("production_recovery_dependency_failed");
    expect(safeFailureCode(new Error("production_recovery_rto_missed"))).toBe("production_recovery_rto_missed");
    expect(safeFailureCode(new Error("customer_backup_aws_access_key_required")))
      .toBe("customer_backup_aws_access_key_required");
    expect(safeFailureCode(new Error("mendpoint_recovery_proof_id_required")))
      .toBe("mendpoint_recovery_proof_id_required");
    expect(safeFailureCode(new Error("production_recovery_receipt_invalid:receipt_digest_mismatch")))
      .toBe("production_recovery_receipt_invalid:receipt_digest_mismatch");
    // A known code carrying an unprintable detail keeps the code, drops the detail.
    expect(safeFailureCode(new Error("production_recovery_receipt_invalid:/srv/mendpoint/data key=abc")))
      .toBe("production_recovery_receipt_invalid");
    expect(safeFailureCode("not an error")).toBe("production_recovery_dependency_failed");
  });
});

describe("production recovery qualification caller", () => {
  const ENV_KEYS = [
    "MENDPOINT_DEPLOYMENT_PROFILE",
    "MENDPOINT_BACKUP_KEY",
    "MENDPOINT_BACKUP_KEY_ID",
    ...RECOVERY_PROOF_ENV_NAMES,
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("refuses to run outside the customer deployment profile", async () => {
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "demo";
    await expect(main()).rejects.toThrow("production_recovery_customer_profile_required");
  });

  it("names the first missing operator variable instead of reaching the object store", async () => {
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "customer";
    // Obviously synthetic key material: a constant byte, never a real key.
    process.env.MENDPOINT_BACKUP_KEY = Buffer.alloc(32, 3).toString("base64url");
    await expect(main()).rejects.toThrow("mendpoint_backup_key_id_required");

    process.env.MENDPOINT_BACKUP_KEY_ID = KEY_ID;
    await expect(main()).rejects.toThrow("mendpoint_recovery_backup_id_required");
  });

  it("declares every environment name it reads", () => {
    const source = readFileSync(new URL("./production-recovery-proof.ts", import.meta.url), "utf8");
    const read = new Set(
      [...source.matchAll(/requiredEnv\("(MENDPOINT_[A-Z0-9_]+)"\)/g)].map((match) => match[1]!),
    );
    expect([...read].sort()).toEqual([...RECOVERY_PROOF_ENV_NAMES].sort());

    const manifest = JSON.parse(
      readFileSync(new URL("../config/required-configuration.json", import.meta.url), "utf8"),
    ) as { runtimeEntries: { name: string }[] };
    const declared = new Set(manifest.runtimeEntries.map((entry) => entry.name));
    for (const name of RECOVERY_PROOF_ENV_NAMES) expect(declared.has(name)).toBe(true);
  });
});
