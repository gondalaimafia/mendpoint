import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:\/{}-]{0,299}$/;

export type CapabilityAdoptionConsumerRef = Readonly<{
  consumerId: string;
  consumerName: string;
  evidence: string[];
}>;

export type CapabilityAdoptionOpportunityRecord = Readonly<{
  id: string;
  tenantId: string;
  changeId: string;
  providerSlug: string;
  capabilityId: string;
  op: string;
  endpoint: string;
  path: string | null;
  method: string | null;
  field: string | null;
  linkedConsumerCount: number;
  adoptingCount: number;
  nonAdoptingCount: number;
  adoptionRate: number;
  priority: number;
  adoptingConsumers: CapabilityAdoptionConsumerRef[];
  nonAdoptingConsumers: CapabilityAdoptionConsumerRef[];
  suggestedAction: string;
  valueBasis: string;
  createdAt: string;
  updatedAt: string;
}>;

type Row = {
  id: string;
  tenant_id: string;
  change_id: string;
  provider_slug: string;
  capability_id: string;
  op: string;
  endpoint: string;
  path: string | null;
  method: string | null;
  field: string | null;
  linked_consumer_count: number;
  adopting_count: number;
  non_adopting_count: number;
  adoption_rate: number;
  priority: number;
  adopting_consumers_json: string;
  non_adopting_consumers_json: string;
  suggested_action: string;
  value_basis: string;
  created_at: string;
  updated_at: string;
};

export type RecordCapabilityAdoptionOpportunityInput = Readonly<{
  tenantId: string;
  changeId: string;
  providerSlug: string;
  capabilityId: string;
  op: string;
  endpoint: string;
  path?: string | null;
  method?: string | null;
  field?: string | null;
  linkedConsumerCount: number;
  adoptingCount: number;
  nonAdoptingCount: number;
  adoptionRate: number;
  priority: number;
  adoptingConsumers: CapabilityAdoptionConsumerRef[];
  nonAdoptingConsumers: CapabilityAdoptionConsumerRef[];
  suggestedAction: string;
  valueBasis: string;
  now?: string;
}>;

function text(value: unknown, code: string, max = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(code);
  }
  return value.trim();
}

function id(value: unknown, code: string): string {
  const out = text(value, code, 300);
  if (!IDENTIFIER.test(out)) throw new Error(code);
  return out;
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(code);
  return value;
}

function count(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(code);
  return value;
}

function rate(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(code);
  }
  return value;
}

function optionalText(value: unknown, code: string, max = 4_000): string | null {
  if (value === undefined || value === null) return null;
  return text(value, code, max);
}

function refs(value: unknown, code: string): CapabilityAdoptionConsumerRef[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      consumerId: text(record.consumerId, code, 300),
      consumerName: text(record.consumerName, code, 500),
      evidence: Array.isArray(record.evidence)
        ? record.evidence.map((line) => text(line, code, 500))
        : [],
    };
  });
}

