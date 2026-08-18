import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";

// Release A makes the destructive old-to-new rename tolerant of a future
// compatibility release without changing today's new-only physical schema.

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

function forwardNames(sql: string): string {
  let out = sql;
  for (const [oldName, newName] of [...INDEX_RENAMES, ...TABLE_RENAMES]) {
    out = out.replace(new RegExp(`\\b${oldName}\\b`, "g"), newName);
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
 * Build a database whose tables in `useOldName` carry their pre-change names,
 * while all other renamed tables carry their current names. The exact schema is
 * reflected from a fresh database and reversed, and every table receives a row.
 */
function buildVolume(path: string, useOldName: ReadonlySet<string>): void {
  const reflectDir = newDir("rename-reflect");
  const fresh = boot(join(reflectDir, "reflect.sqlite"));
  const placeholders = NEW_TABLES.map(() => "?").join(", ");
  const objects = fresh.raw
    .prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND type IN ('table', 'index') AND tbl_name IN (${placeholders})
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

describe("Fettler/Regauge logical database names", () => {
  it("boots a legacy volume, converges byte-for-byte with fresh, and preserves every row", () => {
    const legacyPath = join(newDir("rename-legacy"), "legacy.sqlite");
    buildVolume(legacyPath, new Set(NEW_TABLES));

    // The real boot path must not throw on the existing volume.
    const migrated = boot(legacyPath);

    const fresh = boot(join(newDir("rename-fresh"), "fresh.sqlite"));

    // The resulting schema is identical to a freshly created database -- every
    // table, index, and trigger, including SQL text.
    expect(dumpSchema(migrated)).toEqual(dumpSchema(fresh));

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

  it("boots a fresh database with only Fettler and Regauge physical names", () => {
    const fresh = boot(join(newDir("rename-fresh-only"), "fresh.sqlite"));
    for (const [oldName, newName] of TABLE_RENAMES) {
      expect(tableExists(fresh, oldName)).toBe(false);
      expect(tableExists(fresh, newName)).toBe(true);
      expect(rowCount(fresh, newName)).toBe(0);
    }
    for (const [oldName, newName] of INDEX_RENAMES) {
      const indexes = new Set(
        (fresh.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
          ({ name }) => name,
        ),
      );
      expect(indexes.has(oldName)).toBe(false);
      expect(indexes.has(newName)).toBe(true);
    }
  });

  it("restores an already-renamed database without losing data", () => {
    const path = join(newDir("rename-migrated"), "app.sqlite");
    buildVolume(path, new Set());

    const second = boot(path);
    const fresh = boot(join(newDir("rename-migrated-fresh"), "fresh.sqlite"));
    expect(dumpSchema(second)).toEqual(dumpSchema(fresh));
    expect(rowCount(second, "regauge_adaptive_candidates")).toBe(1);
    for (const [oldName, newName] of TABLE_RENAMES) {
      expect(tableExists(second, oldName)).toBe(false);
      expect(tableExists(second, newName)).toBe(true);
      expect(rowCount(second, newName)).toBe(1);
    }
  });

  it("converges a partially migrated database (some tables renamed, some not)", () => {
    const oldHalf = new Set(NEW_TABLES.filter((_, i) => i % 2 === 0));
    const path = join(newDir("rename-partial"), "partial.sqlite");
    buildVolume(path, oldHalf);

    const migrated = boot(path);
    const fresh = boot(join(newDir("rename-partial-fresh"), "fresh.sqlite"));

    expect(dumpSchema(migrated)).toEqual(dumpSchema(fresh));
    for (const [oldName, newName] of TABLE_RENAMES) {
      expect(tableExists(migrated, oldName)).toBe(false);
      expect(tableExists(migrated, newName)).toBe(true);
      expect(rowCount(migrated, newName)).toBe(1);
    }
  });

  it("is idempotent: a second boot changes nothing", () => {
    const path = join(newDir("rename-idem"), "idem.sqlite");
    buildVolume(path, new Set(NEW_TABLES));

    const firstBoot = boot(path);
    const schemaAfterFirst = dumpSchema(firstBoot);
    const countsAfterFirst = NEW_TABLES.map((table) => rowCount(firstBoot, table));
    firstBoot.raw.close?.();
    openDbs.pop();

    const secondBoot = boot(path);
    expect(dumpSchema(secondBoot)).toEqual(schemaAfterFirst);
    expect(NEW_TABLES.map((table) => rowCount(secondBoot, table))).toEqual(countsAfterFirst);
  });

  it("upgrades missing legacy base_branch columns in old-only and partial volumes", () => {
    const shapes = [
      { label: "old-only", oldNames: new Set(NEW_TABLES) },
      {
        label: "partial",
        oldNames: new Set([
          "regauge_adaptive_candidates",
          "regauge_adaptive_deliveries",
        ]),
      },
    ];
    for (const shape of shapes) {
      const path = join(newDir(`rename-${shape.label}-additive`), `${shape.label}.sqlite`);
      buildVolume(path, shape.oldNames);
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        ALTER TABLE transformer_adaptive_deliveries DROP COLUMN base_branch;
        ALTER TABLE transformer_adaptive_candidates DROP COLUMN base_branch;
      `);
      legacy.close();

      const migrated = boot(path);
      expect(tableExists(migrated, "transformer_adaptive_candidates")).toBe(false);
      expect(tableExists(migrated, "transformer_adaptive_deliveries")).toBe(false);
      expect(
        migrated.raw
          .prepare("SELECT base_branch FROM regauge_adaptive_candidates WHERE id = 'cand1'")
          .get(),
      ).toEqual({ base_branch: "" });
      expect(
        migrated.raw
          .prepare("SELECT base_branch FROM regauge_adaptive_deliveries WHERE id = 'adel1'")
          .get(),
      ).toEqual({ base_branch: "" });
    }
  });

  it("converges the acceptance-outcome columns from a genuine pre-change delivery schema", () => {
    // Reflecting the current schema and reversing names yields old delivery tables
    // that already carry the outcome columns, so drop them to reproduce a true
    // pre-change volume that predates the acceptance-outcome release. The rename
    // must still converge byte-for-byte with a fresh database, and legacy rows
    // must read the outcome as pending (NULL), never a fabricated negative.
    const shapes = [
      { label: "outcome-old-only", oldNames: new Set(NEW_TABLES) },
      {
        label: "outcome-partial",
        oldNames: new Set([
          "fettler_candidate_deliveries",
          "regauge_adaptive_deliveries",
        ]),
      },
    ];
    for (const shape of shapes) {
      const path = join(newDir(`rename-${shape.label}`), `${shape.label}.sqlite`);
      buildVolume(path, shape.oldNames);
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        ALTER TABLE warden_candidate_deliveries DROP COLUMN outcome;
        ALTER TABLE warden_candidate_deliveries DROP COLUMN outcome_at;
        ALTER TABLE warden_candidate_deliveries DROP COLUMN outcome_source;
        ALTER TABLE transformer_adaptive_deliveries DROP COLUMN outcome;
        ALTER TABLE transformer_adaptive_deliveries DROP COLUMN outcome_at;
        ALTER TABLE transformer_adaptive_deliveries DROP COLUMN outcome_source;
      `);
      legacy.close();

      const migrated = boot(path);
      const fresh = boot(join(newDir(`rename-${shape.label}-fresh`), "fresh.sqlite"));
      expect(dumpSchema(migrated)).toEqual(dumpSchema(fresh));
      expect(tableExists(migrated, "warden_candidate_deliveries")).toBe(false);
      expect(tableExists(migrated, "transformer_adaptive_deliveries")).toBe(false);
      expect(
        migrated.raw
          .prepare("SELECT outcome, outcome_at, outcome_source FROM fettler_candidate_deliveries WHERE id = 'del1'")
          .get(),
      ).toEqual({ outcome: null, outcome_at: null, outcome_source: null });
      expect(
        migrated.raw
          .prepare("SELECT outcome, outcome_at, outcome_source FROM regauge_adaptive_deliveries WHERE id = 'adel1'")
          .get(),
      ).toEqual({ outcome: null, outcome_at: null, outcome_source: null });
    }
  });

  it("leaves the exact current predecessor rename startup with no pending old tables", () => {
    const path = join(newDir("rename-predecessor-rollback"), "rollback.sqlite");
    buildVolume(path, new Set(NEW_TABLES));
    const releaseA = boot(path);
    releaseA.raw.close();
    openDbs.pop();

    const predecessor = new DatabaseSync(path);
    const pending = TABLE_RENAMES.filter(([oldName, newName]) => {
      const exists = (name: string) =>
        predecessor
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name) !== undefined;
      return exists(oldName) && exists(newName);
    });
    expect(pending).toEqual([]);
    for (const [oldName, newName] of pending) {
      predecessor.exec(`INSERT INTO ${newName} SELECT * FROM ${oldName};`);
      predecessor.exec(`DROP TABLE ${oldName};`);
    }
    expect(
      predecessor.prepare("SELECT status FROM regauge_adaptive_candidates WHERE id = 'cand1'").get(),
    ).toEqual({ status: "review_pending" });
    predecessor.close();
  });

  it("accepts identical rows in both namespaces and removes the old table", () => {
    const identicalPath = join(newDir("rename-both-identical"), "identical.sqlite");
    buildVolume(identicalPath, new Set(NEW_TABLES));
    const identicalRaw = new DatabaseSync(identicalPath);
    const oldSql = (
      identicalRaw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transformer_adaptive_candidates'")
        .get() as { sql: string }
    ).sql;
    identicalRaw.exec(`${forwardNames(oldSql)};`);
    const seed = SEEDS.regauge_adaptive_candidates;
    identicalRaw
      .prepare(
        `INSERT INTO regauge_adaptive_candidates (${seed.columns.join(", ")}) VALUES (${seed.columns.map(() => "?").join(", ")})`,
      )
      .run(...seed.values);
    identicalRaw.close();
    const identical = boot(identicalPath);
    expect(tableExists(identical, "transformer_adaptive_candidates")).toBe(false);
    expect(rowCount(identical, "regauge_adaptive_candidates")).toBe(1);
  });

  it("merges disjoint rows from both namespaces before removing the old table", () => {
    const path = join(newDir("rename-both-disjoint"), "disjoint.sqlite");
    buildVolume(path, new Set(NEW_TABLES));
    const raw = new DatabaseSync(path);
    const oldSql = (
      raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transformer_adaptive_candidates'")
        .get() as { sql: string }
    ).sql;
    raw.exec(`${forwardNames(oldSql)};`);
    const seed = SEEDS.regauge_adaptive_candidates;
    raw
      .prepare(
        `INSERT INTO regauge_adaptive_candidates (${seed.columns.join(", ")}) VALUES (${seed.columns.map(() => "?").join(", ")})`,
      )
      .run(
        ...seed.values.map((value, index) => {
          if (seed.columns[index] === "id") return "cand-new-only";
          if (seed.columns[index] === "attempt_id") return "att-new-only";
          return value;
        }),
      );
    raw.close();

    const migrated = boot(path);
    expect(tableExists(migrated, "transformer_adaptive_candidates")).toBe(false);
    expect(rowCount(migrated, "regauge_adaptive_candidates")).toBe(2);
    expect(
      migrated.raw
        .prepare("SELECT id FROM regauge_adaptive_candidates ORDER BY id")
        .all(),
    ).toEqual([{ id: "cand-new-only" }, { id: "cand1" }]);
  });

  it("fails closed when both namespaces contain a divergent row", () => {
    const divergentPath = join(newDir("rename-both-divergent"), "divergent.sqlite");
    buildVolume(divergentPath, new Set(NEW_TABLES));
    const divergentRaw = new DatabaseSync(divergentPath);
    const divergentOldSql = (
      divergentRaw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transformer_adaptive_candidates'")
        .get() as { sql: string }
    ).sql;
    divergentRaw.exec(`${forwardNames(divergentOldSql)};`);
    const seed = SEEDS.regauge_adaptive_candidates;
    divergentRaw
      .prepare(
        `INSERT INTO regauge_adaptive_candidates (${seed.columns.join(", ")}) VALUES (${seed.columns.map(() => "?").join(", ")})`,
      )
      .run(...seed.values.map((value, index) => (seed.columns[index] === "status" ? "approved" : value)));
    divergentRaw.close();
    expect(() => createDb(divergentPath)).toThrow("warden_transformer_rename_data_conflict");

    const unchanged = new DatabaseSync(divergentPath);
    expect(
      unchanged.prepare("SELECT status FROM transformer_adaptive_candidates WHERE id = 'cand1'").get(),
    ).toEqual({ status: "review_pending" });
    expect(
      unchanged.prepare("SELECT status FROM regauge_adaptive_candidates WHERE id = 'cand1'").get(),
    ).toEqual({ status: "approved" });
    unchanged.close();
  });
});
