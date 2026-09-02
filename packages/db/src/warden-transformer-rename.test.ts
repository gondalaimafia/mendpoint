import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextJob,
  computeLegacyTenantOwnershipAttestationDigest,
  createDb,
  enqueueJob,
  getRepairSession,
  getJob,
  insertRepairSession,
} from "./index.js";

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

type LegacyJobTenantShape = "missing" | "nullable";

function buildLegacyJobVolume(
  path: string,
  tenantShape: LegacyJobTenantShape,
  rows: ReadonlyArray<{ id: string; tenantId: string | null }>,
): void {
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      ${tenantShape === "nullable" ? "tenant_id TEXT," : ""}
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  for (const row of rows) {
    if (tenantShape === "nullable") {
      legacy.prepare(
        `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
         VALUES (?, ?, 'repair', '{}', ?)`,
      ).run(row.id, row.tenantId, TS);
    } else {
      legacy.prepare(
        `INSERT INTO jobs (id, type, payload_json, created_at)
         VALUES (?, 'repair', '{}', ?)`,
      ).run(row.id, TS);
    }
  }
  legacy.close();
}

function jobTenants(db: Db): Array<{ id: string; tenant_id: string | null }> {
  return db.raw
    .prepare("SELECT id, tenant_id FROM jobs ORDER BY id")
    .all() as Array<{ id: string; tenant_id: string | null }>;
}

function closeTracked(db: Db): void {
  db.raw.close();
  const index = openDbs.indexOf(db);
  if (index >= 0) openDbs.splice(index, 1);
}

function expectOmittedTenantInsertsRejected(
  database: Pick<DatabaseSync, "exec">,
  suffix: string,
): void {
  const statements = [
    `INSERT INTO jobs (id, type, payload_json, created_at)
     VALUES ('jobs-omitted-${suffix}', 'repair', '{}', '${TS}')`,
    `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
     VALUES ('jobs-explicit-${suffix}', 'tenant_default', 'repair', '{}', '${TS}')`,
    `INSERT INTO repair_sessions (id, repo_path, status, created_at)
     VALUES ('repair_sessions-omitted-${suffix}', '/repo', 'pending', '${TS}')`,
    `INSERT INTO repair_sessions (id, tenant_id, repo_path, status, created_at)
     VALUES ('repair_sessions-explicit-${suffix}', 'tenant_default', '/repo', 'pending', '${TS}')`,
    `INSERT INTO agent_runs (id, goal, repo_path, status, created_at)
     VALUES ('agent_runs-omitted-${suffix}', 'repair', '/repo', 'pending', '${TS}')`,
    `INSERT INTO agent_runs (id, tenant_id, goal, repo_path, status, created_at)
     VALUES ('agent_runs-explicit-${suffix}', 'tenant_default', 'repair', '/repo', 'pending', '${TS}')`,
    `INSERT INTO audit_events
       (id, actor, action, resource_type, metadata_json, created_at)
     VALUES ('audit_events-omitted-${suffix}', 'legacy', 'legacy.observed', 'legacy', '{}', '${TS}')`,
    `INSERT INTO audit_events
       (id, tenant_id, actor, action, resource_type, metadata_json, created_at)
     VALUES ('audit_events-explicit-${suffix}', 'tenant_default', 'legacy',
       'legacy.observed', 'legacy', '{}', '${TS}')`,
    `INSERT INTO suppressed_patterns (id, pattern, created_at)
     VALUES ('suppressed_patterns-omitted-${suffix}', 'legacy-pattern', '${TS}')`,
    `INSERT INTO suppressed_patterns (id, tenant_id, pattern, created_at)
     VALUES ('suppressed_patterns-explicit-${suffix}', 'tenant_default',
       'legacy-pattern', '${TS}')`,
  ];
  for (const statement of statements) {
    expect.soft(() => database.exec(statement)).toThrow(
      "legacy_tenant_ownership_attestation_required",
    );
  }
}

const LEGACY_OWNERSHIP_TABLES = [
  "jobs",
  "repair_sessions",
  "agent_runs",
  "audit_events",
  "suppressed_patterns",
] as const;