function deterministicId(tenantId: string, changeId: string, capabilityId: string): string {
  const hash = createHash("sha256")
    .update([tenantId, changeId, capabilityId].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `capabilityopp_${hash}`;
}

function map(row: Row): CapabilityAdoptionOpportunityRecord {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    changeId: row.change_id,
    providerSlug: row.provider_slug,
    capabilityId: row.capability_id,
    op: row.op,
    endpoint: row.endpoint,
    path: row.path,
    method: row.method,
    field: row.field,
    linkedConsumerCount: row.linked_consumer_count,
    adoptingCount: row.adopting_count,
    nonAdoptingCount: row.non_adopting_count,
    adoptionRate: row.adoption_rate,
    priority: row.priority,
    adoptingConsumers: JSON.parse(row.adopting_consumers_json) as CapabilityAdoptionConsumerRef[],
    nonAdoptingConsumers: JSON.parse(
      row.non_adopting_consumers_json,
    ) as CapabilityAdoptionConsumerRef[],
    suggestedAction: row.suggested_action,
    valueBasis: row.value_basis,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function getCapabilityAdoptionOpportunity(
  db: AppDb,
  tenantId: string,
  opportunityId: string,
): CapabilityAdoptionOpportunityRecord | undefined {
  const row = db.raw
    .prepare("SELECT * FROM capability_adoption_opportunities WHERE id = ? AND tenant_id = ?")
    .get(opportunityId, tenantId) as Row | undefined;
  return row ? map(row) : undefined;
}

export function listCapabilityAdoptionOpportunities(
  db: AppDb,
  tenantId: string,
  opts: { changeId?: string; providerSlug?: string } = {},
): CapabilityAdoptionOpportunityRecord[] {
  const clauses = ["tenant_id = ?"];
  const params: string[] = [tenantId];
  if (opts.changeId) {
    clauses.push("change_id = ?");
    params.push(opts.changeId);
  }
  if (opts.providerSlug) {
    clauses.push("provider_slug = ?");
    params.push(opts.providerSlug);
  }
  const rows = db.raw
    .prepare(
      `SELECT * FROM capability_adoption_opportunities WHERE ${clauses.join(" AND ")}
       ORDER BY priority DESC, capability_id ASC`,
    )
    .all(...params) as Row[];
  return rows.map(map);
}

/**
 * Idempotently record (or re-measure) a capability-adoption opportunity. The id
 * is deterministic per (tenant, change, capability); repeat calls upsert the
 * measured counts and keep created_at stable.
 */
export function recordCapabilityAdoptionOpportunity(
  db: AppDb,
  input: RecordCapabilityAdoptionOpportunityInput,
): CapabilityAdoptionOpportunityRecord {
  const tenantId = text(input.tenantId, "capability_adoption_opportunity_tenant_invalid", 200);
  const changeId = id(input.changeId, "capability_adoption_opportunity_change_invalid");
  const capabilityId = id(
    input.capabilityId,
    "capability_adoption_opportunity_capability_invalid",
  );
  const providerSlug = text(
    input.providerSlug,
    "capability_adoption_opportunity_provider_invalid",
    200,
  );
  const op = text(input.op, "capability_adoption_opportunity_op_invalid", 100);
  const endpoint = text(input.endpoint, "capability_adoption_opportunity_endpoint_invalid");
  const path = optionalText(input.path, "capability_adoption_opportunity_path_invalid");
  const method = optionalText(input.method, "capability_adoption_opportunity_method_invalid", 20);
  const field = optionalText(input.field, "capability_adoption_opportunity_field_invalid", 300);
  const linkedConsumerCount = count(
    input.linkedConsumerCount,
    "capability_adoption_opportunity_linked_invalid",
  );
  const adoptingCount = count(
    input.adoptingCount,
    "capability_adoption_opportunity_adopting_invalid",
  );
  const nonAdoptingCount = count(
    input.nonAdoptingCount,
    "capability_adoption_opportunity_non_adopting_invalid",
  );
  const adoptionRate = rate(input.adoptionRate, "capability_adoption_opportunity_rate_invalid");
  const priority = count(input.priority, "capability_adoption_opportunity_priority_invalid");
  const adoptingConsumers = refs(
    input.adoptingConsumers,
    "capability_adoption_opportunity_adopting_refs_invalid",
  );
  const nonAdoptingConsumers = refs(
    input.nonAdoptingConsumers,
    "capability_adoption_opportunity_non_adopting_refs_invalid",
  );
  const suggestedAction = text(
    input.suggestedAction,
    "capability_adoption_opportunity_action_invalid",
  );
  const valueBasis = text(input.valueBasis, "capability_adoption_opportunity_value_invalid");
  const now = timestamp(
    input.now ?? new Date().toISOString(),
    "capability_adoption_opportunity_timestamp_invalid",
  );
  const opportunityId = deterministicId(tenantId, changeId, capabilityId);

  db.raw
    .prepare(
      `INSERT INTO capability_adoption_opportunities
       (id, tenant_id, change_id, provider_slug, capability_id, op, endpoint, path, method, field,
        linked_consumer_count, adopting_count, non_adopting_count, adoption_rate, priority,
        adopting_consumers_json, non_adopting_consumers_json, suggested_action, value_basis,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, change_id, capability_id) DO UPDATE SET
         op = excluded.op,
         endpoint = excluded.endpoint,
         path = excluded.path,
         method = excluded.method,
         field = excluded.field,
         linked_consumer_count = excluded.linked_consumer_count,
         adopting_count = excluded.adopting_count,
         non_adopting_count = excluded.non_adopting_count,
         adoption_rate = excluded.adoption_rate,
         priority = excluded.priority,
         adopting_consumers_json = excluded.adopting_consumers_json,
         non_adopting_consumers_json = excluded.non_adopting_consumers_json,
         suggested_action = excluded.suggested_action,
         value_basis = excluded.value_basis,
         updated_at = excluded.updated_at`,
    )
    .run(
      opportunityId,
      tenantId,
      changeId,
      providerSlug,
      capabilityId,
      op,
      endpoint,
      path,
      method,
      field,
      linkedConsumerCount,
      adoptingCount,
      nonAdoptingCount,
      adoptionRate,
      priority,
      JSON.stringify(adoptingConsumers),
      JSON.stringify(nonAdoptingConsumers),
      suggestedAction,
      valueBasis,
      now,
      now,
    );

  return getCapabilityAdoptionOpportunity(db, tenantId, opportunityId)!;
}
