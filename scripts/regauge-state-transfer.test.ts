import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { isBackupFenceActive } from "@mendpoint/ops";
import type { CustomerObjectStoreTransport } from "./customer-object-store.js";
import {
  attestRestoredRegaugeState,
  createRegaugeRollbackProof,
  freezeAndExportRegaugeState,
  loadRegaugeStateTransferRuntime,
  restorePublishedRegaugeState,
  runRegaugeStateTransferCommand,
  verifyRegaugeRestoreReceipt,
  verifyPublishedRegaugeState,
} from "./regauge-state-transfer.js";

const roots: string[] = [];

class MemoryTransport implements CustomerObjectStoreTransport {
  readonly objects = new Map<string, Buffer>();

  async put(remote: string, body: Buffer): Promise<void> {
    if (this.objects.has(remote)) throw new Error("remote_object_exists");
    this.objects.set(remote, Buffer.from(body));
  }

  async read(remote: string): Promise<Buffer> {
    const body = this.objects.get(remote);
    if (!body) throw new Error("remote_object_missing");
    return Buffer.from(body);
  }

  async remove(remote: string): Promise<void> { this.objects.delete(remote); }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.objects.keys()].filter((name) => name.startsWith(prefix));
  }

  async uploadDirectory(localRoot: string, remotePrefix: string): Promise<void> {
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else this.objects.set(
          `${remotePrefix}/${relative(localRoot, path).replaceAll("\\", "/")}`,
          readFileSync(path),
        );
      }
    };
    visit(localRoot);
  }

  async verifyDirectory(localRoot: string, remotePrefix: string): Promise<void> {
    for (const [remote, body] of this.objects) {
      if (!remote.startsWith(`${remotePrefix}/`) || remote.endsWith("/commit.json")) continue;
      expect(readFileSync(resolve(localRoot, remote.slice(remotePrefix.length + 1)))).toEqual(body);
    }
  }

  async downloadDirectory(remotePrefix: string, localRoot: string): Promise<void> {
    for (const [remote, body] of this.objects) {
      if (!remote.startsWith(`${remotePrefix}/`)) continue;
      const local = resolve(localRoot, remote.slice(remotePrefix.length + 1));
      mkdirSync(resolve(local, ".."), { recursive: true });
      writeFileSync(local, body);
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(path: string, ledger?: "domain" | "control" | "pilot"): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO values_table VALUES (1, 'retained')");
    if (ledger === "domain") db.exec("CREATE TABLE domain_events (event_sequence INTEGER PRIMARY KEY, event_type TEXT NOT NULL); INSERT INTO domain_events VALUES (1, 'mission.created')");
    if (ledger === "control") db.exec("CREATE TABLE tf_events (sequence INTEGER PRIMARY KEY, type TEXT NOT NULL); INSERT INTO tf_events VALUES (1, 'campaign.created')");
    if (ledger === "pilot") db.exec("CREATE TABLE tf_pilot_events (sequence INTEGER PRIMARY KEY, type TEXT NOT NULL); INSERT INTO tf_pilot_events VALUES (1, 'attempt.completed_with_checkpoint'); CREATE TABLE tf_pilot_delivery_claim_results (id INTEGER PRIMARY KEY)");
  } finally { db.close(); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-regauge-transfer-cli-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  database(join(source, "change-sources.sqlite"));
  database(join(source, "mendpoint.sqlite"), "domain");
  database(join(source, "transformer-control-plane.sqlite"), "control");
  database(join(source, "transformer-pilot.sqlite"), "pilot");
  const env = {
    MENDPOINT_BACKUP_TRANSPORT: "rclone_s3",
    MENDPOINT_BACKUP_STAGING_ROOT: join(root, "staging"),
    MENDPOINT_BACKUP_OBJECT_PREFIX: "regauge-state-transfer",
    BUCKET_NAME: "regauge-private",
    AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
    AWS_REGION: "auto",
    AWS_ACCESS_KEY_ID: "access",
    AWS_SECRET_ACCESS_KEY: "secret",
    MENDPOINT_REGAUGE_TRANSFER_ID: "cutover-20260825",
    MENDPOINT_REGAUGE_TRANSFER_KEY: "11".repeat(32),
    MENDPOINT_REGAUGE_TRANSFER_KEY_ID: "regauge-transfer-key-20260825",
    MENDPOINT_APPLICATION_DATA_KEY: "22".repeat(32),
    MENDPOINT_REGAUGE_CHECKPOINT_KEY: "33".repeat(32),
    MENDPOINT_BACKUP_SOURCE_ROOT: source,
    MENDPOINT_REGAUGE_TRANSFER_TARGET_ROOT: join(root, "target"),
    MENDPOINT_BACKUP_FENCE_ROOT: join(source, ".backup-fence"),
    MENDPOINT_REGAUGE_TRANSFER_FENCE_ID: "fence-20260825",
    MENDPOINT_REGAUGE_TENANT_ID: "tenant_regauge_canary",
    MENDPOINT_REGAUGE_CAMPAIGN_ID: "campaign_regauge_canary_20260814",
    MENDPOINT_REGAUGE_SOURCE_APP: "mendpoint-transformer-pilot",
    MENDPOINT_REGAUGE_SOURCE_VOLUME: "vol_source",
    MENDPOINT_REGAUGE_SOURCE_REVISION: "a".repeat(40),
    MENDPOINT_REGAUGE_TARGET_APP: "mendpoint-regauge-production",
    MENDPOINT_REGAUGE_TARGET_VOLUME: "vol_target",
  } as const;
  return { root, env };
}

describe("ReGauge state transfer CLI", () => {
  it("rejects reuse of the application or checkpoint encryption key", () => {
    const fx = fixture();
    expect(() => loadRegaugeStateTransferRuntime({
      ...fx.env,
      MENDPOINT_REGAUGE_TRANSFER_KEY: fx.env.MENDPOINT_APPLICATION_DATA_KEY,
    })).toThrow("regauge_state_transfer_key_must_be_distinct");
  });

  it("freezes, publishes, verifies, restores, proves rollback safety, and thaws", async () => {
    const fx = fixture();
    const transport = new MemoryTransport();
    const runtime = loadRegaugeStateTransferRuntime(fx.env, new Date("2026-08-25T12:00:00.000Z"));
    const exported = await freezeAndExportRegaugeState(runtime, transport);
    expect(exported).toMatchObject({ transferId: runtime.transferId, fenceId: runtime.fenceId });
    expect(isBackupFenceActive(runtime.fenceRoot)).toBe(true);
    expect(transport.objects.has("regauge-state-transfer/cutover-20260825/commit.json")).toBe(true);

    await expect(verifyPublishedRegaugeState(runtime, transport)).resolves.toMatchObject({
      transferId: runtime.transferId,
    });
    await expect(restorePublishedRegaugeState(runtime, transport)).resolves.toMatchObject({
      transferId: runtime.transferId,
      targetRoot: runtime.targetRoot,
    });
    await expect(verifyRegaugeRestoreReceipt(runtime, transport)).resolves.toMatchObject({
      transferId: runtime.transferId,
      targetApp: "mendpoint-regauge-production",
      targetVolume: "vol_target",
    });
    transport.objects.delete("regauge-state-transfer-verified/cutover-20260825.json");
    await expect(attestRestoredRegaugeState(runtime, transport)).resolves.toMatchObject({
      transferId: runtime.transferId,
      attested: true,
      sourceRevision: "a".repeat(40),
      targetApp: "mendpoint-regauge-production",
      targetVolume: "vol_target",
      verifiedAt: expect.any(String),
    });
    await expect(verifyRegaugeRestoreReceipt(runtime, transport)).resolves.toMatchObject({
      transferId: runtime.transferId,
    });
    expect(existsSync(join(runtime.targetRoot, "transformer-pilot.sqlite"))).toBe(true);
    const restored = new DatabaseSync(join(runtime.targetRoot, "transformer-pilot.sqlite"), { readOnly: true });
    try {
      expect(restored.prepare("SELECT type FROM tf_pilot_events").get()).toEqual({
        type: "attempt.completed_with_checkpoint",
      });
    } finally { restored.close(); }

    const proof = await createRegaugeRollbackProof(runtime, transport);
    expect(proof.authentication.value).toMatch(/^[a-f0-9]{64}$/);
    await runRegaugeStateTransferCommand("thaw", {
      ...fx.env,
      MENDPOINT_REGAUGE_ROLLBACK_PROOF_JSON: JSON.stringify(proof),
    }, new Date("2026-08-25T12:10:00.000Z"), transport);
    expect(isBackupFenceActive(runtime.fenceRoot)).toBe(false);
  });
});