function buildLegacyOwnershipVolume(path: string): void {
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE repair_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      consumer_id TEXT,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      edits_count INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 0,
      report_md TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      job_id TEXT,
      goal TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      files_changed_json TEXT,
      report_md TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE suppressed_patterns (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      consumer_id TEXT,
      provider_slug TEXT,
      pattern TEXT NOT NULL,
      reason TEXT,
      source_pr_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const tenants = [
    ["empty", ""],
    ["null", null],
    ["valid", "tenant_customer"],
    ["whitespace", "   "],
  ] as const;
  for (const [suffix, tenantId] of tenants) {
    legacy.prepare(
      `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
       VALUES (?, ?, 'repair', '{}', ?)`,
    ).run(`jobs-${suffix}`, tenantId, TS);
    legacy.prepare(
      `INSERT INTO repair_sessions (id, tenant_id, repo_path, status, created_at)
       VALUES (?, ?, '/repo', 'pending', ?)`,
    ).run(`repair_sessions-${suffix}`, tenantId, TS);
    legacy.prepare(
      `INSERT INTO agent_runs (id, tenant_id, goal, repo_path, status, created_at)
       VALUES (?, ?, 'repair', '/repo', 'pending', ?)`,
    ).run(`agent_runs-${suffix}`, tenantId, TS);
    legacy.prepare(
      `INSERT INTO audit_events
         (id, tenant_id, actor, action, resource_type, metadata_json, created_at)
       VALUES (?, ?, 'legacy', 'legacy.observed', 'legacy', '{}', ?)`,
    ).run(`audit_events-${suffix}`, tenantId, TS);
    legacy.prepare(
      `INSERT INTO suppressed_patterns (id, tenant_id, pattern, created_at)
       VALUES (?, ?, 'legacy-pattern', ?)`,
    ).run(`suppressed_patterns-${suffix}`, tenantId, TS);
  }
  legacy.close();
}

function applyReleasedFallbackBackfill(path: string): void {
  const legacy = new DatabaseSync(path);
  for (const table of LEGACY_OWNERSHIP_TABLES) {
    legacy.exec(
      `UPDATE ${table}
       SET tenant_id = 'tenant_default'
       WHERE tenant_id IS NULL OR tenant_id = ''`,
    );
  }
  legacy.close();
}

function applyExactReleasedPredecessorTenantMigration(path: string): void {
  const predecessor = new DatabaseSync(path);
  for (const table of LEGACY_OWNERSHIP_TABLES) {
    predecessor.exec(`ALTER TABLE ${table} DROP COLUMN tenant_id`);
    predecessor.exec(
      `ALTER TABLE ${table}
       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_default'`,
    );
  }
  predecessor.close();
}

function sealReleasedSuccessorEmptyReconciliationState(path: string): void {
  const predecessor = new DatabaseSync(path);
  predecessor.exec(`
    CREATE TABLE legacy_tenant_ownership_reconciliation_scope (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id, tenant_id)
    );
    CREATE TABLE legacy_tenant_ownership_reconciliation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      sealed_at TEXT NOT NULL
    );
    INSERT INTO legacy_tenant_ownership_reconciliation_state
      (id, schema_version, sealed_at)
    VALUES (1, 1, '2026-09-02T00:00:00.000Z');
    CREATE TRIGGER legacy_tenant_ownership_reconciliation_scope_append_only_update
      BEFORE UPDATE ON legacy_tenant_ownership_reconciliation_scope
      BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_reconciliation_scope_append_only'); END;
    CREATE TRIGGER legacy_tenant_ownership_reconciliation_scope_append_only_delete
      BEFORE DELETE ON legacy_tenant_ownership_reconciliation_scope
      BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_reconciliation_scope_append_only'); END;
    CREATE TRIGGER legacy_tenant_ownership_reconciliation_state_append_only_update
      BEFORE UPDATE ON legacy_tenant_ownership_reconciliation_state
      BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_reconciliation_state_append_only'); END;
    CREATE TRIGGER legacy_tenant_ownership_reconciliation_state_append_only_delete
      BEFORE DELETE ON legacy_tenant_ownership_reconciliation_state
      BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_reconciliation_state_append_only'); END;
  `);
  predecessor.close();
}

function persistLegacyOwnershipAttestations(
  path: string,
  mutate?: (input: {
    tableName: string;
    rowId: string;
    tenantId: string;
    evidenceDigest: string;
    attestedBy: string;
    attestedAt: string;
    attestationDigest: string;
  }) => { attestationDigest: string },
): void {
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE legacy_tenant_ownership_attestations (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      attested_by TEXT NOT NULL,
      attested_at TEXT NOT NULL,
      attestation_digest TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id, tenant_id)
    );
  `);
  const evidenceDigest = "a".repeat(64);
  const attestedBy = "operator:test";
  const attestedAt = "2026-09-02T00:00:00.000Z";
  for (const tableName of LEGACY_OWNERSHIP_TABLES) {
    for (const suffix of ["empty", "null"] as const) {
      const rowId = `${tableName}-${suffix}`;
      const tenantId = "tenant_default";
      const canonical = JSON.stringify({
        schemaVersion: 1,
        tableName,
        rowId,
        tenantId,
        evidenceDigest,
        attestedBy,
        attestedAt,
      });
      const attestationDigest = createHash("sha256")
        .update(canonical)
        .digest("hex");
      const stored = mutate?.({
        tableName,
        rowId,
        tenantId,
        evidenceDigest,
        attestedBy,
        attestedAt,
        attestationDigest,
      }) ?? { attestationDigest };
      legacy.prepare(
        `INSERT INTO legacy_tenant_ownership_attestations
           (table_name, row_id, tenant_id, evidence_digest, attested_by,
            attested_at, attestation_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        tableName,
        rowId,
        tenantId,
        evidenceDigest,
        attestedBy,
        attestedAt,
        stored.attestationDigest,
      );
    }
  }
  legacy.close();
}

