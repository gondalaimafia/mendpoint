/**
 * Organization Memory: a durable, tenant-scoped store for organizational
 * conventions and preferences (spec: docs/memory/ORGANIZATION_MEMORY.md).
 *
 * This store holds *preferences and conventions* — "we prefer the internal auth
 * client over direct OAuth calls", "squash-merge only", "no em dashes in user
 * copy". It is strictly separate from the Change Graph, which holds *what the
 * code objectively is*. Objective, verifiable code facts do NOT belong here.
 *
 * Three properties are load-bearing and each has a deletable control with a
 * test that dies when the control is removed:
 *
 *  1. Governance — a single observation can never become ACTIVE memory.
 *     Promotion to ACTIVE requires EITHER an explicit human confirmation OR
 *     repeated independent corroboration (>= CORROBORATION_THRESHOLD distinct
 *     observations). The threshold is explicit in `assessActivation`, not
 *     implicit in a query.
 *  2. Structural tenant binding (Tier 1) — record_id is `omv1:` + the sha256 of
 *     the canonical body, and the body INCLUDES tenant_id. A different tenant
 *     produces a different primary key by construction; cross-tenant collision
 *     is arithmetically impossible, not merely filtered. Reads re-hash and
 *     re-assert the tenant (mirrors gl_software_versions_v1).
 *  3. Append-only history — every transition and every edit is a NEW immutable
 *     row on a supersession chain keyed by memory_id. An edit or disable never
 *     destroys prior history; the current state is the chain head, re-queried on
 *     every check so a disable takes effect with no redeploy and no cache.
 *
 * Fail closed: `assessActivation` returns an honest three-state result —
 * `eligible` with a named basis, or `blocked` with a DISTINCT reason. "Could not
 * determine" never collapses into the reassuring value (house template:
 * fettler-delegation-evidence.ts).
 */
import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";

export const ORGANIZATION_MEMORY_CATEGORIES = [
  "ARCHITECTURE_CONVENTION",
  "CODING_CONVENTION",
  "MIGRATION_PREFERENCE",
  "TESTING_REQUIREMENT",
  "REVIEW_PREFERENCE",
  "DEPLOYMENT_POLICY",
  "RISK_PREFERENCE",
  "INTERNAL_ABSTRACTION",
  "PRESENTATION_PREFERENCE",
] as const;
export type OrganizationMemoryCategory = (typeof ORGANIZATION_MEMORY_CATEGORIES)[number];

export const ORGANIZATION_MEMORY_SOURCES = [
  "explicit",
  "policy_config",
  "repeated_verified_behavior",
  "reviewer_correction",
] as const;
export type OrganizationMemorySource = (typeof ORGANIZATION_MEMORY_SOURCES)[number];

export type OrganizationMemoryConfidence = "low" | "medium" | "high";

export const ORGANIZATION_MEMORY_STATUSES = [
  "OBSERVATION",
  "MEMORY_CANDIDATE",
  "VALIDATION",
  "CONFIRMED",
  "ACTIVE",
  "REJECTED",
  "STALE",
  "DISABLED",
  "DELETED",
] as const;
export type OrganizationMemoryStatus = (typeof ORGANIZATION_MEMORY_STATUSES)[number];

export type OrganizationMemoryTransition =
  | "observed"
  | "corroborated"
  | "validated"
  | "human_confirmed"
  | "activated"
  | "created_explicit"
  | "edited"
  | "disabled"
  | "rejected"
  | "staled"
  | "deleted";

/**
 * Promotion threshold. A single observation is corroboration count 1, which is
 * strictly below this, so it can never satisfy the corroboration branch of
 * `assessActivation`. Two INDEPENDENT observations (distinct fingerprints,
 * enforced by the UNIQUE (tenant_id, memory_id, observation_fingerprint) index)
 * are required.
 */
export const CORROBORATION_THRESHOLD = 2;

/** Statuses from which a chain is no longer open to lifecycle transitions. */
const TERMINAL_STATUSES: ReadonlySet<OrganizationMemoryStatus> = new Set([
  "REJECTED",
  "STALE",
  "DISABLED",
  "DELETED",
]);

export type OrganizationMemoryRecord = Readonly<{
  recordId: string;
  tenantId: string;
  memoryId: string;
  revision: number;
  supersedesRecordId: string | null;
  transition: OrganizationMemoryTransition;
  scope: string;
  category: OrganizationMemoryCategory;
  statement: string;
  structuredValue: unknown;
  source: OrganizationMemorySource;
  sourceRefs: readonly string[];
  observationFingerprint: string | null;
  confidence: OrganizationMemoryConfidence;
  status: OrganizationMemoryStatus;
  appliesTo: readonly string[];
  trainingEligible: boolean;
  actorPrincipalId: string | null;
  reason: string;
  contentSha256: string;
  createdAt: string;
  lastConfirmedAt: string | null;
}>;

