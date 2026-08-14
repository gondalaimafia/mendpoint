import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";

// The Warden/Transformer -> Fettler/Regauge DB table rename. These tests are the
// acceptance bar for the highest-risk slice: they prove the guarded, idempotent
// migration converges an existing production-shaped volume onto the new schema
// without ever crashing boot, and without losing a single row.

type Db = ReturnType<typeof createDb>;
type SqlValue = string | number | null;

// old name -> new name, for every renamed table.
const TABLE_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["warden_model_reservations", "fettler_model_reservations"],
  ["warden_campaigns", "fettler_campaigns"],
  ["warden_campaign_targets", "fettler_campaign_targets"],
  ["warden_rollout_decisions", "fettler_rollout_decisions"],
  ["warden_candidate_deliveries", "fettler_candidate_deliveries"],
  ["warden_ci_cycles", "fettler_ci_cycles"],
  ["warden_ci_observations", "fettler_ci_observations"],
  ["warden_ci_updates", "fettler_ci_updates"],
  ["transformer_adaptive_candidates", "regauge_adaptive_candidates"],
  ["transformer_adaptive_regenerations", "regauge_adaptive_regenerations"],
  ["transformer_adaptive_deliveries", "regauge_adaptive_deliveries"],
];

// old name -> new name, for every renamed index.
const INDEX_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["warden_model_reservations_job_idx", "fettler_model_reservations_job_idx"],
  ["warden_campaigns_tenant_status_idx", "fettler_campaigns_tenant_status_idx"],
  ["warden_targets_campaign_stage_idx", "fettler_targets_campaign_stage_idx"],
  ["warden_rollout_decisions_campaign_idx", "fettler_rollout_decisions_campaign_idx"],
  ["warden_candidate_deliveries_tenant_idx", "fettler_candidate_deliveries_tenant_idx"],
  ["warden_ci_cycles_tenant_status_idx", "fettler_ci_cycles_tenant_status_idx"],
  ["warden_ci_observations_cycle_idx", "fettler_ci_observations_cycle_idx"],
  ["warden_ci_updates_tenant_status_idx", "fettler_ci_updates_tenant_status_idx"],
  ["transformer_adaptive_candidates_tenant_idx", "regauge_adaptive_candidates_tenant_idx"],
  ["transformer_adaptive_regenerations_pending_idx", "regauge_adaptive_regenerations_pending_idx"],
  ["transformer_adaptive_deliveries_tenant_idx", "regauge_adaptive_deliveries_tenant_idx"],
];

const NEW_TABLES = TABLE_RENAMES.map(([, n]) => n);
const NEW_TO_OLD = new Map(TABLE_RENAMES.map(([o, n]) => [n, o]));

// Reverse the rename inside a SQL string so we can reflect a fresh database and
// reconstruct the exact pre-change production shape. Whole-word replacement, so
// a table name never matches inside an index name (the trailing "_" blocks it),
// which is why table and index names are handled with their own explicit maps.
const TS = "2026-01-01T00:00:00.000Z";
function reverseNames(sql: string): string {
  let out = sql;
  for (const [oldName, newName] of [...INDEX_RENAMES, ...TABLE_RENAMES]) {
    out = out.replace(new RegExp(`\\b${newName}\\b`, "g"), oldName);
  }
  return out;
}