function attestExactReconciliationScope(path: string): void {
  const database = new DatabaseSync(path);
  const rows = database.prepare(
    `SELECT table_name, row_id, tenant_id
     FROM legacy_tenant_ownership_reconciliation_scope
     ORDER BY table_name, row_id`,
  ).all() as Array<{ table_name: string; row_id: string; tenant_id: string }>;
  const evidenceDigest = "b".repeat(64);
  const attestedBy = "operator:exact-predecessor-review";
  const attestedAt = "2026-09-02T00:05:00.000Z";
  for (const row of rows) {
    const attestationDigest = computeLegacyTenantOwnershipAttestationDigest({
      tableName: row.table_name as (typeof LEGACY_OWNERSHIP_TABLES)[number],
      rowId: row.row_id,
      tenantId: row.tenant_id,
      evidenceDigest,
      attestedBy,
      attestedAt,
    });
    database.prepare(
      `INSERT INTO legacy_tenant_ownership_attestations
         (table_name, row_id, tenant_id, evidence_digest, attested_by,
          attested_at, attestation_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.table_name,
      row.row_id,
      row.tenant_id,
      evidenceDigest,
      attestedBy,
      attestedAt,
      attestationDigest,
    );
  }
  database.close();
}

describe("Fettler/Regauge logical database names", () => {
  it.each([false, true])(
    "quarantines the exact released-predecessor default across restart (sealed empty state: %s)",
    (sealEmptyState) => {
      const path = join(newDir(`tenant-exact-predecessor-${sealEmptyState}`), "legacy.sqlite");
      buildLegacyOwnershipVolume(path);
      applyExactReleasedPredecessorTenantMigration(path);
      if (sealEmptyState) sealReleasedSuccessorEmptyReconciliationState(path);

      const predecessor = new DatabaseSync(path);
      try {
        expect(
          predecessor.prepare("PRAGMA table_info(jobs)").all()
            .find((column: any) => column.name === "tenant_id"),
        ).toMatchObject({
          type: "TEXT",
          notnull: 1,
          dflt_value: "'tenant_default'",
        });
      } finally {
        predecessor.close();
      }

      expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
      expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");

      const preserved = new DatabaseSync(path);
      try {
        expect(
          preserved.prepare(
            `SELECT table_name, row_id, tenant_id
             FROM legacy_tenant_ownership_reconciliation_scope
             ORDER BY table_name, row_id`,
          ).all(),
        ).toHaveLength(LEGACY_OWNERSHIP_TABLES.length * 4);
        expect(
          preserved.prepare(
            `SELECT id, status FROM jobs
             WHERE id = 'jobs-empty' AND tenant_id = 'tenant_default'`,
          ).get(),
        ).toEqual({ id: "jobs-empty", status: "pending" });
      } finally {
        preserved.close();
      }

      attestExactReconciliationScope(path);
      const authorized = boot(path);
      expect(getJob(authorized, "jobs-empty", "tenant_default")).toMatchObject({
        id: "jobs-empty",
        tenant_id: "tenant_default",
        status: "pending",
      });
      expect(claimNextJob(authorized, ["repair"], {
        tenantId: "tenant_default",
        workerId: "authorized-review-worker",
        now: "2026-09-02T00:10:00.000Z",
      })).toMatchObject({
        id: "jobs-empty",
        tenant_id: "tenant_default",
        status: "running",
      });
    },
  );

  it("rejects omitted tenant ownership across repair, rollback, and restart", () => {
    const path = join(newDir("tenant-omitted-repair-rollback-restart"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);

    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    attestExactReconciliationScope(path);

    const repaired = boot(path);
    expectOmittedTenantInsertsRejected(repaired.raw, "repair");
    closeTracked(repaired);

    const rollback = new DatabaseSync(path);
    try {
      applyReleasedFallbackBackfill(path);
      expectOmittedTenantInsertsRejected(rollback, "rollback");
    } finally {
      rollback.close();
    }

    const restarted = boot(path);
    expectOmittedTenantInsertsRejected(restarted.raw, "restart");
  });

  it("seals the discovered row set against later scope insertion", () => {
    const path = join(newDir("tenant-scope-sealed"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);

    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    const database = new DatabaseSync(path);
    expect(() => database.prepare(
      `INSERT INTO legacy_tenant_ownership_reconciliation_scope
         (table_name, row_id, tenant_id, discovered_at)
       VALUES ('jobs', 'late-row', 'tenant_default', ?)`,
    ).run(TS)).toThrow("legacy_tenant_ownership_reconciliation_scope_sealed");
    database.close();
  });

  it("rejects scope drift even if the insertion trigger is bypassed", () => {
    const path = join(newDir("tenant-scope-digest"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);
    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");

    const database = new DatabaseSync(path);
    database.exec(
      "DROP TRIGGER legacy_tenant_ownership_reconciliation_scope_append_only_insert",
    );
    database.prepare(
      `INSERT INTO legacy_tenant_ownership_reconciliation_scope
         (table_name, row_id, tenant_id, discovered_at)
       VALUES ('jobs', 'late-row', 'tenant_default', ?)`,
    ).run(TS);
    database.close();

    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
  });

  it("makes an attested source row tenant immutable", () => {
    const path = join(newDir("tenant-attested-source-immutable"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);
    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    attestExactReconciliationScope(path);

    const authorized = boot(path);
    expect(() => authorized.raw.prepare(
      "UPDATE jobs SET tenant_id = 'tenant_other' WHERE id = 'jobs-empty'",
    ).run()).toThrow("legacy_tenant_ownership_source_immutable");
  });

  it("seals scoped source identity before attestation permits boot", () => {
    const path = join(newDir("tenant-unattested-source-identity-immutable"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);

    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    const sealed = new DatabaseSync(path);
    try {
      expect(() => sealed.prepare(
        "UPDATE jobs SET id = 'jobs-renamed' WHERE id = 'jobs-empty'",
      ).run()).toThrow("legacy_tenant_ownership_source_immutable");
      expect(sealed.prepare(
        "SELECT id, tenant_id FROM jobs WHERE id = 'jobs-empty'",
      ).get()).toEqual({ id: "jobs-empty", tenant_id: "tenant_default" });
    } finally {
      sealed.close();
    }
  });

  it("rejects every late unattributable write after an unattested first boot", () => {
    const path = join(newDir("tenant-unattested-late-write-guards"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyReleasedFallbackBackfill(path);

    const setup = new DatabaseSync(path);
    setup.exec("UPDATE jobs SET status = 'done'");
    setup.close();

    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");

    const sealed = new DatabaseSync(path);
    const insertSql: Record<(typeof LEGACY_OWNERSHIP_TABLES)[number], string> = {
      jobs: `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
             VALUES (?, ?, 'repair', '{}', ?)`,
      repair_sessions:
        `INSERT INTO repair_sessions (id, tenant_id, repo_path, status, created_at)
         VALUES (?, ?, '/repo', 'pending', ?)`,
      agent_runs:
        `INSERT INTO agent_runs (id, tenant_id, goal, repo_path, status, created_at)
         VALUES (?, ?, 'repair', '/repo', 'pending', ?)`,
      audit_events:
        `INSERT INTO audit_events
           (id, tenant_id, actor, action, resource_type, metadata_json, created_at)
         VALUES (?, ?, 'legacy', 'legacy.observed', 'legacy', '{}', ?)`,
      suppressed_patterns:
        `INSERT INTO suppressed_patterns (id, tenant_id, pattern, created_at)
         VALUES (?, ?, 'legacy-pattern', ?)`,
    };
    try {
      for (const table of LEGACY_OWNERSHIP_TABLES) {
        for (const [label, tenantId] of [
          ["null", null],
          ["empty", ""],
          ["blank", "   "],
        ] as const) {
          expect.soft(() => sealed.prepare(insertSql[table]).run(
            `${table}-late-${label}`,
            tenantId,
            TS,
          )).toThrow("tenant_id_required");
          expect.soft(() => sealed.prepare(
            `UPDATE ${table} SET tenant_id = ? WHERE id = ?`,
          ).run(tenantId, `${table}-valid`)).toThrow("tenant_id_required");
        }
      }
    } finally {
      sealed.close();
    }

    attestExactReconciliationScope(path);
    const restarted = boot(path);
    for (const table of LEGACY_OWNERSHIP_TABLES) {
      expect(restarted.raw.prepare(
        `SELECT id FROM ${table} WHERE id LIKE ? ORDER BY id`,
      ).all(`${table}-late-%`)).toEqual([]);
      expect(restarted.raw.prepare(
        `SELECT tenant_id FROM ${table} WHERE id = ?`,
      ).get(`${table}-valid`)).toEqual({ tenant_id: "tenant_customer" });
    }
    for (const tenantId of [undefined, "tenant_default", "tenant_customer", "tenant_other"]) {
      expect(claimNextJob(restarted, ["repair"], {
        tenantId,
        workerId: `late-write-worker:${tenantId ?? "global"}`,
        now: "2026-09-02T00:10:00.000Z",
      })).toBeUndefined();
    }
  });

  it("never publishes a partial recovery-guard state to another connection", () => {
    const path = join(newDir("tenant-recovery-guard-atomicity"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyReleasedFallbackBackfill(path);
    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    attestExactReconciliationScope(path);

    const ledgerTables = [
      "legacy_tenant_ownership_reconciliation_scope",
      "legacy_tenant_ownership_reconciliation_state",
      "legacy_tenant_ownership_reconciliation_discovery_state",
      "legacy_tenant_ownership_quarantine_scope",
      "legacy_tenant_ownership_quarantine_state",
    ] as const;
    const requiredGuards = [
      ...LEGACY_OWNERSHIP_TABLES.flatMap((table) => [
        `${table}_tenant_required_insert`,
        `${table}_tenant_required_update`,
        `${table}_tenant_nonblank_insert`,
        `${table}_tenant_nonblank_update`,
        `${table}_legacy_tenant_ownership_default_insert`,
        `${table}_legacy_tenant_ownership_update`,
        `${table}_legacy_tenant_ownership_delete`,
      ]),
      ...ledgerTables.flatMap((table) => [
        `${table}_append_only_update`,
        `${table}_append_only_delete`,
      ]),
      "legacy_tenant_ownership_reconciliation_scope_append_only_insert",
      "legacy_tenant_ownership_quarantine_scope_append_only_insert",
    ];
    const predecessor = new DatabaseSync(path);
    for (const trigger of requiredGuards) {
      predecessor.exec(`DROP TRIGGER IF EXISTS "${trigger}"`);
    }
    predecessor.close();

    const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
    if (!originalExec || typeof originalExec.value !== "function") {
      throw new Error("database_sync_exec_unavailable");
    }
    const partialSnapshots: string[][] = [];
    let racedWriteSucceeded = false;
    Object.defineProperty(DatabaseSync.prototype, "exec", {
      ...originalExec,
      value: function (this: DatabaseSync, sql: string): void {
        originalExec.value.call(this, sql);
        if (sql.trim() !== "COMMIT" || racedWriteSucceeded) return;

        const observer = new DatabaseSync(path);
        try {
          const published = new Set(
            (observer.prepare(
              "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
            ).all() as Array<{ name: string }>).map(({ name }) => name),
          );
          const nonblankPublished = LEGACY_OWNERSHIP_TABLES.every((table) =>
            published.has(`${table}_tenant_nonblank_insert`) &&
            published.has(`${table}_tenant_nonblank_update`),
          );
          const missing = requiredGuards.filter((trigger) => !published.has(trigger));
          if (nonblankPublished && missing.length > 0) {
            partialSnapshots.push(missing);
            observer.prepare(
              "UPDATE jobs SET tenant_id = 'tenant_other' WHERE id = 'jobs-empty'",
            ).run();
            racedWriteSucceeded = true;
          }
        } finally {
          observer.close();
        }
      },
    });

    let recoveryError: unknown;
    try {
      boot(path);
    } catch (error) {
      recoveryError = error;
    } finally {
      Object.defineProperty(DatabaseSync.prototype, "exec", originalExec);
    }

    expect.soft(recoveryError).toBeUndefined();
    expect.soft(partialSnapshots).toEqual([]);
    expect.soft(racedWriteSucceeded).toBe(false);
    const observed = new DatabaseSync(path);
    try {
      expect(observed.prepare(
        "SELECT tenant_id FROM jobs WHERE id = 'jobs-empty'",
      ).get()).toEqual({ tenant_id: "tenant_default" });
      const published = new Set(
        (observed.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
        ).all() as Array<{ name: string }>).map(({ name }) => name),
      );
      expect(requiredGuards.every((trigger) => published.has(trigger))).toBe(true);
    } finally {
      observed.close();
    }
  });

  it("prevents a scoped primary-key rename from escaping attestation through identifier reuse", () => {
    const path = join(newDir("tenant-attested-source-identity-immutable"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);
    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    attestExactReconciliationScope(path);

    const authorized = boot(path);
    expect(() => {
      authorized.raw.prepare(
        "UPDATE jobs SET id = 'jobs-renamed' WHERE id = 'jobs-empty'",
      ).run();
      authorized.raw.prepare(
        "UPDATE jobs SET tenant_id = 'tenant_other' WHERE id = 'jobs-renamed'",
      ).run();
      authorized.raw.prepare(
        `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
         VALUES ('jobs-empty', 'tenant_default', 'repair', '{}', ?)`,
      ).run(TS);
      closeTracked(authorized);

      const restarted = boot(path);
      const escaped = claimNextJob(restarted, ["repair"], {
        tenantId: "tenant_other",
        workerId: "cross-tenant-worker",
        now: "2026-09-02T00:10:00.000Z",
      });
      if (escaped) throw new Error(`cross_tenant_identifier_reuse:${escaped.id}`);
    }).toThrow("legacy_tenant_ownership_source_immutable");

    closeTracked(authorized);
    const restarted = boot(path);
    expect(claimNextJob(restarted, ["repair"], {
      tenantId: "tenant_other",
      workerId: "cross-tenant-worker",
      now: "2026-09-02T00:10:00.000Z",
    })).toBeUndefined();
    expect(getJob(restarted, "jobs-empty", "tenant_default")).toMatchObject({
      id: "jobs-empty",
      tenant_id: "tenant_default",
    });
  });

  it.each(LEGACY_OWNERSHIP_TABLES)(
    "makes scoped %s source identifiers immutable",
    (table) => {
      const path = join(newDir(`tenant-scoped-${table}-identity-immutable`), "legacy.sqlite");
      buildLegacyOwnershipVolume(path);
      applyExactReleasedPredecessorTenantMigration(path);
      expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
      attestExactReconciliationScope(path);

      const authorized = boot(path);
      expect(() => authorized.raw.prepare(
        `UPDATE ${table} SET id = ? WHERE id = ?`,
      ).run(`${table}-renamed`, `${table}-empty`)).toThrow();
      expect(() => authorized.raw.prepare(
        `UPDATE ${table} SET tenant_id = ? WHERE id = ?`,
      ).run("tenant_other", `${table}-empty`)).toThrow();
      expect(() => authorized.raw.prepare(
        `DELETE FROM ${table} WHERE id = ?`,
      ).run(`${table}-empty`)).toThrow();
      expect(authorized.raw.prepare(
        `SELECT id, tenant_id FROM ${table} WHERE id = ?`,
      ).get(`${table}-empty`)).toEqual({
        id: `${table}-empty`,
        tenant_id: "tenant_default",
      });
    },
  );

  it("permits same-tenant repair-session progress without weakening source guards", () => {
    const path = join(newDir("tenant-attested-repair-session-progress"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);
    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    attestExactReconciliationScope(path);

    const authorized = boot(path);
    insertRepairSession(authorized, {
      id: "repair_sessions-empty",
      tenantId: "tenant_default",
      consumerId: "consumer-reviewed",
      repoPath: "/repo",
      status: "verified",
      attempts: 1,
      editsCount: 2,
      ok: true,
      reportMd: "reviewed",
      createdAt: TS,
      finishedAt: "2026-09-02T00:10:00.000Z",
    });

    expect(getRepairSession(
      authorized,
      "repair_sessions-empty",
      "tenant_default",
    )).toMatchObject({
      id: "repair_sessions-empty",
      tenant_id: "tenant_default",
      status: "verified",
      attempts: 1,
      edits_count: 2,
      ok: 1,
    });
    expect(() => authorized.raw.prepare(
      `UPDATE repair_sessions
       SET tenant_id = 'tenant_other'
       WHERE id = 'repair_sessions-empty'`,
    ).run()).toThrow("legacy_tenant_ownership_source_immutable");
    expect(() => authorized.raw.prepare(
      `UPDATE repair_sessions
       SET id = 'repair_sessions-renamed'
       WHERE id = 'repair_sessions-empty'`,
    ).run()).toThrow("legacy_tenant_ownership_source_immutable");
    expect(() => authorized.raw.prepare(
      "DELETE FROM repair_sessions WHERE id = 'repair_sessions-empty'",
    ).run()).toThrow("legacy_tenant_ownership_source_immutable");
  });

  it("rejects a source-row tenant mismatch at every restart", () => {
    const path = join(newDir("tenant-attested-source-revalidated"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyExactReleasedPredecessorTenantMigration(path);
    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
    attestExactReconciliationScope(path);

    const authorized = boot(path);
    authorized.raw.exec("DROP TRIGGER IF EXISTS jobs_legacy_tenant_ownership_update");
    authorized.raw.exec("DROP TRIGGER IF EXISTS jobs_legacy_tenant_ownership_delete");
    authorized.raw.prepare(
      "UPDATE jobs SET tenant_id = 'tenant_other' WHERE id = 'jobs-empty'",
    ).run();
    closeTracked(authorized);

    expect(() => boot(path)).toThrow("legacy_tenant_ownership_reconciliation_required");
  });

  it("fails closed when a prior released boot already laundered unknown ownership", () => {
    const path = join(newDir("tenant-two-step-laundering"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyReleasedFallbackBackfill(path);

    expect(() => boot(path)).toThrow(
      "legacy_tenant_ownership_reconciliation_required",
    );

    const preserved = new DatabaseSync(path);
    try {
      expect(
        preserved
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'trigger'
               AND name IN (
                 'legacy_tenant_ownership_reconciliation_scope_append_only_update',
                 'legacy_tenant_ownership_reconciliation_scope_append_only_delete',
                 'legacy_tenant_ownership_reconciliation_state_append_only_update',
                 'legacy_tenant_ownership_reconciliation_state_append_only_delete'
               )
             ORDER BY name`,
          )
          .all(),
      ).toHaveLength(4);
      for (const table of LEGACY_OWNERSHIP_TABLES) {
        expect(
          preserved
            .prepare(`SELECT id, tenant_id FROM ${table} ORDER BY id`)
            .all(),
        ).toEqual([
          { id: `${table}-empty`, tenant_id: "tenant_default" },
          { id: `${table}-null`, tenant_id: "tenant_default" },
          { id: `${table}-valid`, tenant_id: "tenant_customer" },
          { id: `${table}-whitespace`, tenant_id: "   " },
        ]);
      }
    } finally {
      preserved.close();
    }
  });

  it("rejects a mutated persisted operator attestation", () => {
    const path = join(newDir("tenant-mutated-attestation"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyReleasedFallbackBackfill(path);
    persistLegacyOwnershipAttestations(path, ({ attestationDigest }) => ({
      attestationDigest: `0${attestationDigest.slice(1)}`,
    }));

    expect(() => boot(path)).toThrow(
      "legacy_tenant_ownership_reconciliation_required",
    );
  });

  it("accepts exact persisted operator attestations for preexisting fallback rows", () => {
    const path = join(newDir("tenant-exact-attestation"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    applyReleasedFallbackBackfill(path);
    persistLegacyOwnershipAttestations(path);

    const migrated = boot(path);
    for (const table of LEGACY_OWNERSHIP_TABLES) {
      expect(
        migrated.raw
          .prepare(
            `SELECT id FROM ${table}
             WHERE tenant_id = 'tenant_default'
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: `${table}-empty` },
        { id: `${table}-null` },
      ]);
    }
  });

  it("keeps a fresh legacy row unattributable when the tenant column is introduced", () => {
    const path = join(newDir("tenant-fresh-upgrade"), "legacy.sqlite");
    buildLegacyJobVolume(path, "missing", [{ id: "fresh-unknown", tenantId: null }]);

    const migrated = boot(path);

    expect(jobTenants(migrated)).toEqual([{ id: "fresh-unknown", tenant_id: null }]);
    expect(
      migrated.raw
        .prepare("SELECT id FROM jobs WHERE tenant_id = 'tenant_default'")
        .all(),
    ).toEqual([]);
    expect(claimNextJob(migrated, ["repair"], {
      workerId: "review-worker",
      now: "2026-01-02T00:00:00.000Z",
    })).toBeUndefined();
  });

  it("preserves aged null, empty, and valid tenant ownership without laundering", () => {
    const path = join(newDir("tenant-aged-upgrade"), "aged.sqlite");
    buildLegacyJobVolume(path, "nullable", [
      { id: "aged-empty", tenantId: "" },
      { id: "aged-null", tenantId: null },
      { id: "aged-valid", tenantId: "tenant_customer" },
      { id: "aged-whitespace", tenantId: "   " },
    ]);

    const migrated = boot(path);

    expect(jobTenants(migrated)).toEqual([
      { id: "aged-empty", tenant_id: "" },
      { id: "aged-null", tenant_id: null },
      { id: "aged-valid", tenant_id: "tenant_customer" },
      { id: "aged-whitespace", tenant_id: "   " },
    ]);
    expect(
      migrated.raw
        .prepare("SELECT id FROM jobs WHERE tenant_id = 'tenant_default'")
        .all(),
    ).toEqual([]);
    expect(claimNextJob(migrated, ["repair"], {
      workerId: "review-worker",
      now: "2026-01-02T00:00:00.000Z",
    })).toMatchObject({ id: "aged-valid", tenant_id: "tenant_customer" });
    expect(claimNextJob(migrated, ["repair"], {
      workerId: "review-worker",
      now: "2026-01-02T00:00:00.000Z",
    })).toBeUndefined();
  });

  it("quarantines unattributable ownership across every migration-touched table", () => {
    const path = join(newDir("tenant-all-table-upgrade"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);

    const migrated = boot(path);

    for (const table of LEGACY_OWNERSHIP_TABLES) {
      expect(
        migrated.raw.prepare(`SELECT id, tenant_id FROM ${table} ORDER BY id`).all(),
      ).toEqual([
        { id: `${table}-empty`, tenant_id: "" },
        { id: `${table}-null`, tenant_id: null },
        { id: `${table}-valid`, tenant_id: "tenant_customer" },
        { id: `${table}-whitespace`, tenant_id: "   " },
      ]);
      expect(
        migrated.raw
          .prepare(`SELECT id FROM ${table} WHERE tenant_id = 'tenant_default'`)
          .all(),
      ).toEqual([]);
    }
  });

  it("rejects whitespace-only ownership on every relevant future insert and update", () => {
    const path = join(newDir("tenant-write-guards"), "legacy.sqlite");
    buildLegacyOwnershipVolume(path);
    const migrated = boot(path);

    const inserts = [
      `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
       VALUES ('jobs-new-whitespace', '   ', 'repair', '{}', '${TS}')`,
      `INSERT INTO repair_sessions (id, tenant_id, repo_path, status, created_at)
       VALUES ('repair_sessions-new-whitespace', '   ', '/repo', 'pending', '${TS}')`,
      `INSERT INTO agent_runs (id, tenant_id, goal, repo_path, status, created_at)
       VALUES ('agent_runs-new-whitespace', '   ', 'repair', '/repo', 'pending', '${TS}')`,
      `INSERT INTO audit_events
         (id, tenant_id, actor, action, resource_type, metadata_json, created_at)
       VALUES ('audit_events-new-whitespace', '   ', 'legacy', 'legacy.observed', 'legacy', '{}', '${TS}')`,
      `INSERT INTO suppressed_patterns (id, tenant_id, pattern, created_at)
       VALUES ('suppressed_patterns-new-whitespace', '   ', 'legacy-pattern', '${TS}')`,
    ];
    for (const statement of inserts) {
      expect(() => migrated.raw.exec(statement)).toThrow("tenant_id_required");
    }

    for (const table of ["jobs", "repair_sessions", "agent_runs", "suppressed_patterns"]) {
      expect(() => migrated.raw.exec(
        `UPDATE ${table} SET tenant_id = '   ' WHERE id = '${table}-valid'`,
      )).toThrow("tenant_id_required");
    }
    expect(() => migrated.raw.exec(
      "UPDATE audit_events SET tenant_id = '   ' WHERE id = 'audit_events-valid'",
    )).toThrow();

    expect(() => enqueueJob(migrated, {
      id: "enqueue-whitespace",
      tenantId: "   ",
      type: "repair",
      payload: {},
      createdAt: TS,
    })).toThrow("tenant_id_required");
  });

  it("resumes an interrupted tenant-column upgrade without claiming unknown rows", () => {
    const path = join(newDir("tenant-interrupted-upgrade"), "interrupted.sqlite");
    buildLegacyJobVolume(path, "missing", [{ id: "interrupted-null", tenantId: null }]);
    const interrupted = new DatabaseSync(path);
    interrupted.exec("ALTER TABLE jobs ADD COLUMN tenant_id TEXT");
    interrupted.prepare(
      `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
       VALUES ('interrupted-valid', 'tenant_customer', 'repair', '{}', ?)`,
    ).run(TS);
    interrupted.close();

    const migrated = boot(path);

    expect(jobTenants(migrated)).toEqual([
      { id: "interrupted-null", tenant_id: null },
      { id: "interrupted-valid", tenant_id: "tenant_customer" },
    ]);
  });

  it("keeps the quarantine stable on rerun and rejects new unattributed writes", () => {
    const path = join(newDir("tenant-rerun-upgrade"), "rerun.sqlite");
    buildLegacyJobVolume(path, "nullable", [
      { id: "rerun-empty", tenantId: "" },
      { id: "rerun-null", tenantId: null },
    ]);

    const first = boot(path);
    closeTracked(first);
    const second = boot(path);

    expect(jobTenants(second)).toEqual([
      { id: "rerun-empty", tenant_id: "" },
      { id: "rerun-null", tenant_id: null },
    ]);
    expect(() =>
      second.raw.prepare(
        `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
         VALUES ('new-null', NULL, 'repair', '{}', ?)`,
      ).run(TS),
    ).toThrow("tenant_id_required");
    expect(() =>
      second.raw.prepare(
        `INSERT INTO jobs (id, tenant_id, type, payload_json, created_at)
         VALUES ('new-empty', '', 'repair', '{}', ?)`,
      ).run(TS),
    ).toThrow("tenant_id_required");
  });

  it("survives the literal base rollback backfill and repair reapplication", () => {
    const path = join(newDir("tenant-literal-base-rollback"), "legacy.sqlite");
    buildLegacyJobVolume(path, "missing", [{ id: "rollback-unknown", tenantId: null }]);

    const repaired = boot(path);
    expect(jobTenants(repaired)).toEqual([{ id: "rollback-unknown", tenant_id: null }]);
    closeTracked(repaired);

    const rollback = new DatabaseSync(path);
    let rollbackError: unknown;
    try {
      rollback.prepare(
        `UPDATE jobs
         SET tenant_id = 'tenant_default'
         WHERE tenant_id IS NULL OR tenant_id = ''`,
      ).run();
    } catch (error) {
      rollbackError = error;
    } finally {
      rollback.close();
    }

    const reapplied = boot(path);
    expect(rollbackError).toBeInstanceOf(Error);
    expect((rollbackError as Error).message).toContain(
      "legacy_tenant_ownership_source_immutable",
    );
    expect(jobTenants(reapplied)).toEqual([{ id: "rollback-unknown", tenant_id: null }]);
    expect(claimNextJob(reapplied, ["repair"], {
      tenantId: "tenant_default",
      workerId: "rollback-worker",
      now: "2026-09-02T00:10:00.000Z",
    })).toBeUndefined();
    expect(claimNextJob(reapplied, ["repair"], {
      workerId: "rollback-worker",
      now: "2026-09-02T00:10:00.000Z",
    })).toBeUndefined();
  });

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

  it("converges Mission authority columns from a genuine pre-rename schema", () => {
    const path = join(newDir("rename-mission-authority"), "legacy.sqlite");
    buildVolume(path, new Set(NEW_TABLES));
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE warden_candidate_deliveries DROP COLUMN mission_authority_json;
      ALTER TABLE warden_ci_cycles DROP COLUMN mission_authority_json;
      ALTER TABLE warden_ci_updates DROP COLUMN mission_authority_json;
    `);
    legacy.close();

    const migrated = boot(path);
    const fresh = boot(join(newDir("rename-mission-authority-fresh"), "fresh.sqlite"));
    expect(dumpSchema(migrated)).toEqual(dumpSchema(fresh));
    expect(migrated.raw.prepare(`SELECT mission_authority_json FROM fettler_candidate_deliveries
      WHERE id = 'del1'`).get()).toEqual({ mission_authority_json: null });
    expect(migrated.raw.prepare(`SELECT mission_authority_json FROM fettler_ci_cycles
      WHERE id = 'cyc1'`).get()).toEqual({ mission_authority_json: null });
    expect(migrated.raw.prepare(`SELECT mission_authority_json FROM fettler_ci_updates
      WHERE id = 'upd1'`).get()).toEqual({ mission_authority_json: null });
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
