import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";

// Shared content-addressing and validation for the three Mission durable-record
// stores (decisions, exceptions, verification history). Each record's primary
// key is a sha256 digest over canonical JSON that INCLUDES tenant_id, so a
// different tenant produces a different primary key by construction (Change
// Graph Tier-1 binding). Cross-tenant collision is arithmetically impossible,
// not merely filtered.

// Deterministic, key-sorted canonicalization so a content digest is stable
// regardless of property insertion order. Mirrors the Change Graph canonical
// form in packages/graph-learn/src/software-intelligence.ts.
function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = canonicalValue(source[key]);
  return out;
}

// 64-hex sha256 of the canonical JSON. Used as both the row id and the stored
// content_digest so a row is self-verifying and identical logical content
// replays instead of duplicating.
export function contentDigest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(body)), "utf8").digest("hex");
}

// Reject empty, over-length, and control-character-bearing text. Tab, newline,
// and carriage-return are permitted; all other C0 controls are rejected.
export function boundedText(value: string, code: string, max: number): string {
  if (typeof value !== "string") throw new Error(code);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw new Error(code);
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    // Permit tab (9), newline (10), carriage-return (13); reject other C0 controls.
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) throw new Error(code);
  }
  return trimmed;
}

export function exactUtc(value: string, code: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(code);
  return value;
}

export function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

// A mission-scoped record must bind to a mission of the SAME tenant. The
// composite foreign key (tenant_id, mission_id) -> mission(tenant_id, id)
// enforces this at INSERT; this pre-check turns the raw constraint failure into
// a named error and is the fail-closed guard callers see.
export function assertMissionScope(db: AppDb, tenantId: string, missionId: string): void {
  if (!one(db, `SELECT id FROM mission WHERE id = ? AND tenant_id = ?`, [missionId, tenantId])) {
    throw new Error("mission_record_mission_not_found");
  }
}

// The acting/owning principal must be a non-revoked principal of the same
// tenant. Mirrors the assertPrincipal guard in mission.ts.
export function assertRecordPrincipal(db: AppDb, tenantId: string, principalId: string, code: string): void {
  if (!one(db, `SELECT id FROM principals WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`, [principalId, tenantId])) {
    throw new Error(code);
  }
}