// One valid row per renamed table, keyed by the NEW table name. Values satisfy
// every NOT NULL and CHECK constraint; foreign-key columns hold fabricated ids
// (foreign keys are disabled while seeding, mirroring a straight data copy).
const SEEDS: Record<string, { columns: string[]; values: SqlValue[] }> = {
  fettler_model_reservations: {
    columns: [
      "id", "tenant_id", "job_id", "run_id", "worker_id", "lease_generation",
      "call_index", "request_digest", "reservation_digest", "provider",
      "configured_model", "endpoint_host", "status", "maximum_input_tokens",
      "maximum_output_tokens", "maximum_total_tokens", "maximum_cost_usd",
      "job_budget_usd", "reserved_at",
    ],
    values: [
      "res1", "t1", "job1", "run1", "worker1", 1, 1, "reqdig", "resdig",
      "anthropic", "muse", "host", "active", 0, 1, 1, 0, 0, TS,
    ],
  },
  fettler_campaigns: {
    columns: [
      "id", "tenant_id", "name", "status", "owner_principal_id",
      "concurrency_limit", "completion_policy", "revision", "created_at",
      "updated_at",
    ],
    values: ["camp1", "t1", "Legacy Campaign", "running", "p1", 1, "all", 1, TS, TS],
  },
  fettler_campaign_targets: {
    columns: [
      "id", "tenant_id", "campaign_id", "repository_id", "snapshot_id",
      "owner_principal_id", "stage", "depends_on_json", "max_attempts",
      "revision", "created_at", "updated_at",
    ],
    values: ["tgt1", "t1", "camp1", "repo1", "snap1", "p1", "queued", "[]", 1, 1, TS, TS],
  },
  fettler_rollout_decisions: {
    columns: [
      "id", "tenant_id", "campaign_id", "campaign_revision", "canary_target_id",
      "max_cohort_size", "decision_json", "decision_sha256",
      "created_by_principal_id", "created_at",
    ],
    values: ["roll1", "t1", "camp1", 1, "tgt1", 1, "{}", "a".repeat(64), "p1", TS],
  },
  fettler_candidate_deliveries: {
    columns: [
      "id", "tenant_id", "run_id", "job_id", "status", "repository_id",
      "snapshot_id", "base_branch", "expected_base_revision", "sealed_path",
      "sealed_sha256", "requester_principal_id", "rationale", "requested_at",
      "updated_at",
    ],
    values: [
      "del1", "t1", "run1", "jobdel1", "delivery_pending", "repo1", "snap1",
      "main", "rev0", "/sealed", "sha", "p1", "because", TS, TS,
    ],
  },
  fettler_ci_cycles: {
    columns: [
      "id", "tenant_id", "delivery_id", "observation_job_id", "status",
      "repository_id", "remote_repository_id", "installation_id",
      "pull_request_number", "base_branch", "branch_name", "base_revision",
      "current_head_sha", "required_checks_json", "allowed_changed_paths_json",
      "max_cycles", "max_model_calls", "maximum_cost_usd", "created_at",
      "updated_at",
    ],
    values: [
      "cyc1", "t1", "del1", "obsjob1", "observation_pending", "repo1", 10, 20,
      5, "main", "feature", "rev0", "headsha", "[]", "[]", 3, 100, 1.5, TS, TS,
    ],
  },
  fettler_ci_observations: {
    columns: [
      "id", "tenant_id", "cycle_id", "head_sha", "verdict", "observation_digest",
      "evidence_artifact_id", "evidence_digest", "observed_at",
    ],
    values: ["obs1", "t1", "cyc1", "headsha", "success", "obsdig", "art1", "evdig", TS],
  },
  fettler_ci_updates: {
    columns: [
      "id", "tenant_id", "cycle_id", "repair_run_id", "job_id", "status",
      "expected_head_sha", "sealed_path", "sealed_sha256",
      "reviewer_principal_id", "rationale", "requested_at", "updated_at",
    ],
    values: [
      "upd1", "t1", "cyc1", "rr1", "jobupd1", "pending", "headsha", "/sealed",
      "sha", "p1", "because", TS, TS,
    ],
  },
  regauge_adaptive_candidates: {
    columns: [
      "id", "tenant_id", "campaign_id", "unit_id", "attempt_id", "repository_id",
      "snapshot_id", "base_branch", "expected_base_revision", "kind", "status",
      "diverged_from_digest", "candidate_digest", "sealed_path", "sealed_sha256",
      "changed_paths_json", "expires_at", "created_at", "updated_at",
    ],
    values: [
      "cand1", "t1", "camp1", "unit1", "att1", "repo1", "snap1", "main", "rev0",
      "adaptive", "review_pending", "divdig", "canddig", "/sealed", "sha", "[]",
      TS, TS, TS,
    ],
  },
  regauge_adaptive_regenerations: {
    columns: [
      "id", "tenant_id", "candidate_id", "campaign_id", "unit_id",
      "reviewer_principal_id", "rationale", "rationale_digest", "status",
      "requested_at", "updated_at",
    ],
    values: ["regen1", "t1", "cand1", "camp1", "unit1", "p1", "because", "ratdig", "pending", TS, TS],
  },
  regauge_adaptive_deliveries: {
    columns: [
      "id", "tenant_id", "candidate_id", "job_id", "status", "repository_id",
      "snapshot_id", "base_branch", "expected_base_revision",
      "requester_principal_id", "requested_at", "updated_at",
    ],
    values: [
      "adel1", "t1", "cand1", "jobadel1", "delivery_pending", "repo1", "snap1",
      "main", "rev0", "p1", TS, TS,
    ],
  },
};

