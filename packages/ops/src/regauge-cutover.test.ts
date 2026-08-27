import {
  createHmac,
} from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { REGAUGE_MISSION_EVIDENCE_MAX_BYTES } from "@mendpoint/shared";
import {
  REGAUGE_TRANSFER_DATABASES,
  acquireRegaugeCutoverFence,
  createRegaugeStateTransfer,
  inspectRegaugeCutoverFence,
  inspectRegaugeLedgerTips,
  restoreRegaugeStateTransfer,
  verifyRegaugeStateTransfer,
  verifyRestoredRegaugeState,
  type RegaugeTransferBindings,
} from "./regauge-cutover.js";
import { isBackupFenceActive, tryAcquireMutationLease } from "./disaster-recovery.js";

const KEY = Buffer.alloc(32, 0x31);
const WRONG_KEY = Buffer.alloc(32, 0x41);
const roots: string[] = [];
const LEGACY_SCOPE = [
  `tenant-${"1".repeat(32)}`,
  `campaign-${"2".repeat(32)}`,
  `unit-${"3".repeat(32)}`,
  `attempt-${"4".repeat(32)}`,
] as const;
const LEGACY_EXECUTION_FILE = `tre_execution_${"a".repeat(64)}.json`;

const BINDINGS: RegaugeTransferBindings = Object.freeze({
  tenantId: "tenant_regauge_canary",
  campaignId: "campaign_regauge_canary_20260814",
  sourceApp: "mendpoint-transformer-pilot",
  sourceVolume: "vol_source",
  sourceRevision: "revision-source-123",
  targetApp: "mendpoint-regauge-production",
  targetVolume: "vol_target",
  objectBucket: "regauge-private-checkpoints",
  objectPrefix: "cutovers/cutover-001",
  transferKeyId: "regauge-transfer-key-2026-08",
  applicationDataKeyId: "regauge-data-key-2026-08",
  checkpointKeyId: "regauge-checkpoint-key-2026-08",
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDatabase(path: string, kind: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE parent (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
      INSERT INTO parent VALUES (1, '${kind}');
      INSERT INTO child VALUES (1, 1);
    `);
    if (kind === "main") {
      db.exec(`
        CREATE TABLE domain_events (
          id TEXT PRIMARY KEY, event_sequence INTEGER NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL
        );
        INSERT INTO domain_events VALUES ('event-1', 1, 'mission.created', '{}');
      `);
    }
    if (kind === "control") {
      db.exec(`
        CREATE TABLE tf_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL
        );
        INSERT INTO tf_events (id, type, payload) VALUES ('event-1', 'campaign.created', '{}');
      `);
    }
    if (kind === "pilot") {
      db.exec(`
        CREATE TABLE tf_pilot_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE TABLE tf_pilot_delivery_claim_results (
          tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, lease_json TEXT NOT NULL,
          PRIMARY KEY (tenant_id, idempotency_key)
        );
        INSERT INTO tf_pilot_events (type, payload_json) VALUES ('attempt.completed_with_checkpoint', '{}');
      `);
    }
  } finally { db.close(); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-regauge-cutover-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot);
  createDatabase(join(sourceRoot, "mendpoint.sqlite"), "main");
  createDatabase(join(sourceRoot, "change-sources.sqlite"), "changes");
  createDatabase(join(sourceRoot, "transformer-control-plane.sqlite"), "control");
  createDatabase(join(sourceRoot, "transformer-pilot.sqlite"), "pilot");
  const candidate = join(sourceRoot, "transformer-candidates", ...LEGACY_SCOPE);
  const evidence = join(sourceRoot, "transformer-evidence", ...LEGACY_SCOPE);
  mkdirSync(candidate, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(candidate, "manifest.json"), '{"kind":"transformer.candidate"}');
  mkdirSync(join(candidate, "files"));
  writeFileSync(join(candidate, "files", "patch.ts"), "not required by legacy adoption");
  writeFileSync(join(candidate, "files", "manifest.json"), "not an adoption manifest");
  writeFileSync(join(evidence, LEGACY_EXECUTION_FILE), '{"kind":"transformer.recipe.execution"}');
  writeFileSync(join(evidence, "unrelated.json"), "not required by legacy adoption");
  return {
    root,
    sourceRoot,
    bundleRoot: join(root, "bundle"),
    targetRoot: join(root, "target"),
  };
}

function transfer(
  fx: ReturnType<typeof fixture>,
  transferId = "cutover-001",
  fenceId = "fence-old-worker-quiesced",
) {
  const fenceRoot = join(fx.root, "cutover-fence");
  if (!existsSync(join(fenceRoot, "regauge-cutover-fence.v1.json"))) {
    acquireRegaugeCutoverFence({
      fenceRoot,
      fenceId,
      transferId,
      createdAt: "2026-08-25T11:59:00.000Z",
      sourceApp: BINDINGS.sourceApp,
      sourceVolume: BINDINGS.sourceVolume,
      transferKeyId: BINDINGS.transferKeyId,
      transferKey: KEY,
    });
  }
  return createRegaugeStateTransfer({
    transferId,
    createdAt: "2026-08-25T12:00:00.000Z",
    sourceRoot: fx.sourceRoot,
    bundleRoot: fx.bundleRoot,
    bindings: BINDINGS,
    transferKey: KEY,
    fenceRoot,
    fenceId,
  });
}

function canonicalFixture(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalFixture(record[key])}`).join(",")}}`;
}

function rewriteBundleAsAuthenticatedV1(fx: ReturnType<typeof fixture>): void {
  const manifest = JSON.parse(readFileSync(join(fx.bundleRoot, "manifest.json"), "utf8")) as
    Record<string, unknown>;
  const { legacyArtifacts: _legacyArtifacts, authentication: _authentication, ...currentBody } = manifest;
  const body = { ...currentBody, schemaVersion: 1 };
  const authenticationKey = createHmac("sha256", KEY)
    .update("mendpoint:regauge-state-transfer:v1:authentication")
    .digest();
  const authentication = {
    algorithm: "hmac-sha256",
    keyId: BINDINGS.transferKeyId,
    value: createHmac("sha256", authenticationKey).update(canonicalFixture(body)).digest("hex"),
  };
  rmSync(join(fx.bundleRoot, "legacy-artifacts"), { recursive: true });
  writeFileSync(
    join(fx.bundleRoot, "manifest.json"),
    `${canonicalFixture({ ...body, authentication })}\n`,
  );
}

describe("ReGauge state transfer", () => {
  it("creates a canonical authenticated manifest with exact database evidence", () => {
    const fx = fixture();
    const manifest = transfer(fx);
    const verified = verifyRegaugeStateTransfer({ bundleRoot: fx.bundleRoot, transferKey: KEY });

    expect(verified).toEqual(manifest);
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      kind: "mendpoint.regauge.state-transfer",
      transferId: "cutover-001",
      createdAt: "2026-08-25T12:00:00.000Z",
      bindings: BINDINGS,
      fence: { id: "fence-old-worker-quiesced", markerSha256: expect.stringMatching(/^[a-f0-9]{64}$/), held: true },
      authentication: { algorithm: "hmac-sha256", keyId: BINDINGS.transferKeyId },
    });
    expect(manifest.resources.map((resource) => resource.name)).toEqual(REGAUGE_TRANSFER_DATABASES);
    expect(manifest.legacyArtifacts).toEqual([
      expect.objectContaining({
        root: "transformer-candidates",
        relativePath: `${LEGACY_SCOPE.join("/")}/manifest.json`,
        plaintextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        encryptedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        root: "transformer-evidence",
        relativePath: `${LEGACY_SCOPE.join("/")}/${LEGACY_EXECUTION_FILE}`,
        plaintextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        encryptedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(manifest.resources.every((resource) =>
      /^[a-f0-9]{64}$/.test(resource.plaintextSha256) &&
      /^[a-f0-9]{64}$/.test(resource.encryptedSha256) &&
      /^[a-f0-9]{64}$/.test(resource.schemaSha256) &&
      resource.plaintextSizeBytes > 0 && resource.encryptedSizeBytes > resource.plaintextSizeBytes &&
      resource.quickCheck === "ok" && resource.foreignKeyCheck.length === 0
    )).toBe(true);
    expect(manifest.resources.find((resource) => resource.name === "mendpoint.sqlite")!.ledgerTips)
      .toEqual([expect.objectContaining({ table: "domain_events", rowCount: 1, sequence: 1 })]);
    expect(manifest.resources.find((resource) => resource.name === "transformer-control-plane.sqlite")!.ledgerTips)
      .toEqual([expect.objectContaining({ table: "tf_events", rowCount: 1, sequence: 1 })]);
    expect(manifest.resources.find((resource) => resource.name === "transformer-pilot.sqlite")!.ledgerTips)
      .toEqual([expect.objectContaining({
        table: "tf_pilot_events", rowCount: 1, sequence: 1,
        eventType: "attempt.completed_with_checkpoint",
      })]);
  });

  it("verifies and restores an authenticated schema-1 bundle from current main", () => {
    const fx = fixture();
    transfer(fx);
    rewriteBundleAsAuthenticatedV1(fx);

    const verified = verifyRegaugeStateTransfer({ bundleRoot: fx.bundleRoot, transferKey: KEY });
    expect(verified.schemaVersion).toBe(1);
    const restored = restoreRegaugeStateTransfer({
      bundleRoot: fx.bundleRoot,
      targetRoot: fx.targetRoot,
      transferKey: KEY,
    });
    expect(restored.schemaVersion).toBe(1);
    expect(verifyRestoredRegaugeState({
      targetRoot: fx.targetRoot,
      importManifest: restored,
      transferKey: KEY,
    })).toEqual(restored);
    expect(readFileSync(join(fx.targetRoot, "mendpoint.sqlite"))).not.toHaveLength(0);
    expect(readFileSync(join(fx.targetRoot, "transformer-pilot.sqlite"))).not.toHaveLength(0);
    expect(existsSync(join(fx.targetRoot, "transformer-candidates"))).toBe(true);
    expect(existsSync(join(fx.targetRoot, "transformer-evidence"))).toBe(true);
  });

  it("requires an exact authenticated persistent cutover fence", () => {
    const missing = fixture();
    expect(() => createRegaugeStateTransfer({
      transferId: "cutover-missing-fence",
      createdAt: "2026-08-25T12:00:00.000Z",
      sourceRoot: missing.sourceRoot,
      bundleRoot: missing.bundleRoot,
      bindings: BINDINGS,
      transferKey: KEY,
      fenceRoot: join(missing.root, "missing-fence"),
      fenceId: "fence-old-worker-quiesced",
    })).toThrow("regauge_cutover_fence_missing");

    const forged = fixture();
    const forgedRoot = join(forged.root, "forged-fence");
    mkdirSync(forgedRoot);
    writeFileSync(join(forgedRoot, "regauge-cutover-fence.v1.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "mendpoint.regauge.cutover-fence",
      fenceId: "fence-old-worker-quiesced",
      transferId: "cutover-001",
      createdAt: "2026-08-25T11:59:00.000Z",
      sourceApp: BINDINGS.sourceApp,
      sourceVolume: BINDINGS.sourceVolume,
      transferKeyId: BINDINGS.transferKeyId,
      nonce: "1".repeat(32),
      exclusiveMarkerSha256: "2".repeat(64),
      authentication: { algorithm: "hmac-sha256", keyId: BINDINGS.transferKeyId, value: "0".repeat(64) },
    }));
    expect(() => inspectRegaugeCutoverFence({
      fenceRoot: forgedRoot, fenceId: "fence-old-worker-quiesced", transferKey: KEY,
    })).toThrow("regauge_cutover_fence_authentication_failed");

    const existing = fixture();
    const existingRoot = join(existing.root, "existing-fence");
    mkdirSync(join(existingRoot, "writers"), { recursive: true });
    const existingMarker = join(existingRoot, "regauge-cutover-fence.v1.json");
    writeFileSync(existingMarker, "preserve-existing-authority");
    expect(() => acquireRegaugeCutoverFence({
      fenceRoot: existingRoot,
      fenceId: "replacement-fence",
      transferId: "cutover-001",
      createdAt: "2026-08-25T11:59:00.000Z",
      sourceApp: BINDINGS.sourceApp,
      sourceVolume: BINDINGS.sourceVolume,
      transferKeyId: BINDINGS.transferKeyId,
      transferKey: KEY,
    })).toThrow("regauge_cutover_fence_exists");
    expect(readFileSync(existingMarker, "utf8")).toBe("preserve-existing-authority");

    const writer = fixture();
    const writerRoot = join(writer.root, "writer-fence");
    mkdirSync(join(writerRoot, "writers"), { recursive: true });
    writeFileSync(join(writerRoot, "writers", "active.json"), "active");
    expect(() => acquireRegaugeCutoverFence({
      fenceRoot: writerRoot,
      fenceId: "writer-blocked-fence",
      transferId: "cutover-001",
      createdAt: "2026-08-25T11:59:00.000Z",
      sourceApp: BINDINGS.sourceApp,
      sourceVolume: BINDINGS.sourceVolume,
      transferKeyId: BINDINGS.transferKeyId,
      transferKey: KEY,
    })).toThrow("regauge_cutover_writer_active");
    expect(existsSync(join(writerRoot, "exclusive.json"))).toBe(false);
    expect(existsSync(join(writerRoot, "regauge-cutover-fence.v1.json"))).toBe(false);
    expect(existsSync(join(writerRoot, "writers", "active.json"))).toBe(true);

    const persistent = fixture();
    transfer(persistent);
    const inspected = inspectRegaugeCutoverFence({
      fenceRoot: join(persistent.root, "cutover-fence"),
      fenceId: "fence-old-worker-quiesced",
      transferKey: KEY,
    });
    expect(inspected.fence.sourceVolume).toBe(BINDINGS.sourceVolume);
    expect(isBackupFenceActive(join(persistent.root, "cutover-fence"))).toBe(true);
    expect(tryAcquireMutationLease(join(persistent.root, "cutover-fence"))).toBeNull();
    const markerPath = join(persistent.root, "cutover-fence", "regauge-cutover-fence.v1.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.sourceVolume = "attacker-volume";
    writeFileSync(markerPath, JSON.stringify(marker));
    expect(() => inspectRegaugeCutoverFence({
      fenceRoot: join(persistent.root, "cutover-fence"),
      fenceId: "fence-old-worker-quiesced",
      transferKey: KEY,
    })).toThrow("regauge_cutover_fence_authentication_failed");
  });

  it("captures committed live WAL content through VACUUM INTO", () => {
    const fx = fixture();
    const path = join(fx.sourceRoot, "mendpoint.sqlite");
    const live = new DatabaseSync(path);
    try {
      live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      live.exec("INSERT INTO parent VALUES (2, 'committed-in-wal')");
      const manifest = transfer(fx);
      restoreRegaugeStateTransfer({ bundleRoot: fx.bundleRoot, targetRoot: fx.targetRoot, transferKey: KEY });
      const restored = new DatabaseSync(join(fx.targetRoot, "mendpoint.sqlite"), { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM parent ORDER BY id").all()).toEqual([
          { value: "main" }, { value: "committed-in-wal" },
        ]);
        expect(manifest.resources.find((resource) => resource.name === "mendpoint.sqlite")!
          .tableRowCounts.parent).toBe(2);
      } finally { restored.close(); }
    } finally { live.close(); }
  });

  it("fails closed for wrong keys, ciphertext tampering, missing files, and extra files", () => {
    const wrong = fixture();
    transfer(wrong);
    expect(() => verifyRegaugeStateTransfer({ bundleRoot: wrong.bundleRoot, transferKey: WRONG_KEY }))
      .toThrow("regauge_transfer_authentication_failed");

    const tampered = fixture();
    const tamperedManifest = transfer(tampered);
    const cipher = join(tampered.bundleRoot, tamperedManifest.resources[0]!.ciphertextPath);
    const bytes = readFileSync(cipher);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(cipher, bytes);
    expect(() => verifyRegaugeStateTransfer({ bundleRoot: tampered.bundleRoot, transferKey: KEY }))
      .toThrow("regauge_transfer_ciphertext_evidence_mismatch");

    const missing = fixture();
    const missingManifest = transfer(missing);
    rmSync(join(missing.bundleRoot, missingManifest.resources[0]!.ciphertextPath));
    expect(() => verifyRegaugeStateTransfer({ bundleRoot: missing.bundleRoot, transferKey: KEY }))
      .toThrow("regauge_transfer_bundle_extra_or_missing_resource");

    const extra = fixture();
    transfer(extra);
    writeFileSync(join(extra.bundleRoot, "unexpected"), "no");
    expect(() => verifyRegaugeStateTransfer({ bundleRoot: extra.bundleRoot, transferKey: KEY }))
      .toThrow("regauge_transfer_bundle_extra_or_missing_resource");

    const legacyTampered = fixture();
    const legacyManifest = transfer(legacyTampered) as any;
    const legacyCipher = join(legacyTampered.bundleRoot, legacyManifest.legacyArtifacts[0].ciphertextPath);
    writeFileSync(legacyCipher, "tampered");
    expect(() => verifyRegaugeStateTransfer({ bundleRoot: legacyTampered.bundleRoot, transferKey: KEY }))
      .toThrow("regauge_transfer_legacy_artifact_ciphertext_evidence_mismatch");
  });

  it("rejects symlink traversal while collecting portable legacy artifacts", () => {
    const fx = fixture();
    const escaped = join(fx.root, "escaped");
    mkdirSync(escaped);
    writeFileSync(join(escaped, "secret.json"), "secret");
    symlinkSync(escaped, join(fx.sourceRoot, "transformer-candidates", "escape"), "junction");
    expect(() => transfer(fx)).toThrow("regauge_transfer_legacy_artifact_aliased");
  });

  it("rejects hard-linked and oversized adoption evidence before publication", () => {
    const linked = fixture();
    const candidate = join(linked.sourceRoot, "transformer-candidates", ...LEGACY_SCOPE, "manifest.json");
    const execution = join(linked.sourceRoot, "transformer-evidence", ...LEGACY_SCOPE, LEGACY_EXECUTION_FILE);
    rmSync(execution);
    linkSync(candidate, execution);
    expect(() => transfer(linked)).toThrow("regauge_transfer_legacy_artifact_aliased");

    const maximum = fixture();
    truncateSync(
      join(maximum.sourceRoot, "transformer-candidates", ...LEGACY_SCOPE, "manifest.json"),
      REGAUGE_MISSION_EVIDENCE_MAX_BYTES,
    );
    expect(() => transfer(maximum)).not.toThrow();

    const oversized = fixture();
    truncateSync(
      join(oversized.sourceRoot, "transformer-candidates", ...LEGACY_SCOPE, "manifest.json"),
      REGAUGE_MISSION_EVIDENCE_MAX_BYTES + 1,
    );
    expect(() => transfer(oversized)).toThrow("regauge_transfer_legacy_artifact_size_invalid");
  });

  it("rejects missing, cross-aliased, and externally hard-linked source databases", () => {
    const missing = fixture();
    rmSync(join(missing.sourceRoot, "change-sources.sqlite"));
    expect(() => transfer(missing)).toThrow("regauge_transfer_source_change-sources.sqlite_missing");

    const aliased = fixture();
    rmSync(join(aliased.sourceRoot, "change-sources.sqlite"));
    linkSync(join(aliased.sourceRoot, "mendpoint.sqlite"), join(aliased.sourceRoot, "change-sources.sqlite"));
    expect(() => transfer(aliased)).toThrow("regauge_transfer_source_change-sources.sqlite_aliased");

    for (const name of REGAUGE_TRANSFER_DATABASES) {
      const linked = fixture();
      const source = join(linked.sourceRoot, name);
      linkSync(source, join(linked.root, `external-${name}`));
      expect(() => transfer(linked)).toThrow(`regauge_transfer_source_${name}_aliased`);
    }
  });

  it("rejects every source database replaced after identity capture", async () => {
    for (const name of REGAUGE_TRANSFER_DATABASES) {
      const fx = fixture();
      const sourcePath = join(fx.sourceRoot, name);
      const source = new DatabaseSync(sourcePath);
      try {
        source.exec("CREATE TABLE snapshot_delay (payload BLOB NOT NULL); INSERT INTO snapshot_delay VALUES (randomblob(8388608))");
      } finally { source.close(); }
      const replacement = join(fx.root, `replacement-${name}`);
      createDatabase(replacement, `replacement-${name}`);
      const stolen = join(fx.root, `stolen-${name}`);
      const worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const fs = require("node:fs");
        const path = require("node:path");
        parentPort.postMessage("ready");
        const deadline = Date.now() + 10000;
        let replaced = false;
        while (Date.now() < deadline) {
          const staging = fs.readdirSync(workerData.root).some((entry) => entry.startsWith("bundle.staging-"));
          if (staging) {
            try {
              fs.renameSync(workerData.source, workerData.stolen);
              fs.renameSync(workerData.replacement, workerData.source);
              replaced = true;
              break;
            } catch {}
          }
        }
        parentPort.postMessage(replaced ? "replaced" : "timeout");
      `, { eval: true, workerData: { root: fx.root, source: sourcePath, replacement, stolen } });
      await new Promise<void>((resolve, reject) => {
        worker.once("message", (message) => message === "ready" ? resolve() : reject(new Error(String(message))));
        worker.once("error", reject);
      });
      let observed: unknown;
      try { transfer(fx); } catch (error) { observed = error; }
      const outcome = await new Promise<string>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      await worker.terminate();
      expect(outcome).toBe("replaced");
      expect(observed).toMatchObject({ message: "regauge_transfer_source_changed" });
    }
  }, 60_000);

  it("restores through a create-only owned destination and preserves evidence", () => {
    const fx = fixture();
    const manifest = transfer(fx);
    const restoredManifest = restoreRegaugeStateTransfer({
      bundleRoot: fx.bundleRoot,
      targetRoot: fx.targetRoot,
      transferKey: KEY,
    });
    expect(restoredManifest).toEqual(manifest);
    expect(readFileSync(join(
      fx.targetRoot,
      `transformer-candidates/${LEGACY_SCOPE.join("/")}/manifest.json`,
    ), "utf8")).toBe('{"kind":"transformer.candidate"}');
    expect(readFileSync(join(
      fx.targetRoot,
      `transformer-evidence/${LEGACY_SCOPE.join("/")}/${LEGACY_EXECUTION_FILE}`,
    ), "utf8")).toBe('{"kind":"transformer.recipe.execution"}');
    expect(inspectRegaugeLedgerTips(fx.targetRoot)).toEqual(Object.fromEntries(
      manifest.resources.map((resource) => [resource.name, resource.ledgerTips]),
    ));
    expect(verifyRestoredRegaugeState({
      targetRoot: fx.targetRoot,
      importManifest: manifest,
      transferKey: KEY,
    })).toEqual(manifest);
    writeFileSync(join(fx.targetRoot, "unexpected"), "no");
    expect(() => verifyRestoredRegaugeState({
      targetRoot: fx.targetRoot,
      importManifest: manifest,
      transferKey: KEY,
    })).toThrow("regauge_transfer_target_extra_or_missing_resource");
    rmSync(join(fx.targetRoot, "unexpected"));
    mkdirSync(join(fx.targetRoot, "transformer-candidates", "unexpected-empty-directory"));
    expect(() => verifyRestoredRegaugeState({
      targetRoot: fx.targetRoot,
      importManifest: manifest,
      transferKey: KEY,
    })).toThrow("regauge_transfer_target_extra_or_missing_resource");
    rmSync(join(fx.targetRoot, "transformer-candidates", "unexpected-empty-directory"), { recursive: true });
    expect(() => restoreRegaugeStateTransfer({
      bundleRoot: fx.bundleRoot,
      targetRoot: fx.targetRoot,
      transferKey: KEY,
    })).toThrow("regauge_transfer_target_exists");

    const missingParent = fixture();
    transfer(missingParent);
    expect(() => restoreRegaugeStateTransfer({
      bundleRoot: missingParent.bundleRoot,
      targetRoot: join(missingParent.root, "missing", "target"),
      transferKey: KEY,
    })).toThrow("regauge_transfer_target_parent_invalid");

    const failed = fixture();
    const failedManifest = transfer(failed);
    const cipher = join(failed.bundleRoot, failedManifest.resources[1]!.ciphertextPath);
    writeFileSync(cipher, "tampered");
    expect(() => restoreRegaugeStateTransfer({
      bundleRoot: failed.bundleRoot,
      targetRoot: failed.targetRoot,
      transferKey: KEY,
    })).toThrow();
    expect(existsSync(failed.targetRoot)).toBe(false);
  });

  it("does not delete or populate an ABA replacement after restore ownership changes", async () => {
    const fx = fixture();
    const source = new DatabaseSync(join(fx.sourceRoot, "change-sources.sqlite"));
    try {
      source.exec("CREATE TABLE restore_delay (payload BLOB NOT NULL); INSERT INTO restore_delay VALUES (randomblob(16777216))");
    } finally { source.close(); }
    transfer(fx);
    const stolenRoot = `${fx.targetRoot}-stolen`;
    const replacementSentinel = join(fx.targetRoot, "replacement-owner");
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      parentPort.postMessage("ready");
      const deadline = Date.now() + 15000;
      let replaced = false;
      while (Date.now() < deadline) {
        if (fs.existsSync(workerData.target)) {
          try {
            fs.renameSync(workerData.target, workerData.stolen);
            fs.mkdirSync(workerData.target);
            fs.writeFileSync(workerData.sentinel, "replacement");
            replaced = true;
            break;
          } catch {}
        }
      }
      parentPort.postMessage(replaced ? "replaced" : "timeout");
    `, { eval: true, workerData: { target: fx.targetRoot, stolen: stolenRoot, sentinel: replacementSentinel } });
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (message) => message === "ready" ? resolve() : reject(new Error(String(message))));
      worker.once("error", reject);
    });
    let observed: unknown;
    try {
      restoreRegaugeStateTransfer({ bundleRoot: fx.bundleRoot, targetRoot: fx.targetRoot, transferKey: KEY });
    } catch (error) {
      observed = error;
    }
    const outcome = await new Promise<string>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    expect(outcome).toBe("replaced");
    expect(observed).toMatchObject({ message: "regauge_transfer_target_ownership_changed" });
    expect(readFileSync(replacementSentinel, "utf8")).toBe("replacement");
    expect(existsSync(stolenRoot)).toBe(true);
  }, 30_000);

});