type OrganizationMemoryRow = {
  record_id: string;
  tenant_id: string;
  memory_id: string;
  revision: number;
  supersedes_record_id: string | null;
  transition: OrganizationMemoryTransition;
  scope: string;
  category: OrganizationMemoryCategory;
  statement: string;
  structured_value: string | null;
  source: OrganizationMemorySource;
  source_refs: string;
  observation_fingerprint: string | null;
  confidence: OrganizationMemoryConfidence;
  status: OrganizationMemoryStatus;
  applies_to: string;
  training_eligible: number;
  actor_principal_id: string | null;
  reason: string;
  content_sha256: string;
  created_at: string;
  last_confirmed_at: string | null;
};

/** Honest three-state assessment of whether a chain may be activated. */
export type OrganizationMemoryActivationBlockReason =
  | "memory_not_found"
  | "already_active"
  | "status_terminal"
  | "insufficient_corroboration";

export type OrganizationMemoryActivationAssessment =
  | Readonly<{ status: "eligible"; basis: "human_confirmation" | "independent_corroboration" }>
  | Readonly<{ status: "blocked"; reason: OrganizationMemoryActivationBlockReason }>;

// ---------------------------------------------------------------------------
// Local helpers (each db module keeps its own; only the AppDb type is shared).
// ---------------------------------------------------------------------------

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function requireText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function requireIso(name: string, value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

/** Deterministic canonical JSON: object keys sorted, numbers finite. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("organization_memory_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("organization_memory_value_invalid");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The immutable content body that identifies a record. record_id and
 * content_sha256 are derived from this and therefore excluded from it. tenant_id
 * is the first field, so the digest — and thus the primary key — is bound to the
 * tenant by construction.
 */
function canonicalBody(record: Omit<OrganizationMemoryRecord, "recordId" | "contentSha256">): string {
  return canonicalJson({
    tenantId: record.tenantId,
    memoryId: record.memoryId,
    revision: record.revision,
    supersedesRecordId: record.supersedesRecordId,
    transition: record.transition,
    scope: record.scope,
    category: record.category,
    statement: record.statement,
    structuredValue: record.structuredValue ?? null,
    source: record.source,
    sourceRefs: [...record.sourceRefs],
    observationFingerprint: record.observationFingerprint,
    confidence: record.confidence,
    status: record.status,
    appliesTo: [...record.appliesTo],
    trainingEligible: record.trainingEligible,
    actorPrincipalId: record.actorPrincipalId,
    reason: record.reason,
    createdAt: record.createdAt,
    lastConfirmedAt: record.lastConfirmedAt,
  });
}

function hydrate(row: OrganizationMemoryRow, expectedTenantId?: string): OrganizationMemoryRecord {
  const record: OrganizationMemoryRecord = {
    recordId: row.record_id,
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    revision: row.revision,
    supersedesRecordId: row.supersedes_record_id,
    transition: row.transition,
    scope: row.scope,
    category: row.category,
    statement: row.statement,
    structuredValue: row.structured_value === null ? null : JSON.parse(row.structured_value),
    source: row.source,
    sourceRefs: JSON.parse(row.source_refs) as string[],
    observationFingerprint: row.observation_fingerprint,
    confidence: row.confidence,
    status: row.status,
    appliesTo: JSON.parse(row.applies_to) as string[],
    trainingEligible: row.training_eligible === 1,
    actorPrincipalId: row.actor_principal_id,
    reason: row.reason,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
  };
  // Structural re-verification: recompute the digest and assert it matches the
  // stored primary key and content hash, and that the body's tenant is the one
  // asked for. A tampered row, or a row read under the wrong tenant, is rejected
  // rather than trusted.
  const digest = sha256Hex(canonicalBody(record));
  if (digest !== record.contentSha256 || `omv1:${digest}` !== record.recordId) {
    throw new Error("organization_memory_integrity_failed");
  }
  if (expectedTenantId !== undefined && record.tenantId !== expectedTenantId) {
    throw new Error("organization_memory_tenant_mismatch");
  }
  return Object.freeze(record);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Deterministic logical id grouping a supersession chain. Independent
 * observations of the SAME convention (same tenant, category, scope, subject)
 * map to the same memory_id and therefore corroborate one candidate rather than
 * spawning separate ones.
 */
export function organizationMemoryId(input: {
  tenantId: string;
  category: OrganizationMemoryCategory;
  scope: string;
  subjectKey: string;
}): string {
  const digest = sha256Hex(
    canonicalJson({
      tenantId: requireText("organization_memory_tenant", input.tenantId),
      category: input.category,
      scope: requireText("organization_memory_scope", input.scope),
      subjectKey: requireText("organization_memory_subject_key", input.subjectKey),
    }),
  );
  return `om:${digest}`;
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

function chainRows(db: AppDb, tenantId: string, memoryId: string): OrganizationMemoryRow[] {
  return many<OrganizationMemoryRow>(
    db,
    `SELECT * FROM organization_memory WHERE tenant_id = ? AND memory_id = ? ORDER BY revision ASC`,
    [tenantId, memoryId],
  );
}

function chainRecords(db: AppDb, tenantId: string, memoryId: string): OrganizationMemoryRecord[] {
  return chainRows(db, tenantId, memoryId).map((row) => hydrate(row, tenantId));
}

/** The current state of a memory: the highest-revision row on its chain. */
export function getOrganizationMemoryHead(
  db: AppDb,
  tenantId: string,
  memoryId: string,
): OrganizationMemoryRecord | undefined {
  requireText("organization_memory_tenant", tenantId);
  requireText("organization_memory_id", memoryId);
  const row = one<OrganizationMemoryRow>(
    db,
    `SELECT * FROM organization_memory WHERE tenant_id = ? AND memory_id = ?
       ORDER BY revision DESC LIMIT 1`,
    [tenantId, memoryId],
  );
  return row ? hydrate(row, tenantId) : undefined;
}

/** Full immutable history of a memory, oldest revision first. */
export function getOrganizationMemoryProvenance(
  db: AppDb,
  tenantId: string,
  memoryId: string,
): OrganizationMemoryRecord[] {
  requireText("organization_memory_tenant", tenantId);
  requireText("organization_memory_id", memoryId);
  return chainRecords(db, tenantId, memoryId);
}

/** Scope view: where a memory applies. Head-only. */
export function getOrganizationMemoryScope(
  db: AppDb,
  tenantId: string,
  memoryId: string,
):
  | Readonly<{
      memoryId: string;
      scope: string;
      category: OrganizationMemoryCategory;
      appliesTo: readonly string[];
      source: OrganizationMemorySource;
      status: OrganizationMemoryStatus;
    }>
  | undefined {
  const head = getOrganizationMemoryHead(db, tenantId, memoryId);
  if (!head) return undefined;
  return Object.freeze({
    memoryId: head.memoryId,
    scope: head.scope,
    category: head.category,
    appliesTo: head.appliesTo,
    source: head.source,
    status: head.status,
  });
}

/** List the current head of every memory in a tenant, optionally by status. */
export function listOrganizationMemory(
  db: AppDb,
  input: { tenantId: string; status?: OrganizationMemoryStatus | readonly OrganizationMemoryStatus[] },
): OrganizationMemoryRecord[] {
  requireText("organization_memory_tenant", input.tenantId);
  const rows = many<OrganizationMemoryRow>(
    db,
    `SELECT m.* FROM organization_memory m
       JOIN (
         SELECT memory_id, MAX(revision) AS revision
           FROM organization_memory WHERE tenant_id = ? GROUP BY memory_id
       ) head ON head.memory_id = m.memory_id AND head.revision = m.revision
      WHERE m.tenant_id = ?
      ORDER BY m.memory_id`,
    [input.tenantId, input.tenantId],
  );
  const records = rows.map((row) => hydrate(row, input.tenantId));
  if (input.status === undefined) return records;
  const wanted = new Set(Array.isArray(input.status) ? input.status : [input.status]);
  return records.filter((record) => wanted.has(record.status));
}

// ---------------------------------------------------------------------------
// Governance: the single activation control
// ---------------------------------------------------------------------------

function countDistinctObservations(chain: readonly OrganizationMemoryRecord[]): number {
  const fingerprints = new Set<string>();
  for (const record of chain) {
    // Rows created before evidence-bound observation authority have no actor.
    // They remain visible history but cannot contribute to corroboration.
    if (record.observationFingerprint !== null && record.actorPrincipalId !== null && record.sourceRefs.length > 0) {
      fingerprints.add(record.observationFingerprint);
    }
  }
  return fingerprints.size;
}

function chainHasHumanConfirmation(chain: readonly OrganizationMemoryRecord[]): boolean {
  return chain.some(
    (record) => record.transition === "human_confirmed" || record.transition === "created_explicit",
  );
}

/**
 * The central governance control. Given a prospective chain (existing rows, or
 * the single row about to be written for an explicit creation), decide whether
 * activation to ACTIVE is permitted, and on what basis. Deleting the
 * corroboration guard below lets a lone observation reach ACTIVE — the
 * `one observation cannot reach ACTIVE` test dies when it is removed.
 */
export function assessActivation(
  chain: readonly OrganizationMemoryRecord[],
): OrganizationMemoryActivationAssessment {
  if (chain.length === 0) return { status: "blocked", reason: "memory_not_found" };
  const head = chain[chain.length - 1]!;
  if (head.status === "ACTIVE") return { status: "blocked", reason: "already_active" };
  if (TERMINAL_STATUSES.has(head.status)) return { status: "blocked", reason: "status_terminal" };
  const humanConfirmed = chainHasHumanConfirmation(chain);
  const distinct = countDistinctObservations(chain);
  if (!humanConfirmed && distinct < CORROBORATION_THRESHOLD) {
    return { status: "blocked", reason: "insufficient_corroboration" };
  }
  return {
    status: "eligible",
    basis: humanConfirmed ? "human_confirmation" : "independent_corroboration",
  };
}

// ---------------------------------------------------------------------------
// Writes (all append-only)
// ---------------------------------------------------------------------------

function insertRecord(db: AppDb, record: Omit<OrganizationMemoryRecord, "recordId" | "contentSha256">): OrganizationMemoryRecord {
  const contentSha256 = sha256Hex(canonicalBody(record));
  const recordId = `omv1:${contentSha256}`;
  db.raw
    .prepare(
      `INSERT INTO organization_memory (
         record_id, tenant_id, memory_id, revision, supersedes_record_id, transition,
         scope, category, statement, structured_value, source, source_refs,
         observation_fingerprint, confidence, status, applies_to, training_eligible,
         actor_principal_id, reason, content_sha256, created_at, last_confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      recordId,
      record.tenantId,
      record.memoryId,
      record.revision,
      record.supersedesRecordId,
      record.transition,
      record.scope,
      record.category,
      record.statement,
      record.structuredValue === null || record.structuredValue === undefined
        ? null
        : JSON.stringify(record.structuredValue),
      record.source,
      JSON.stringify([...record.sourceRefs]),
      record.observationFingerprint,
      record.confidence,
      record.status,
      JSON.stringify([...record.appliesTo]),
      record.trainingEligible ? 1 : 0,
      record.actorPrincipalId,
      record.reason,
      contentSha256,
      record.createdAt,
      record.lastConfirmedAt,
    );
  return hydrate(
    one<OrganizationMemoryRow>(db, `SELECT * FROM organization_memory WHERE record_id = ?`, [recordId])!,
    record.tenantId,
  );
}

function withTransaction<T>(db: AppDb, fn: () => T): T {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (owns) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function validateCategory(value: unknown): OrganizationMemoryCategory {
  if (!ORGANIZATION_MEMORY_CATEGORIES.includes(value as OrganizationMemoryCategory)) {
    throw new Error("organization_memory_category_invalid");
  }
  return value as OrganizationMemoryCategory;
}

function validateConfidence(value: unknown): OrganizationMemoryConfidence {
  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new Error("organization_memory_confidence_invalid");
  }
  return value;
}

function normalizeRefs(name: string, value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name}_invalid`);
  return value.map((entry) => requireText(name, entry));
}

type ObservationEvidenceAuthority = Readonly<{
  id: string;
  subject_type: string;
  subject_id: string;
  producer_principal_id: string | null;
  verdict: string;
}>;

function observationAuthority(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    memoryId: string;
    observerPrincipalId: string;
    sourceRefs: readonly string[] | undefined;
    observedAt: string;
  }>,
): Readonly<{ sourceRefs: readonly string[]; fingerprint: string }> {
  const principalId = requireText("organization_memory_observer_principal", input.observerPrincipalId);
  const principal = one<{ id: string; revoked_at: string | null; expires_at: string | null }>(
    db,
    `SELECT id, revoked_at, expires_at FROM principals WHERE id = ? AND tenant_id = ?`,
    [principalId, input.tenantId],
  );
  const expiresAt = principal?.expires_at === null ? null : Date.parse(principal?.expires_at ?? "");
  if (!principal || principal.revoked_at !== null ||
      (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(input.observedAt)))) {
    throw new Error("organization_memory_observer_authority_invalid");
  }
  const sourceRefs = normalizeRefs("organization_memory_source_ref", input.sourceRefs)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (sourceRefs.length === 0 || new Set(sourceRefs).size !== sourceRefs.length) {
    throw new Error("organization_memory_evidence_invalid");
  }
  for (const sourceRef of sourceRefs) {
    const evidence = one<ObservationEvidenceAuthority>(
      db,
      `SELECT id, subject_type, subject_id, producer_principal_id, verdict
         FROM evidence_records WHERE id = ? AND tenant_id = ?`,
      [sourceRef, input.tenantId],
    );
    if (!evidence || evidence.subject_type !== "organization_memory_observation" ||
        evidence.subject_id !== input.memoryId || evidence.producer_principal_id !== principalId ||
        evidence.verdict !== "passed") {
      throw new Error("organization_memory_evidence_invalid");
    }
  }
  return Object.freeze({
    sourceRefs: Object.freeze(sourceRefs),
    fingerprint: sha256Hex(canonicalJson({
      tenantId: input.tenantId,
      memoryId: input.memoryId,
      observerPrincipalId: principalId,
      sourceRefs,
    })),
  });
}

function sameObservedMeaning(
  head: OrganizationMemoryRecord,
  input: Readonly<{ statement: string; structuredValue?: unknown; appliesTo?: readonly string[] }>,
): boolean {
  return head.statement === input.statement &&
    canonicalJson(head.structuredValue ?? null) === canonicalJson(input.structuredValue ?? null) &&
    canonicalJson([...head.appliesTo]) === canonicalJson(normalizeRefs("organization_memory_applies_to", input.appliesTo));
}

function assertCurrentIndependentObservationAuthority(
  db: AppDb,
  chain: readonly OrganizationMemoryRecord[],
  at: string,
): void {
  const observations = chain.filter((record) =>
    record.observationFingerprint !== null && record.actorPrincipalId !== null && record.sourceRefs.length > 0);
  const principals = new Set<string>();
  for (const record of observations) {
    const authority = observationAuthority(db, {
      tenantId: record.tenantId,
      memoryId: record.memoryId,
      observerPrincipalId: record.actorPrincipalId!,
      sourceRefs: record.sourceRefs,
      observedAt: at,
    });
    if (authority.fingerprint !== record.observationFingerprint || principals.has(record.actorPrincipalId!)) {
      throw new Error("organization_memory_evidence_invalid");
    }
    principals.add(record.actorPrincipalId!);
  }
  if (principals.size < CORROBORATION_THRESHOLD) {
    throw new Error("organization_memory_activation_blocked_insufficient_corroboration");
  }
}

/**
 * Record one observation of a convention. The FIRST observation creates a
 * MEMORY_CANDIDATE (never ACTIVE). Each subsequent INDEPENDENT observation
 * (a distinct authenticated principal with passed evidence) corroborates it; when the distinct count reaches
 * CORROBORATION_THRESHOLD the head advances to VALIDATION. Re-submitting the
 * same authority evidence is idempotent. `source` must be an inferred source — explicit
 * statements go through `createExplicitMemory`.
 */
export function recordOrganizationMemoryObservation(
  db: AppDb,
  input: {
    tenantId: string;
    category: OrganizationMemoryCategory;
    scope: string;
    subjectKey: string;
    statement: string;
    observerPrincipalId: string;
    source: Exclude<OrganizationMemorySource, "explicit">;
    confidence?: OrganizationMemoryConfidence;
    structuredValue?: unknown;
    sourceRefs?: readonly string[];
    appliesTo?: readonly string[];
    reason?: string;
    at: string;
  },
): OrganizationMemoryRecord {
  const tenantId = requireText("organization_memory_tenant", input.tenantId);
  const category = validateCategory(input.category);
  const scope = requireText("organization_memory_scope", input.scope);
  const statement = requireText("organization_memory_statement", input.statement);
  if (input.source === ("explicit" as OrganizationMemorySource)) {
    throw new Error("organization_memory_observation_source_invalid");
  }
  if (!ORGANIZATION_MEMORY_SOURCES.includes(input.source)) {
    throw new Error("organization_memory_observation_source_invalid");
  }
  const confidence = validateConfidence(input.confidence ?? "low");
  const at = requireIso("organization_memory_observed_at", input.at);
  const memoryId = organizationMemoryId({ tenantId, category, scope, subjectKey: input.subjectKey });

  return withTransaction(db, () => {
    const authority = observationAuthority(db, {
      tenantId,
      memoryId,
      observerPrincipalId: input.observerPrincipalId,
      sourceRefs: input.sourceRefs,
      observedAt: at,
    });
    const chain = chainRecords(db, tenantId, memoryId);
    if (chain.length === 0) {
      return insertRecord(db, {
        tenantId,
        memoryId,
        revision: 1,
        supersedesRecordId: null,
        transition: "observed",
        scope,
        category,
        statement,
        structuredValue: input.structuredValue ?? null,
        source: input.source,
        sourceRefs: authority.sourceRefs,
        observationFingerprint: authority.fingerprint,
        confidence,
        status: "MEMORY_CANDIDATE",
        appliesTo: normalizeRefs("organization_memory_applies_to", input.appliesTo),
        trainingEligible: false,
        actorPrincipalId: input.observerPrincipalId,
        reason: input.reason?.trim() ? input.reason : "observed",
        createdAt: at,
        lastConfirmedAt: null,
      });
    }
    const head = chain[chain.length - 1]!;
    if (TERMINAL_STATUSES.has(head.status)) {
      throw new Error("organization_memory_not_open");
    }
    if (!sameObservedMeaning(head, input)) {
      throw new Error("organization_memory_observation_conflict");
    }
    // Idempotent: this exact authenticated authority evidence already counted.
    if (chain.some((record) => record.observationFingerprint === authority.fingerprint)) {
      return head;
    }
    if (chain.some((record) => record.observationFingerprint !== null &&
        record.actorPrincipalId === input.observerPrincipalId)) {
      throw new Error("organization_memory_observation_not_independent");
    }
    const usedRefs = new Set(chain.flatMap((record) => [...record.sourceRefs]));
    if (authority.sourceRefs.some((sourceRef) => usedRefs.has(sourceRef))) {
      throw new Error("organization_memory_observation_not_independent");
    }
    const distinctAfter = countDistinctObservations(chain) + 1;
    const advancesToValidation =
      head.status === "MEMORY_CANDIDATE" && distinctAfter >= CORROBORATION_THRESHOLD;
    return insertRecord(db, {
      tenantId,
      memoryId,
      revision: head.revision + 1,
      supersedesRecordId: head.recordId,
      transition: advancesToValidation ? "validated" : "corroborated",
      scope: head.scope,
      category: head.category,
      statement: head.statement,
      structuredValue: head.structuredValue ?? null,
      source: input.source,
      sourceRefs: authority.sourceRefs,
      observationFingerprint: authority.fingerprint,
      confidence: head.confidence,
      status: advancesToValidation ? "VALIDATION" : head.status,
      appliesTo: head.appliesTo,
      trainingEligible: head.trainingEligible,
      actorPrincipalId: input.observerPrincipalId,
      reason: input.reason?.trim() ? input.reason : "corroborated",
      createdAt: at,
      lastConfirmedAt: head.lastConfirmedAt,
    });
  });
}

/**
 * Create a memory the organization stated directly. Requires a human principal.
 * An explicit statement is, by definition, human-confirmed, so it is created
 * ACTIVE — but it still routes through `assessActivation`, keeping one activation
 * control for every path to ACTIVE.
 */
export function createExplicitMemory(
  db: AppDb,
  input: {
    tenantId: string;
    category: OrganizationMemoryCategory;
    scope: string;
    subjectKey: string;
    statement: string;
    actorPrincipalId: string;
    confidence?: OrganizationMemoryConfidence;
    structuredValue?: unknown;
    sourceRefs?: readonly string[];
    appliesTo?: readonly string[];
    reason: string;
    at: string;
  },
): OrganizationMemoryRecord {
  const tenantId = requireText("organization_memory_tenant", input.tenantId);
  const category = validateCategory(input.category);
  const scope = requireText("organization_memory_scope", input.scope);
  const statement = requireText("organization_memory_statement", input.statement);
  const actorPrincipalId = requireText("organization_memory_actor", input.actorPrincipalId);
  const reason = requireText("organization_memory_reason", input.reason);
  const confidence = validateConfidence(input.confidence ?? "high");
  const at = requireIso("organization_memory_created_at", input.at);
  const memoryId = organizationMemoryId({ tenantId, category, scope, subjectKey: input.subjectKey });

  return withTransaction(db, () => {
    const chain = chainRecords(db, tenantId, memoryId);
    const head = chain[chain.length - 1];
    if (head && !TERMINAL_STATUSES.has(head.status)) {
      throw new Error("organization_memory_exists");
    }
    const revision = head ? head.revision + 1 : 1;
    const prospective: Omit<OrganizationMemoryRecord, "recordId" | "contentSha256"> = {
      tenantId,
      memoryId,
      revision,
      supersedesRecordId: head ? head.recordId : null,
      transition: "created_explicit",
      scope,
      category,
      statement,
      structuredValue: input.structuredValue ?? null,
      source: "explicit",
      sourceRefs: normalizeRefs("organization_memory_source_ref", input.sourceRefs),
      observationFingerprint: null,
      confidence,
      status: "ACTIVE",
      appliesTo: normalizeRefs("organization_memory_applies_to", input.appliesTo),
      trainingEligible: false,
      actorPrincipalId,
      reason,
      createdAt: at,
      lastConfirmedAt: at,
    };
    // Route the explicit creation through the shared activation control. The
    // synthetic row carries a pre-activation status (CONFIRMED) so the
    // `already_active` guard is not tripped; eligibility rests on the
    // created_explicit transition being a human confirmation.
    const assessment = assessActivation([
      { ...prospective, status: "CONFIRMED", recordId: "", contentSha256: "" } as OrganizationMemoryRecord,
    ]);
    if (assessment.status !== "eligible") {
      throw new Error(`organization_memory_activation_blocked_${assessment.reason}`);
    }
    return insertRecord(db, prospective);
  });
}

/** Human confirmation of a candidate: MEMORY_CANDIDATE|VALIDATION -> CONFIRMED. */
export function confirmOrganizationMemory(
  db: AppDb,
  input: { tenantId: string; memoryId: string; actorPrincipalId: string; reason: string; at: string },
): OrganizationMemoryRecord {
  const tenantId = requireText("organization_memory_tenant", input.tenantId);
  const memoryId = requireText("organization_memory_id", input.memoryId);
  const actorPrincipalId = requireText("organization_memory_actor", input.actorPrincipalId);
  const reason = requireText("organization_memory_reason", input.reason);
  const at = requireIso("organization_memory_confirmed_at", input.at);
  return withTransaction(db, () => {
    const chain = chainRecords(db, tenantId, memoryId);
    const head = chain[chain.length - 1];
    if (!head) throw new Error("organization_memory_not_found");
    if (head.status !== "MEMORY_CANDIDATE" && head.status !== "VALIDATION") {
      throw new Error("organization_memory_not_confirmable");
    }
    return insertRecord(db, {
      ...headBody(head),
      revision: head.revision + 1,
      supersedesRecordId: head.recordId,
      transition: "human_confirmed",
      status: "CONFIRMED",
      observationFingerprint: null,
      actorPrincipalId,
      reason,
      createdAt: at,
      lastConfirmedAt: at,
    });
  });
}

/**
 * Activate a memory: VALIDATION|CONFIRMED -> ACTIVE, gated by `assessActivation`.
 * A candidate backed by a single observation is blocked here.
 */
export function activateOrganizationMemory(
  db: AppDb,
  input: { tenantId: string; memoryId: string; actorPrincipalId?: string | null; reason: string; at: string },
): OrganizationMemoryRecord {
  const tenantId = requireText("organization_memory_tenant", input.tenantId);
  const memoryId = requireText("organization_memory_id", input.memoryId);
  const reason = requireText("organization_memory_reason", input.reason);
  const at = requireIso("organization_memory_activated_at", input.at);
  return withTransaction(db, () => {
    const chain = chainRecords(db, tenantId, memoryId);
    const head = chain[chain.length - 1];
    if (!head) throw new Error("organization_memory_not_found");
    const assessment = assessActivation(chain);
    if (assessment.status !== "eligible") {
      throw new Error(`organization_memory_activation_blocked_${assessment.reason}`);
    }
    if (assessment.basis === "independent_corroboration") {
      assertCurrentIndependentObservationAuthority(db, chain, at);
    }
    return insertRecord(db, {
      ...headBody(head),
      revision: head.revision + 1,
      supersedesRecordId: head.recordId,
      transition: "activated",
      status: "ACTIVE",
      observationFingerprint: null,
      actorPrincipalId: input.actorPrincipalId ?? null,
      reason,
      createdAt: at,
      lastConfirmedAt: at,
    });
  });
}

/** Reject a candidate: MEMORY_CANDIDATE|VALIDATION -> REJECTED. */
export function rejectOrganizationMemory(
  db: AppDb,
  input: { tenantId: string; memoryId: string; actorPrincipalId: string; reason: string; at: string },
): OrganizationMemoryRecord {
  return terminalTransition(db, {
    ...input,
    transition: "rejected",
    status: "REJECTED",
    from: new Set<OrganizationMemoryStatus>(["MEMORY_CANDIDATE", "VALIDATION"]),
    notFromError: "organization_memory_not_rejectable",
    requireActor: true,
  });
}

/** Disable an active or pending memory: -> DISABLED. Stops influencing at once. */
export function disableOrganizationMemory(
  db: AppDb,
  input: { tenantId: string; memoryId: string; actorPrincipalId: string; reason: string; at: string },
): OrganizationMemoryRecord {
  return terminalTransition(db, {
    ...input,
    transition: "disabled",
    status: "DISABLED",
    from: new Set<OrganizationMemoryStatus>([
      "OBSERVATION",
      "MEMORY_CANDIDATE",
      "VALIDATION",
      "CONFIRMED",
      "ACTIVE",
    ]),
    notFromError: "organization_memory_not_disableable",
    requireActor: true,
  });
}

/** Soft-delete a memory: -> DELETED. History is preserved (append-only). */
export function deleteOrganizationMemory(
  db: AppDb,
  input: { tenantId: string; memoryId: string; actorPrincipalId: string; reason: string; at: string },
): OrganizationMemoryRecord {
  return terminalTransition(db, {
    ...input,
    transition: "deleted",
    status: "DELETED",
    from: new Set<OrganizationMemoryStatus>([
      "OBSERVATION",
      "MEMORY_CANDIDATE",
      "VALIDATION",
      "CONFIRMED",
      "ACTIVE",
      "DISABLED",
    ]),
    notFromError: "organization_memory_not_deletable",
    requireActor: true,
  });
}

/** Mark a memory stale (e.g. long unconfirmed): CONFIRMED|ACTIVE -> STALE. */
export function markOrganizationMemoryStale(
  db: AppDb,
  input: { tenantId: string; memoryId: string; actorPrincipalId?: string | null; reason: string; at: string },
): OrganizationMemoryRecord {
  return terminalTransition(db, {
    ...input,
    actorPrincipalId: input.actorPrincipalId ?? null,
    transition: "staled",
    status: "STALE",
    from: new Set<OrganizationMemoryStatus>(["CONFIRMED", "ACTIVE"]),
    notFromError: "organization_memory_not_staleable",
    requireActor: false,
  });
}

/**
 * Edit a memory's content. Appends a NEW revision carrying the edited fields;
 * prior revisions remain immutable, so history is preserved rather than
 * destroyed. Status is carried forward. Not allowed on terminal chains.
 */
export function editOrganizationMemory(
  db: AppDb,
  input: {
    tenantId: string;
    memoryId: string;
    actorPrincipalId: string;
    reason: string;
    at: string;
    statement?: string;
    structuredValue?: unknown;
    confidence?: OrganizationMemoryConfidence;
    scope?: string;
    appliesTo?: readonly string[];
    sourceRefs?: readonly string[];
  },
): OrganizationMemoryRecord {
  const tenantId = requireText("organization_memory_tenant", input.tenantId);
  const memoryId = requireText("organization_memory_id", input.memoryId);
  const actorPrincipalId = requireText("organization_memory_actor", input.actorPrincipalId);
  const reason = requireText("organization_memory_reason", input.reason);
  const at = requireIso("organization_memory_edited_at", input.at);
  return withTransaction(db, () => {
    const chain = chainRecords(db, tenantId, memoryId);
    const head = chain[chain.length - 1];
    if (!head) throw new Error("organization_memory_not_found");
    if (TERMINAL_STATUSES.has(head.status)) throw new Error("organization_memory_not_editable");
    return insertRecord(db, {
      ...headBody(head),
      revision: head.revision + 1,
      supersedesRecordId: head.recordId,
      transition: "edited",
      status: head.status,
      statement: input.statement === undefined ? head.statement : requireText("organization_memory_statement", input.statement),
      structuredValue: input.structuredValue === undefined ? head.structuredValue ?? null : input.structuredValue,
      confidence: input.confidence === undefined ? head.confidence : validateConfidence(input.confidence),
      scope: input.scope === undefined ? head.scope : requireText("organization_memory_scope", input.scope),
      appliesTo: input.appliesTo === undefined ? head.appliesTo : normalizeRefs("organization_memory_applies_to", input.appliesTo),
      sourceRefs: input.sourceRefs === undefined ? head.sourceRefs : normalizeRefs("organization_memory_source_ref", input.sourceRefs),
      observationFingerprint: null,
      actorPrincipalId,
      reason,
      createdAt: at,
      lastConfirmedAt: head.lastConfirmedAt,
    });
  });
}

// ---------------------------------------------------------------------------
// Shared transition helpers
// ---------------------------------------------------------------------------

/** The carry-forward content of a head, minus the fields each transition sets. */
function headBody(
  head: OrganizationMemoryRecord,
): Omit<
  OrganizationMemoryRecord,
  "recordId" | "contentSha256" | "revision" | "supersedesRecordId" | "transition" | "status" | "observationFingerprint" | "actorPrincipalId" | "reason" | "createdAt" | "lastConfirmedAt"
> {
  return {
    tenantId: head.tenantId,
    memoryId: head.memoryId,
    scope: head.scope,
    category: head.category,
    statement: head.statement,
    structuredValue: head.structuredValue ?? null,
    source: head.source,
    sourceRefs: head.sourceRefs,
    confidence: head.confidence,
    appliesTo: head.appliesTo,
    trainingEligible: head.trainingEligible,
  };
}

function terminalTransition(
  db: AppDb,
  input: {
    tenantId: string;
    memoryId: string;
    actorPrincipalId?: string | null;
    reason: string;
    at: string;
    transition: OrganizationMemoryTransition;
    status: OrganizationMemoryStatus;
    from: ReadonlySet<OrganizationMemoryStatus>;
    notFromError: string;
    requireActor: boolean;
  },
): OrganizationMemoryRecord {
  const tenantId = requireText("organization_memory_tenant", input.tenantId);
  const memoryId = requireText("organization_memory_id", input.memoryId);
  const reason = requireText("organization_memory_reason", input.reason);
  const at = requireIso("organization_memory_transition_at", input.at);
  const actorPrincipalId = input.requireActor
    ? requireText("organization_memory_actor", input.actorPrincipalId ?? "")
    : input.actorPrincipalId ?? null;
  return withTransaction(db, () => {
    const chain = chainRecords(db, tenantId, memoryId);
    const head = chain[chain.length - 1];
    if (!head) throw new Error("organization_memory_not_found");
    if (!input.from.has(head.status)) throw new Error(input.notFromError);
    return insertRecord(db, {
      ...headBody(head),
      revision: head.revision + 1,
      supersedesRecordId: head.recordId,
      transition: input.transition,
      status: input.status,
      observationFingerprint: null,
      actorPrincipalId,
      reason,
      createdAt: at,
      lastConfirmedAt: head.lastConfirmedAt,
    });
  });
}
