import { resolveRenamedEnv } from "@mendpoint/shared";

export const TRANSFORMER_GATE_SCHEMA_VERSION = "2026-08-02.v1" as const;

export const TRANSFORMER_GATE_BOUNDARIES = [
  "api_control_plane",
  "worker_action",
  "ui",
  "delivery",
] as const;

export type TransformerGateBoundary = (typeof TRANSFORMER_GATE_BOUNDARIES)[number];

export type TransformerGateGrant = Readonly<{
  tenantId: string;
  environment: string;
  boundaries: readonly TransformerGateBoundary[];
  acceptanceEvidenceRefs: readonly string[];
  productionDeliveryApprovalRefs: readonly string[];
}>;

export type TransformerGateConfig = Readonly<{
  schemaVersion: typeof TRANSFORMER_GATE_SCHEMA_VERSION;
  tenantAllowlist: readonly string[];
  environmentAllowlist: readonly string[];
  grants: readonly TransformerGateGrant[];
}>;

export type TransformerGateInput = Readonly<{
  tenantId: string;
  environment: string;
  boundary: TransformerGateBoundary;
  productionDeliveryApprovalRefs?: readonly string[];
}>;

export type TransformerGateDecision = Readonly<{
  allowed: boolean;
  schemaVersion: typeof TRANSFORMER_GATE_SCHEMA_VERSION;
  tenantId: string;
  environment: string;
  boundary: TransformerGateBoundary;
  reasons: readonly string[];
  acceptanceEvidenceRefs: readonly string[];
  productionDeliveryApprovalRefs: readonly string[];
}>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const boundarySet = new Set<string>(TRANSFORMER_GATE_BOUNDARIES);

function stringList(value: unknown, code: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(code);
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || !IDENTIFIER.test(entry)) throw new Error(code);
    return entry;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(code);
  return normalized;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const supplied = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (supplied.length !== expected.length || supplied.some((key, index) => key !== expected[index])) {
    throw new Error(code);
  }
}

export function parseTransformerGateConfig(raw: string | undefined): TransformerGateConfig {
  if (!raw?.trim()) throw new Error("transformer_gate_config_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("transformer_gate_config_malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("transformer_gate_config_malformed");
  }
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "tenantAllowlist", "environmentAllowlist", "grants"], "transformer_gate_config_malformed");
  if (value.schemaVersion !== TRANSFORMER_GATE_SCHEMA_VERSION) {
    throw new Error("transformer_gate_version_unsupported");
  }
  const tenantAllowlist = stringList(value.tenantAllowlist, "transformer_gate_tenant_allowlist_invalid");
  const environmentAllowlist = stringList(value.environmentAllowlist, "transformer_gate_environment_allowlist_invalid");
  if (!Array.isArray(value.grants) || value.grants.length === 0) {
    throw new Error("transformer_gate_grants_invalid");
  }
  const grantKeys = new Set<string>();
  const grants = value.grants.map((rawGrant) => {
    if (!rawGrant || typeof rawGrant !== "object" || Array.isArray(rawGrant)) {
      throw new Error("transformer_gate_grant_invalid");
    }
    const grant = rawGrant as Record<string, unknown>;
    exactKeys(
      grant,
      ["tenantId", "environment", "boundaries", "acceptanceEvidenceRefs", "productionDeliveryApprovalRefs"],
      "transformer_gate_grant_invalid",
    );
    if (typeof grant.tenantId !== "string" || !tenantAllowlist.includes(grant.tenantId)) {
      throw new Error("transformer_gate_grant_tenant_invalid");
    }
    if (typeof grant.environment !== "string" || !environmentAllowlist.includes(grant.environment)) {
      throw new Error("transformer_gate_grant_environment_invalid");
    }
    const boundaries = stringList(grant.boundaries, "transformer_gate_boundaries_invalid");
    if (boundaries.some((boundary) => !boundarySet.has(boundary))) {
      throw new Error("transformer_gate_boundary_unknown");
    }
    const key = `${grant.tenantId}\0${grant.environment}`;
    if (grantKeys.has(key)) throw new Error("transformer_gate_grant_duplicate");
    grantKeys.add(key);
    return Object.freeze({
      tenantId: grant.tenantId,
      environment: grant.environment,
      boundaries: Object.freeze(boundaries as TransformerGateBoundary[]),
      acceptanceEvidenceRefs: Object.freeze(stringList(grant.acceptanceEvidenceRefs, "transformer_gate_acceptance_evidence_invalid")),
      productionDeliveryApprovalRefs: Object.freeze(stringList(grant.productionDeliveryApprovalRefs, "transformer_gate_delivery_approvals_invalid", true)),
    });
  });
  return Object.freeze({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: Object.freeze(tenantAllowlist),
    environmentAllowlist: Object.freeze(environmentAllowlist),
    grants: Object.freeze(grants),
  });
}