const dirs: string[] = [];
const openDbs: Db[] = [];

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.raw.close?.();
  while (dirs.length) {
    const d = dirs.pop();
    if (!d) continue;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore lock races on Windows */
    }
  }
});

function newDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mendpoint-${label}-`));
  dirs.push(dir);
  return dir;
}

function boot(path: string): Db {
  const db = createDb(path);
  openDbs.push(db);
  return db;
}

/**
 * Build a database whose tables in `useOldName` carry their pre-change
 * (Warden/Transformer) names and indexes, while all other renamed tables carry
 * their new (Fettler/Regauge) names. The exact schema is reflected from a fresh
 * database and reversed, so it is provably the real production shape. Every
 * renamed table is seeded with one valid row under whatever name it currently
 * has.
 */
function buildVolume(path: string, useOldName: ReadonlySet<string>): void {
  const reflectDir = newDir("rename-reflect");
  const fresh = boot(join(reflectDir, "reflect.sqlite"));
  const placeholders = NEW_TABLES.map(() => "?").join(", ");
  const objects = fresh.raw
    .prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND tbl_name IN (${placeholders})
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
    )
    .all(...NEW_TABLES) as Array<{ type: string; tbl_name: string; sql: string }>;

  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys = OFF");
  for (const obj of objects) {
    const sql = useOldName.has(obj.tbl_name) ? reverseNames(obj.sql) : obj.sql;
    legacy.exec(`${sql};`);
  }
  for (const newName of NEW_TABLES) {
    const seed = SEEDS[newName];
    const target = useOldName.has(newName) ? NEW_TO_OLD.get(newName)! : newName;
    const cols = seed.columns.join(", ");
    const marks = seed.columns.map(() => "?").join(", ");
    legacy
      .prepare(`INSERT INTO ${target} (${cols}) VALUES (${marks})`)
      .run(...seed.values);
  }
  legacy.close();
}

function dumpSchema(db: Db): Array<{ type: string; name: string; tbl_name: string; sql: string }> {
  return db.raw
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
}

function tableExists(db: Db, name: string): boolean {
  return (
    db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function rowCount(db: Db, table: string): number {
  return (db.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe("warden/transformer table rename", () => {
  it("boots a pre-change volume, converges byte-for-byte with fresh, and preserves every row", () => {
    // Pre-change production shape: all renamed tables carry their OLD names and
    // hold rows.
    const legacyPath = join(newDir("rename-legacy"), "legacy.sqlite");
    buildVolume(legacyPath, new Set(NEW_TABLES.map((n) => n)));

    // The real boot path must not throw on the existing volume.
    const migrated = boot(legacyPath);

    const fresh = boot(join(newDir("rename-fresh"), "fresh.sqlite"));

    // The resulting schema is identical to a freshly created database -- every
    // table, index, and trigger, including SQL text.
    expect(dumpSchema(migrated)).toEqual(dumpSchema(fresh));

    // Every old table is gone and every new table exists with its row intact.
    for (const [oldName, newName] of TABLE_RENAMES) {
      expect(tableExists(migrated, oldName)).toBe(false);
      expect(tableExists(migrated, newName)).toBe(true);
      expect(rowCount(migrated, newName)).toBe(1);
    }

    // Spot-check that row DATA survived, not merely the row count.
    expect(
      migrated.raw
        .prepare("SELECT name, status FROM fettler_campaigns WHERE id = 'camp1'")
        .get(),
    ).toEqual({ name: "Legacy Campaign", status: "running" });
    expect(
      migrated.raw
        .prepare("SELECT status FROM regauge_adaptive_candidates WHERE id = 'cand1'")
        .get(),
    ).toEqual({ status: "review_pending" });
  });

  it("boots a fresh database with the full new schema and no old tables", () => {
    const fresh = boot(join(newDir("rename-fresh-only"), "fresh.sqlite"));
    for (const [oldName, newName] of TABLE_RENAMES) {
      expect(tableExists(fresh, newName)).toBe(true);
      expect(tableExists(fresh, oldName)).toBe(false);
      expect(rowCount(fresh, newName)).toBe(0);
    }
  });

  it("boots an already-migrated database as a clean no-op", () => {
    const path = join(newDir("rename-migrated"), "app.sqlite");
    const first = boot(path);
    // Seed a row (into a foreign-key-free renamed table) so we can prove the
    // second boot leaves data untouched.
    const seed = SEEDS.regauge_adaptive_candidates;
    first.raw
      .prepare(
        `INSERT INTO regauge_adaptive_candidates (${seed.columns.join(", ")}) VALUES (${seed.columns
          .map(() => "?")
          .join(", ")})`,
      )
      .run(...seed.values);
    first.raw.close?.();
    openDbs.pop();

    // Re-booting the same volume must not throw and must not disturb the schema
    // or the data.
    const second = boot(path);
    const fresh = boot(join(newDir("rename-migrated-fresh"), "fresh.sqlite"));
    expect(dumpSchema(second)).toEqual(dumpSchema(fresh));
    expect(rowCount(second, "regauge_adaptive_candidates")).toBe(1);
    for (const [oldName] of TABLE_RENAMES) {
      expect(tableExists(second, oldName)).toBe(false);
    }
  });

  it("converges a partially migrated database (some tables renamed, some not)", () => {
    // Half the renamed tables were already migrated in a prior deploy (new names
    // + new indexes); the rest still carry their old names.
    const oldHalf = new Set(NEW_TABLES.filter((_, i) => i % 2 === 0));
    const path = join(newDir("rename-partial"), "partial.sqlite");
    buildVolume(path, oldHalf);

    const migrated = boot(path);
    const fresh = boot(join(newDir("rename-partial-fresh"), "fresh.sqlite"));

    expect(dumpSchema(migrated)).toEqual(dumpSchema(fresh));
    for (const [oldName, newName] of TABLE_RENAMES) {
      expect(tableExists(migrated, oldName)).toBe(false);
      expect(rowCount(migrated, newName)).toBe(1);
    }
  });

  it("is idempotent: a second boot changes nothing", () => {
    const path = join(newDir("rename-idem"), "idem.sqlite");
    buildVolume(path, new Set(NEW_TABLES.map((n) => n)));

    const firstBoot = boot(path);
    const schemaAfterFirst = dumpSchema(firstBoot);
    const countsAfterFirst = NEW_TABLES.map((t) => rowCount(firstBoot, t));
    firstBoot.raw.close?.();
    openDbs.pop();

    const secondBoot = boot(path);
    expect(dumpSchema(secondBoot)).toEqual(schemaAfterFirst);
    expect(NEW_TABLES.map((t) => rowCount(secondBoot, t))).toEqual(countsAfterFirst);
  });
});
