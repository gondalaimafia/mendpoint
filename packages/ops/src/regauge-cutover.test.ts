import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  REGAUGE_TRANSFER_DATABASES,
  acquireRegaugeCutoverFence,
  classifyRegaugeSourceRollback,
  createRegaugeStateTransfer,
  inspectRegaugeCutoverFence,
  inspectRegaugeLedgerTips,
  restoreRegaugeStateTransfer,
  thawRegaugeCutoverFence,
  verifyRegaugeStateTransfer,
  verifyRestoredRegaugeState,
  type RegaugeTransferBindings,
} from "./regauge-cutover.js";
import { isBackupFenceActive, tryAcquireMutationLease } from "./disaster-recovery.js";

const KEY = Buffer.alloc(32, 0x31);
const WRONG_KEY = Buffer.alloc(32, 0x41);
const roots: string[] = [];

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

describe("ReGauge state transfer", () => {
  it("creates a canonical authenticated manifest with exact database evidence", () => {
    const fx = fixture();
    const manifest = transfer(fx);
    const verified = verifyRegaugeStateTransfer({ bundleRoot: fx.bundleRoot, transferKey: KEY });

    expect(verified).toEqual(manifest);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "mendpoint.regauge.state-transfer",
      transferId: "cutover-001",
      createdAt: "2026-08-25T12:00:00.000Z",
      bindings: BINDINGS,
      fence: { id: "fence-old-worker-quiesced", markerSha256: expect.stringMatching(/^[a-f0-9]{64}$/), held: true },
      authentication: { algorithm: "hmac-sha256", keyId: BINDINGS.transferKeyId },
    });
    expect(manifest.resources.map((resource) => resource.name)).toEqual(REGAUGE_TRANSFER_DATABASES);
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
  });

  it("rejects missing and filesystem-aliased source databases", () => {
    const missing = fixture();
    rmSync(join(missing.sourceRoot, "change-sources.sqlite"));
    expect(() => transfer(missing)).toThrow("regauge_transfer_source_change-sources.sqlite_missing");

    const aliased = fixture();
    rmSync(join(aliased.sourceRoot, "change-sources.sqlite"));
    linkSync(join(aliased.sourceRoot, "mendpoint.sqlite"), join(aliased.sourceRoot, "change-sources.sqlite"));
    expect(() => transfer(aliased)).toThrow("regauge_transfer_sources_aliased");
  });

  it("restores create-only through an atomic directory publication and preserves evidence", () => {
    const fx = fixture();
    const manifest = transfer(fx);
    const restoredManifest = restoreRegaugeStateTransfer({
      bundleRoot: fx.bundleRoot,
      targetRoot: fx.targetRoot,
      transferKey: KEY,
    });
    expect(restoredManifest).toEqual(manifest);
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

  it("allows rollback only while the complete target evidence and exact cutover fence equal import", () => {
    const fx = fixture();
    const manifest = transfer(fx);
    restoreRegaugeStateTransfer({ bundleRoot: fx.bundleRoot, targetRoot: fx.targetRoot, transferKey: KEY });
    expect(classifyRegaugeSourceRollback({
      importManifest: manifest,
      transferKey: KEY,
      targetRoot: fx.targetRoot,
      fenceRoot: join(fx.root, "cutover-fence"),
      assessedAt: "2026-08-25T12:05:00.000Z",
    })).toMatchObject({
      schemaVersion: 1,
      kind: "mendpoint.regauge.rollback-proof",
      transferId: manifest.transferId,
      fenceId: manifest.fence.id,
      reason: "target_unchanged_since_import",
      fenceMarkerSha256: manifest.fence.markerSha256,
      targetEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      authentication: { algorithm: "hmac-sha256", keyId: BINDINGS.transferKeyId },
    });

    const proof = classifyRegaugeSourceRollback({
      importManifest: manifest,
      transferKey: KEY,
      targetRoot: fx.targetRoot,
      fenceRoot: join(fx.root, "cutover-fence"),
      assessedAt: "2026-08-25T12:05:00.000Z",
    });
    thawRegaugeCutoverFence({
      fenceRoot: join(fx.root, "cutover-fence"),
      fenceId: "fence-old-worker-quiesced",
      transferId: manifest.transferId,
      transferKey: KEY,
      rollbackProof: proof,
    });
    expect(existsSync(join(fx.root, "cutover-fence", "regauge-cutover-fence.v1.json"))).toBe(false);
    expect(isBackupFenceActive(join(fx.root, "cutover-fence"))).toBe(false);
    const lease = tryAcquireMutationLease(join(fx.root, "cutover-fence"));
    expect(lease).not.toBeNull();
    lease?.release();

    const laterFx = fixture();
    const later = transfer(laterFx, "cutover-002");
    restoreRegaugeStateTransfer({ bundleRoot: laterFx.bundleRoot, targetRoot: laterFx.targetRoot, transferKey: KEY });
    expect(() => thawRegaugeCutoverFence({
      fenceRoot: join(laterFx.root, "cutover-fence"),
      fenceId: later.fence.id,
      transferId: later.transferId,
      transferKey: KEY,
      rollbackProof: proof,
    })).toThrow("regauge_rollback_proof_invalid");

    const forgedFx = fixture();
    const forged = transfer(forgedFx);
    expect(() => thawRegaugeCutoverFence({
      fenceRoot: join(forgedFx.root, "cutover-fence"),
      fenceId: forged.fence.id,
      transferId: forged.transferId,
      transferKey: KEY,
      rollbackProof: { ...proof, authentication: { ...proof.authentication, value: "0".repeat(64) } },
    })).toThrow("regauge_rollback_proof_authentication_failed");

    const nonLedgerFx = fixture();
    const nonLedgerManifest = transfer(nonLedgerFx);
    restoreRegaugeStateTransfer({ bundleRoot: nonLedgerFx.bundleRoot, targetRoot: nonLedgerFx.targetRoot, transferKey: KEY });
    const nonLedgerTarget = new DatabaseSync(join(nonLedgerFx.targetRoot, "change-sources.sqlite"));
    try { nonLedgerTarget.exec("INSERT INTO parent VALUES (2, 'changed outside a ledger')"); }
    finally { nonLedgerTarget.close(); }
    expect(() => classifyRegaugeSourceRollback({
      importManifest: nonLedgerManifest,
      transferKey: KEY,
      targetRoot: nonLedgerFx.targetRoot,
      fenceRoot: join(nonLedgerFx.root, "cutover-fence"),
      assessedAt: "2026-08-25T12:05:00.000Z",
    })).toThrow("regauge_rollback_replay_risk");

    const ledgerFx = fixture();
    const ledgerManifest = transfer(ledgerFx);
    restoreRegaugeStateTransfer({ bundleRoot: ledgerFx.bundleRoot, targetRoot: ledgerFx.targetRoot, transferKey: KEY });
    const target = new DatabaseSync(join(ledgerFx.targetRoot, "transformer-pilot.sqlite"));
    try {
      target.exec("INSERT INTO tf_pilot_events (type, payload_json) VALUES ('delivery.draft_claimed', '{}')");
    } finally { target.close(); }
    expect(() => classifyRegaugeSourceRollback({
      importManifest: ledgerManifest,
      transferKey: KEY,
      targetRoot: ledgerFx.targetRoot,
      fenceRoot: join(ledgerFx.root, "cutover-fence"),
      assessedAt: "2026-08-25T12:05:00.000Z",
    })).toThrow("regauge_rollback_replay_risk");
  });
});
