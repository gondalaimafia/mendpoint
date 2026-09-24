import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getDeliveryArtifact,
  insertMigrationPr,
  persistDeliveryArtifact,
  updateMigrationPrDelivery,
  type AppDb,
} from "./index.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
const extraDirs: string[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try { db.raw.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): { db: AppDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "migration-pr-delivery-"));
  const path = join(dir, "app.sqlite");
  const db = createDb(path);
  opened.push({ db, dir });
  db.raw.exec("PRAGMA foreign_keys = OFF");
  return { db, path };
}

function seedDraft(db: AppDb, id = "pr-1"): void {
  insertMigrationPr(db, {
    id,
    changeId: "change-1",
    consumerId: "consumer-1",
    title: "t",
    body: "b",
    branchName: "mendpoint/x",
    status: "draft",
    risk: "low",
    patchUnified: "diff",
    githubPrNumber: 24,
    githubPrUrl: "https://github.com/acme/shop/pull/24",
    createdAt: "2026-09-02T12:00:00.000Z",
  });
}

function status(db: AppDb, id = "pr-1"): { status: string; github_pr_number: number | null } {
  return db.raw.prepare("SELECT status, github_pr_number FROM migration_prs WHERE id = ?").get(id) as
    { status: string; github_pr_number: number | null };
}

describe("migration_prs delivery writes (PR #606 D1 CAS)", () => {
  it("never downgrades a recorded draft with a pre-delivery or failure write", () => {
    const { db } = freshDb();
    seedDraft(db);
    // A failure/pending/blocked write that carries no PR number is CAS-guarded on
    // github_pr_number IS NULL, so it matches no row and returns silently.
    updateMigrationPrDelivery(db, "pr-1", { status: "delivery_failed" });
    expect(status(db)).toMatchObject({ status: "draft", github_pr_number: 24 });
    updateMigrationPrDelivery(db, "pr-1", { status: "delivery_pending" });
    expect(status(db)).toMatchObject({ status: "draft", github_pr_number: 24 });
    updateMigrationPrDelivery(db, "pr-1", { status: "delivery_blocked" });
    expect(status(db)).toMatchObject({ status: "draft", github_pr_number: 24 });
  });

  it("allows the pre-delivery write and the recording write on a row with no PR yet", () => {
    const { db } = freshDb();
    insertMigrationPr(db, {
      id: "pr-2",
      changeId: "change-1",
      consumerId: "consumer-1",
      title: "t",
      body: "b",
      branchName: "mendpoint/y",
      status: "delivery_pending",
      risk: "low",
      patchUnified: "diff",
      createdAt: "2026-09-02T12:00:00.000Z",
    });
    // Pre-delivery write with no PR number succeeds while none is recorded.
    updateMigrationPrDelivery(db, "pr-2", { status: "delivery_pending", body: "b2" });
    expect(status(db, "pr-2")).toMatchObject({ status: "delivery_pending", github_pr_number: null });
    // The recording write (carries a PR number) transitions to draft.
    updateMigrationPrDelivery(db, "pr-2", {
      status: "draft",
      githubPrNumber: 7,
      githubPrUrl: "https://github.com/acme/shop/pull/7",
      deliveredBaseSha: "a".repeat(40),
      deliveredHeadSha: "b".repeat(40),
    });
    expect(status(db, "pr-2")).toMatchObject({ status: "draft", github_pr_number: 7 });
    // delivered_* are recorded set-once.
    const delivered = db.raw.prepare("SELECT delivered_base_sha, delivered_head_sha FROM migration_prs WHERE id = ?")
      .get("pr-2") as { delivered_base_sha: string | null; delivered_head_sha: string | null };
    expect(delivered.delivered_base_sha).toBe("a".repeat(40));
    expect(delivered.delivered_head_sha).toBe("b".repeat(40));
    // A later write cannot change the set-once delivered facts.
    updateMigrationPrDelivery(db, "pr-2", { status: "draft", deliveredBaseSha: "c".repeat(40) });
    const again = db.raw.prepare("SELECT delivered_base_sha FROM migration_prs WHERE id = ?")
      .get("pr-2") as { delivered_base_sha: string | null };
    expect(again.delivered_base_sha).toBe("a".repeat(40));
  });

  it("throws on a genuine identity mismatch, not on the CAS refusal", () => {
    const { db } = freshDb();
    // No such row: a non-CAS write (recording) throws the identity-mismatch error.
    expect(() => updateMigrationPrDelivery(db, "missing", {
      status: "draft",
      githubPrNumber: 1,
    })).toThrow("migration_pr_delivery_identity_mismatch");
  });
});

describe("write-ahead delivery artifact (PR #606 D5)", () => {
  it("persists, reads, is idempotent, and is tenant-scoped", () => {
    const { db } = freshDb();
    const artifact = {
      tenantId: "tenant-a",
      artifactDigest: "d".repeat(64),
      deliveryKey: "change-1:consumer-1",
      title: "Fettler candidate",
      body: "body with the package section",
      treeSha: "e".repeat(40),
      parentSha: "f".repeat(40),
      createdAt: "2026-09-02T12:00:00.000Z",
    };
    persistDeliveryArtifact(db, artifact);
    persistDeliveryArtifact(db, artifact); // idempotent (same digest)
    expect(getDeliveryArtifact(db, "tenant-a", "d".repeat(64))).toEqual(artifact);
    // A foreign tenant cannot read another tenant's artifact.
    expect(getDeliveryArtifact(db, "tenant-b", "d".repeat(64))).toBeNull();
    const count = db.raw.prepare("SELECT COUNT(*) AS c FROM migration_delivery_artifacts").get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("migration_prs upgrade path (idempotent, additive)", () => {
  it("boots a main-shaped DB (no delivered_* columns, no artifact table) and adds them, preserving rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "migration-pr-upgrade-"));
    extraDirs.push(dir);
    const path = join(dir, "app.sqlite");
    // A main-shaped migration_prs: no delivered_* columns and no artifact table.
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE migration_prs (
      id TEXT PRIMARY KEY, change_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, branch_name TEXT NOT NULL,
      status TEXT NOT NULL, risk TEXT NOT NULL, patch_unified TEXT NOT NULL,
      github_pr_number INTEGER, github_pr_url TEXT, created_at TEXT NOT NULL,
      resolved_at TEXT, coverage_json TEXT
    );`);
    raw.exec(`INSERT INTO migration_prs (id, change_id, consumer_id, title, body, branch_name, status, risk, patch_unified, created_at)
      VALUES ('legacy-1', 'change-1', 'consumer-1', 't', 'b', 'mendpoint/z', 'delivery_failed', 'low', 'diff', '2026-09-02T11:00:00.000Z')`);
    raw.close();

    // createDb re-runs the schema + additive ADD COLUMN migrations idempotently.
    const db = createDb(path);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const columns = new Set((db.raw.prepare("PRAGMA table_info(migration_prs)").all() as Array<{ name: string }>)
      .map((c) => c.name));
    expect(columns.has("delivered_base_sha")).toBe(true);
    expect(columns.has("delivered_head_sha")).toBe(true);
    // The artifact table now exists.
    expect(() => db.raw.prepare("SELECT COUNT(*) FROM migration_delivery_artifacts").get()).not.toThrow();
    // The legacy row is preserved.
    expect(status(db, "legacy-1")).toMatchObject({ status: "delivery_failed", github_pr_number: null });
    db.raw.close();
    // A second open is idempotent (no error, row still present).
    const db2 = createDb(path);
    expect(status(db2, "legacy-1")).toMatchObject({ status: "delivery_failed" });
    db2.raw.close();
  });
});
