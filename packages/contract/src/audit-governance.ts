import { createHash } from "node:crypto";

export const AUDIT_GOVERNANCE_SCHEMA_VERSION = 1 as const;

export const AUDIT_RETENTION_DAYS = Object.freeze({
  operational: 90,
  security: 400,
  financial: 2555,
  regulated: 2555,
});

export type AuditRetentionClass = keyof typeof AUDIT_RETENTION_DAYS;
export type AuditRedactionProfile = "support" | "security" | "minimal";

export type GovernedAuditRecord = Readonly<{
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  retentionClass: AuditRetentionClass;
  occurredAt: string;
  metadata: Readonly<Record<string, unknown>>;
  sourceEventHash: string;
}>;

export type AuditLegalHold = Readonly<{
  id: string;
  tenantId: string;
  status: "active" | "released";
  reason: string;
  resourceType?: string;
  resourceId?: string;
  eventIds?: readonly string[];
  createdAt: string;
  releasedAt?: string;
}>;

export type AuditRetentionDecision = Readonly<{
  recordId: string;
  disposition: "retain" | "eligible_for_deletion";
  reason: "within_retention" | "legal_hold" | "retention_elapsed";
  retainUntil: string;
  legalHoldIds: readonly string[];
}>;

export type AuditExportDestination = Readonly<{
  uri: string;
  ownerTenantId: string;
}>;

export type AuditExportRecord = Omit<GovernedAuditRecord, "metadata" | "actorId"> &
  Readonly<{
    actorId: string;
    metadata: Readonly<Record<string, unknown>>;
    previousExportHash: string | null;
    exportHash: string;
  }>;

export type GovernedAuditExport = Readonly<{
  schemaVersion: typeof AUDIT_GOVERNANCE_SCHEMA_VERSION;
  exportId: string;
  tenantId: string;
  requestedByActorId: string;
  destination: AuditExportDestination;
  redactionProfile: AuditRedactionProfile;
  createdAt: string;
  records: readonly AuditExportRecord[];
  sha256: string;
}>;

const HASH = /^[a-f0-9]{64}$/;
const DESTINATION = /^(customer|s3|gs|azure):\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{1,1023}$/;
const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|private.?key|credential)/i;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function validDate(value: string, error: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(error);
  return parsed;
}

function matchingHolds(record: GovernedAuditRecord, holds: readonly AuditLegalHold[]) {
  return holds.filter((hold) => {
    if (hold.tenantId !== record.tenantId || hold.status !== "active") return false;
    if (hold.eventIds?.includes(record.id)) return true;
    return hold.resourceType === record.resourceType && hold.resourceId === record.resourceId;
  });
}

export function evaluateAuditRetention(
  record: GovernedAuditRecord,
  holds: readonly AuditLegalHold[],
  now: Date,
): AuditRetentionDecision {
  const occurredAt = validDate(record.occurredAt, "audit_occurred_at_invalid");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("audit_retention_now_invalid");
  const retentionDays = AUDIT_RETENTION_DAYS[record.retentionClass];
  if (!retentionDays) throw new Error("audit_retention_class_invalid");
  const retainUntilMs = occurredAt + retentionDays * 86_400_000;
  const activeHolds = matchingHolds(record, holds);
  return Object.freeze({
    recordId: record.id,
    disposition:
      activeHolds.length > 0 || nowMs < retainUntilMs ? "retain" : "eligible_for_deletion",
    reason:
      activeHolds.length > 0
        ? "legal_hold"
        : nowMs < retainUntilMs
          ? "within_retention"
          : "retention_elapsed",
    retainUntil: new Date(retainUntilMs).toISOString(),
    legalHoldIds: Object.freeze(activeHolds.map((hold) => hold.id).sort()),
  });
}

function redactValue(value: unknown, profile: AuditRedactionProfile): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => redactValue(item, profile)));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[REDACTED]";
    } else if (profile === "minimal") {
      continue;
    } else if (profile === "security" && /^(body|content|source|patch|prompt)$/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactValue(child, profile);
    }
  }
  return Object.freeze(output);
}

function validateRecord(record: GovernedAuditRecord, tenantId: string): void {
  if (record.tenantId !== tenantId) throw new Error("audit_export_tenant_mismatch");
  if (!HASH.test(record.sourceEventHash)) throw new Error("audit_source_hash_invalid");
  validDate(record.occurredAt, "audit_occurred_at_invalid");
}

function exportRecordHash(record: Omit<AuditExportRecord, "exportHash">): string {
  return sha256(canonical(record));
}

function exportDigest(input: Omit<GovernedAuditExport, "sha256">): string {
  return sha256(canonical(input));
}

export function createGovernedAuditExport(input: Readonly<{
  exportId: string;
  tenantId: string;
  requestedByActorId: string;
  destination: AuditExportDestination;
  redactionProfile: AuditRedactionProfile;
  createdAt: string;
  records: readonly GovernedAuditRecord[];
}>): GovernedAuditExport {
  validDate(input.createdAt, "audit_export_created_at_invalid");
  if (input.destination.ownerTenantId !== input.tenantId) {
    throw new Error("audit_export_destination_tenant_mismatch");
  }
  if (!DESTINATION.test(input.destination.uri)) throw new Error("audit_export_destination_invalid");
  const records: AuditExportRecord[] = [];
  let previousExportHash: string | null = null;
  for (const source of [...input.records].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
  )) {
    validateRecord(source, input.tenantId);
    const actorId =
      input.redactionProfile === "minimal" ? `actor_sha256:${sha256(source.actorId)}` : source.actorId;
    const withoutHash: Omit<AuditExportRecord, "exportHash"> = Object.freeze({
      ...source,
      actorId,
      metadata: redactValue(source.metadata, input.redactionProfile) as Readonly<Record<string, unknown>>,
      previousExportHash,
    });
    const record: AuditExportRecord = Object.freeze({
      ...withoutHash,
      exportHash: exportRecordHash(withoutHash),
    });
    records.push(record);
    previousExportHash = record.exportHash;
  }
  const envelope = Object.freeze({
    schemaVersion: AUDIT_GOVERNANCE_SCHEMA_VERSION,
    exportId: input.exportId,
    tenantId: input.tenantId,
    requestedByActorId: input.requestedByActorId,
    destination: Object.freeze({ ...input.destination }),
    redactionProfile: input.redactionProfile,
    createdAt: input.createdAt,
    records: Object.freeze(records),
  });
  return Object.freeze({ ...envelope, sha256: exportDigest(envelope) });
}

export function verifyGovernedAuditExport(bundle: GovernedAuditExport): Readonly<{
  ok: boolean;
  checked: number;
  error?: string;
}> {
  let previousExportHash: string | null = null;
  for (const record of bundle.records) {
    if (record.tenantId !== bundle.tenantId) {
      return { ok: false, checked: 0, error: `audit_export_tenant:${record.id}` };
    }
    const { exportHash, ...withoutHash } = record;
    if (record.previousExportHash !== previousExportHash || exportRecordHash(withoutHash) !== exportHash) {
      return { ok: false, checked: 0, error: `audit_export_chain:${record.id}` };
    }
    previousExportHash = exportHash;
  }
  const { sha256: actual, ...envelope } = bundle;
  if (exportDigest(envelope) !== actual) {
    return { ok: false, checked: bundle.records.length, error: "audit_export_digest" };
  }
  return { ok: true, checked: bundle.records.length };
}
