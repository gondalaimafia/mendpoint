import type { AppDb } from "./index.js";
import { appendDomainEvent } from "./trust.js";
import {
  all,
  assertMissionScope,
  assertRecordPrincipal,
  boundedText,
  contentDigest,
  exactUtc,
  one,
} from "./mission-record-content.js";

// Mission decision log (task brief §1). A durable record of a decision with
// FUTURE CONSEQUENCE for the mission — the kind a later task would make a worse
// choice without: "use a compatibility shim for phase 1", "delay the database
// migration until stage 3", "do not modify generated SDK code". Conversational
// comments do not belong here; only decisions that constrain later work.
//
// The store is append-only (BEFORE UPDATE/DELETE triggers in the schema). A
// change of mind never overwrites: it is a new row that either SUPERSEDES the
// prior decision (a replacement) or RETRACTS it (a withdrawal). The supersession
// structure is therefore a chain, and the whole chain — every prior decision —
// stays readable. The effective status of a decision is DERIVED from the chain,
// so a superseded decision is reported as superseded without any row mutation.

export type MissionDecisionStatus = "active" | "retracted";

// The status a reader cares about: whether this decision still governs. `active`
// and `retracted` are the writer-declared row status; `superseded` is derived —
// a later row supersedes this one.
export type MissionDecisionEffectiveStatus = "active" | "superseded" | "retracted";

export type MissionDecision = Readonly<{
  id: string;
  tenantId: string;
  missionId: string;
  decision: string;
  scope: string;
  authorPrincipalId: string;
  evidence: readonly string[];
  status: MissionDecisionStatus;
  supersedesId: string | null;
  contentDigest: string;
  createdAt: string;
  decisionType: string | null;
}>;

// A decision annotated with its position in the supersession chain.
export type MissionDecisionView = MissionDecision &
  Readonly<{ effectiveStatus: MissionDecisionEffectiveStatus; supersededById: string | null }>;

type MissionDecisionRow = {
  id: string;
  tenant_id: string;
  mission_id: string;
  decision: string;
  scope: string;
  author_principal_id: string;
  evidence_json: string;
  status: MissionDecisionStatus;
  supersedes_id: string | null;
  content_digest: string;
  created_at: string;
  decision_type: string | null;
};

export const MISSION_DECISION_TYPES = [
  "architecture",
  "migration",
  "policy",
  "verification",
  "exception_resolution",
  "preference",
  "other",
] as const;
export type MissionDecisionType = (typeof MISSION_DECISION_TYPES)[number];
const DECISION_TYPE_SET = new Set<string>(MISSION_DECISION_TYPES);

function normalizeDecisionType(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!DECISION_TYPE_SET.has(value)) throw new Error("mission_decision_type_invalid");
  return value;
}

const MAX_DECISION = 4_000;
const MAX_SCOPE = 512;
const MAX_EVIDENCE_REFS = 64;
const MAX_EVIDENCE_REF = 1_024;

function normalizeEvidence(evidence: readonly string[] | undefined): string[] {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence)) throw new Error("mission_decision_evidence_invalid");
  if (evidence.length > MAX_EVIDENCE_REFS) throw new Error("mission_decision_evidence_invalid");
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of evidence) {
    const trimmed = boundedText(ref, "mission_decision_evidence_invalid", MAX_EVIDENCE_REF);
    if (seen.has(trimmed)) throw new Error("mission_decision_evidence_invalid");
    seen.add(trimmed);
    refs.push(trimmed);
  }
  return refs;
}

function hydrate(row: MissionDecisionRow): MissionDecision {
  const parsed = JSON.parse(row.evidence_json) as unknown;
  const evidence = Array.isArray(parsed) ? (parsed as string[]) : [];
  const body = decisionDigestBody({
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    decision: row.decision,
    scope: row.scope,
    authorPrincipalId: row.author_principal_id,
    evidence,
    status: row.status,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
  });
  if (contentDigest(body) !== row.content_digest || row.content_digest !== row.id) {
    throw new Error("mission_decision_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    decision: row.decision,
    scope: row.scope,
    authorPrincipalId: row.author_principal_id,
    evidence: Object.freeze(evidence),
    status: row.status,
    supersedesId: row.supersedes_id,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
    decisionType: row.decision_type ?? null,
  });
}

function decisionDigestBody(input: {
  tenantId: string;
  missionId: string;
  decision: string;
  scope: string;
  authorPrincipalId: string;
  evidence: readonly string[];
  status: MissionDecisionStatus;
  supersedesId: string | null;
  createdAt: string;
}) {
  // tenant_id is the first field of the digested body, so the primary key is
  // tenant-bound by construction. Change graph Tier-1 pattern.
  return {
    kind: "mission_decision",
    schemaVersion: 1,
    tenantId: input.tenantId,
    missionId: input.missionId,
    decision: input.decision,
    scope: input.scope,
    authorPrincipalId: input.authorPrincipalId,
    evidence: input.evidence,
    status: input.status,
    supersedesId: input.supersedesId,
    createdAt: input.createdAt,
  };
}