function denied(input: TransformerGateInput, reasons: string[]): TransformerGateDecision {
  return Object.freeze({
    allowed: false,
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantId: input.tenantId,
    environment: input.environment,
    boundary: input.boundary,
    reasons: Object.freeze([...new Set(reasons)].sort()),
    acceptanceEvidenceRefs: Object.freeze([]),
    productionDeliveryApprovalRefs: Object.freeze([]),
  });
}

export function assessTransformerGate(
  input: TransformerGateInput,
  rawConfig = resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_GATE"),
): TransformerGateDecision {
  const reasons: string[] = [];
  if (!IDENTIFIER.test(input.tenantId)) reasons.push("tenant_invalid");
  if (!IDENTIFIER.test(input.environment)) reasons.push("environment_invalid");
  if (!boundarySet.has(input.boundary)) reasons.push("boundary_unknown");
  if (reasons.length) return denied(input, reasons);

  let config: TransformerGateConfig;
  try {
    config = parseTransformerGateConfig(rawConfig);
  } catch (error) {
    return denied(input, [error instanceof Error ? error.message : "transformer_gate_config_malformed"]);
  }
  if (!config.tenantAllowlist.includes(input.tenantId)) reasons.push("tenant_not_allowed");
  if (!config.environmentAllowlist.includes(input.environment)) reasons.push("environment_not_allowed");
  const grant = config.grants.find(
    (candidate) => candidate.tenantId === input.tenantId && candidate.environment === input.environment,
  );
  if (!grant) reasons.push("grant_missing");
  else {
    if (!grant.boundaries.includes(input.boundary)) reasons.push("boundary_not_allowed");
    if (grant.acceptanceEvidenceRefs.length === 0) reasons.push("acceptance_evidence_missing");
    if (input.boundary === "delivery" && input.environment === "production") {
      const supplied = input.productionDeliveryApprovalRefs ?? [];
      if (!supplied.some((ref) => grant.productionDeliveryApprovalRefs.includes(ref))) {
        reasons.push("production_delivery_approval_missing");
      }
    }
  }
  if (reasons.length || !grant) return denied(input, reasons);
  return Object.freeze({
    allowed: true,
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantId: input.tenantId,
    environment: input.environment,
    boundary: input.boundary,
    reasons: Object.freeze([]),
    acceptanceEvidenceRefs: Object.freeze([...grant.acceptanceEvidenceRefs]),
    productionDeliveryApprovalRefs: Object.freeze([...grant.productionDeliveryApprovalRefs]),
  });
}

export function authorizeTransformerWorkerAction(
  input: Omit<TransformerGateInput, "boundary">,
  rawConfig?: string,
): TransformerGateDecision {
  return assessTransformerGate({ ...input, boundary: "worker_action" }, rawConfig);
}

export function authorizeTransformerDelivery(
  input: Omit<TransformerGateInput, "boundary">,
  rawConfig?: string,
): TransformerGateDecision {
  return assessTransformerGate({ ...input, boundary: "delivery" }, rawConfig);
}