function insertDecision(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  decision: string;
  scope: string;
  authorPrincipalId: string;
  evidence: readonly string[];
  status: MissionDecisionStatus;
  supersedesId: string | null;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
  decisionType?: string | null;
}): MissionDecision {
  const body = decisionDigestBody(input);
  const digest = contentDigest(body);
  // decision_type is outside the content digest, so validate it before the
  // replay branch; otherwise an invalid type is rejected on first write but
  // silently accepted when an identical body replays.
  const decisionType = normalizeDecisionType(input.decisionType);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<MissionDecisionRow>(db, `SELECT * FROM mission_decisions WHERE id = ?`, [digest]);
    if (existing) {
      // Content-addressed: an identical logical decision replays rather than
      // duplicating. Because the id IS the digest of the whole body, any row
      // with this id necessarily has identical content.
      const value = hydrate(existing);
      if (owns) db.raw.exec("COMMIT");
      return value;
    }
    db.raw.prepare(`INSERT INTO mission_decisions
      (id, tenant_id, mission_id, decision, scope, author_principal_id, evidence_json,
       status, supersedes_id, content_digest, created_at, decision_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      digest, input.tenantId, input.missionId, input.decision, input.scope, input.authorPrincipalId,
      JSON.stringify(input.evidence), input.status, input.supersedesId, digest, input.createdAt,
      decisionType);
    appendDomainEvent(db, {
      id: `mission-decision:${digest}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: input.supersedesId ? "mission.decision_superseded" : "mission.decision_recorded",
      aggregateType: "mission",
      aggregateId: input.missionId,
      actorPrincipalId: input.authorPrincipalId,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      idempotencyKey: `mission-decision:${digest}`,
      payload: {
        decisionId: digest,
        scope: input.scope,
        status: input.status,
        supersedesId: input.supersedesId,
      },
      createdAt: input.createdAt,
    });
    const value = hydrate(one<MissionDecisionRow>(db, `SELECT * FROM mission_decisions WHERE id = ?`, [digest])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

// Record a new active decision for a mission.
export function recordMissionDecision(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  decision: string;
  scope: string;
  authorPrincipalId: string;
  evidence?: readonly string[];
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
  decisionType?: string | null;
}): MissionDecision {
  const decision = boundedText(input.decision, "mission_decision_text_invalid", MAX_DECISION);
  const scope = boundedText(input.scope, "mission_decision_scope_invalid", MAX_SCOPE);
  const correlationId = boundedText(input.correlationId, "mission_decision_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_decision_created_at_invalid");
  const evidence = normalizeEvidence(input.evidence);
  assertMissionScope(db, input.tenantId, input.missionId);
  assertRecordPrincipal(db, input.tenantId, input.authorPrincipalId, "mission_decision_author_tenant_mismatch");
  return insertDecision(db, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    decision,
    scope,
    authorPrincipalId: input.authorPrincipalId,
    evidence,
    status: "active",
    supersedesId: null,
    correlationId,
    causationId: input.causationId ?? null,
    createdAt,
    decisionType: input.decisionType ?? null,
  });
}

function loadDecisionForSupersession(db: AppDb, tenantId: string, priorId: string): MissionDecisionRow {
  const prior = one<MissionDecisionRow>(db,
    `SELECT * FROM mission_decisions WHERE id = ? AND tenant_id = ?`, [priorId, tenantId]);
  if (!prior) throw new Error("mission_decision_prior_not_found");
  return prior;
}

// Supersede a prior decision with a new active decision. The prior decision is
// not mutated; it becomes effectiveStatus 'superseded' because this new row
// points at it. The unique index on (tenant_id, supersedes_id) makes the chain
// linear: a decision may be superseded at most once.
export function supersedeMissionDecision(db: AppDb, input: {
  tenantId: string;
  priorDecisionId: string;
  decision: string;
  scope: string;
  authorPrincipalId: string;
  evidence?: readonly string[];
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
  decisionType?: string | null;
}): MissionDecision {
  const decision = boundedText(input.decision, "mission_decision_text_invalid", MAX_DECISION);
  const scope = boundedText(input.scope, "mission_decision_scope_invalid", MAX_SCOPE);
  const correlationId = boundedText(input.correlationId, "mission_decision_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_decision_created_at_invalid");
  const evidence = normalizeEvidence(input.evidence);
  assertRecordPrincipal(db, input.tenantId, input.authorPrincipalId, "mission_decision_author_tenant_mismatch");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const prior = loadDecisionForSupersession(db, input.tenantId, input.priorDecisionId);
    const already = one<{ id: string }>(db,
      `SELECT id FROM mission_decisions WHERE tenant_id = ? AND supersedes_id = ?`,
      [input.tenantId, input.priorDecisionId]);
    if (already && already.id !== contentDigest(decisionDigestBody({
      tenantId: input.tenantId, missionId: prior.mission_id, decision, scope,
      authorPrincipalId: input.authorPrincipalId, evidence, status: "active",
      supersedesId: input.priorDecisionId, createdAt,
    }))) {
      throw new Error("mission_decision_already_superseded");
    }
    const value = insertDecision(db, {
      tenantId: input.tenantId,
      missionId: prior.mission_id,
      decision,
      scope,
      authorPrincipalId: input.authorPrincipalId,
      evidence,
      status: "active",
      supersedesId: input.priorDecisionId,
      correlationId,
      causationId: input.causationId ?? null,
      createdAt,
      // Keep the decision labelled: use the caller's type when supplied, else
      // inherit the prior head so a superseded decision is not left unlabeled.
      decisionType: input.decisionType ?? prior.decision_type,
    });
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

// Withdraw a prior decision without replacing it. A retraction is itself a new
// row that supersedes the prior (so the prior reads as 'superseded') and carries
// status 'retracted' with the withdrawal rationale, so the chain records both
// that the prior decision no longer holds and why.
export function retractMissionDecision(db: AppDb, input: {
  tenantId: string;
  priorDecisionId: string;
  rationale: string;
  authorPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
}): MissionDecision {
  const rationale = boundedText(input.rationale, "mission_decision_text_invalid", MAX_DECISION);
  const correlationId = boundedText(input.correlationId, "mission_decision_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_decision_created_at_invalid");
  assertRecordPrincipal(db, input.tenantId, input.authorPrincipalId, "mission_decision_author_tenant_mismatch");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const prior = loadDecisionForSupersession(db, input.tenantId, input.priorDecisionId);
    const already = one<{ id: string }>(db,
      `SELECT id FROM mission_decisions WHERE tenant_id = ? AND supersedes_id = ?`,
      [input.tenantId, input.priorDecisionId]);
    const digestBody = decisionDigestBody({
      tenantId: input.tenantId, missionId: prior.mission_id, decision: rationale, scope: prior.scope,
      authorPrincipalId: input.authorPrincipalId, evidence: [], status: "retracted",
      supersedesId: input.priorDecisionId, createdAt,
    });
    if (already && already.id !== contentDigest(digestBody)) {
      throw new Error("mission_decision_already_superseded");
    }
    const value = insertDecision(db, {
      tenantId: input.tenantId,
      missionId: prior.mission_id,
      decision: rationale,
      scope: prior.scope,
      authorPrincipalId: input.authorPrincipalId,
      evidence: [],
      status: "retracted",
      supersedesId: input.priorDecisionId,
      correlationId,
      causationId: input.causationId ?? null,
      createdAt,
    });
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function annotate(rows: MissionDecisionRow[]): MissionDecisionView[] {
  const supersededBy = new Map<string, string>();
  for (const row of rows) {
    if (row.supersedes_id) supersededBy.set(row.supersedes_id, row.id);
  }
  return rows.map((row) => {
    const decision = hydrate(row);
    const supersededById = supersededBy.get(row.id) ?? null;
    const effectiveStatus: MissionDecisionEffectiveStatus = supersededById
      ? "superseded"
      : decision.status;
    return Object.freeze({ ...decision, effectiveStatus, supersededById });
  });
}

// Full decision history for a mission, oldest first, each annotated with its
// place in the supersession chain. The chain always survives.
export function listMissionDecisions(db: AppDb, tenantId: string, missionId: string): MissionDecisionView[] {
  const rows = all<MissionDecisionRow>(db,
    `SELECT * FROM mission_decisions WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at, id`,
    [tenantId, missionId]);
  return annotate(rows);
}

// The decisions that still govern the mission: not superseded, not retracted.
// This is what a later task should read to avoid making a worse choice.
export function getActiveMissionDecisions(db: AppDb, tenantId: string, missionId: string): MissionDecisionView[] {
  return listMissionDecisions(db, tenantId, missionId).filter((d) => d.effectiveStatus === "active");
}

export function getMissionDecision(db: AppDb, tenantId: string, decisionId: string): MissionDecisionView | undefined {
  const row = one<MissionDecisionRow>(db,
    `SELECT * FROM mission_decisions WHERE id = ? AND tenant_id = ?`, [decisionId, tenantId]);
  if (!row) return undefined;
  return annotate(all<MissionDecisionRow>(db,
    `SELECT * FROM mission_decisions WHERE tenant_id = ? AND mission_id = ?`,
    [tenantId, row.mission_id])).find((d) => d.id === decisionId);
}
