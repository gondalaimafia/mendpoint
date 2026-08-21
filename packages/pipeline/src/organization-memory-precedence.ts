/**
 * Organization Memory precedence resolution (spec:
 * docs/memory/MEMORY_PRECEDENCE.md).
 *
 * A SINGLE resolution point decides which layer governs a decision, so the
 * ordering lives in exactly one place rather than being re-derived by scattered
 * checks at each consumer (the house pattern for a single evaluation point is
 * `evaluateExecutor` in @mendpoint/platform).
 *
 * Precedence, highest first:
 *
 *   hard policy > current Mission decision > confirmed Org Memory
 *     > user preference > inferred memory candidate
 *
 * Two safety-critical invariants, each a deletable control with a test that dies
 * when it is removed:
 *
 *  - Inferred (and even confirmed) Organization Memory must NEVER override a hard
 *    policy, a Mission decision, or a tenant boundary. `resolveOrganizationDecision`
 *    asserts the winner is a policy/mission layer whenever either is present, and
 *    refuses to consider any layer whose tenant differs from the decision tenant.
 *  - Memory must not become hidden policy. The result names the memory that
 *    actually influenced the decision (`appliedMemory`) AND every memory that was
 *    present but outranked (`overriddenMemory`), so a memory can never silently
 *    override an explicit instruction — the specific failure this design exists to
 *    prevent.
 */
import type { OrganizationMemoryRecord, OrganizationMemoryStatus } from "@mendpoint/db";

export type PrecedenceLayerName =
  | "hard_policy"
  | "mission_decision"
  | "confirmed_org_memory"
  | "user_preference"
  | "inferred_candidate";

/** Precedence order, strongest first. The single source of ordering truth. */
export const PRECEDENCE_ORDER: readonly PrecedenceLayerName[] = [
  "hard_policy",
  "mission_decision",
  "confirmed_org_memory",
  "user_preference",
  "inferred_candidate",
] as const;

/** Layers that a memory must never be able to override. */
const OVERRIDE_IMMUNE_LAYERS: ReadonlySet<PrecedenceLayerName> = new Set([
  "hard_policy",
  "mission_decision",
]);

export type OrganizationMemoryReference = Readonly<{
  tenantId: string;
  memoryId: string;
  recordId: string;
  status: OrganizationMemoryStatus;
  statement: string;
}>;

type DirectiveLayer = Readonly<{ tenantId: string; id: string; directive: string }>;

export type PrecedenceInput = Readonly<{
  tenantId: string;
  hardPolicy?: DirectiveLayer;
  missionDecision?: DirectiveLayer;
  confirmedOrgMemory?: OrganizationMemoryReference;
  userPreference?: DirectiveLayer;
  inferredCandidate?: OrganizationMemoryReference;
}>;

export type PrecedenceResult = Readonly<{
  winner: PrecedenceLayerName | "none";
  reason: string;
  /** The Organization Memory that governed the decision, or null if none did. */
  appliedMemory: OrganizationMemoryReference | null;
  /** Memories present but outranked — surfaced, never silently dropped. */
  overriddenMemory: readonly Readonly<{
    layer: PrecedenceLayerName;
    memory: OrganizationMemoryReference;
  }>[];
  /** Layers the winner displaced, strongest first. */
  overrides: readonly PrecedenceLayerName[];
}>;

function layerTenant(input: PrecedenceInput, layer: PrecedenceLayerName): string | undefined {
  switch (layer) {
    case "hard_policy":
      return input.hardPolicy?.tenantId;
    case "mission_decision":
      return input.missionDecision?.tenantId;
    case "confirmed_org_memory":
      return input.confirmedOrgMemory?.tenantId;
    case "user_preference":
      return input.userPreference?.tenantId;
    case "inferred_candidate":
      return input.inferredCandidate?.tenantId;
  }
}

function memoryForLayer(
  input: PrecedenceInput,
  layer: PrecedenceLayerName,
): OrganizationMemoryReference | null {
  if (layer === "confirmed_org_memory") return input.confirmedOrgMemory ?? null;
  if (layer === "inferred_candidate") return input.inferredCandidate ?? null;
  return null;
}

/**
 * Resolve which layer governs a decision. Pure and total: the same input always
 * yields the same result, and it reads no external state.
 */
export function resolveOrganizationDecision(input: PrecedenceInput): PrecedenceResult {
  if (typeof input.tenantId !== "string" || input.tenantId.trim() === "") {
    throw new Error("organization_memory_precedence_tenant_required");
  }

  // Tenant boundary: no layer from a different tenant may participate. This is
  // what makes a cross-tenant inferred candidate impossible to inject into a
  // decision, rather than merely unlikely.
  const present: PrecedenceLayerName[] = [];
  for (const layer of PRECEDENCE_ORDER) {
    const tenant = layerTenant(input, layer);
    if (tenant === undefined) continue;
    if (tenant !== input.tenantId) {
      throw new Error("organization_memory_precedence_tenant_mismatch");
    }
    present.push(layer);
  }

  if (present.length === 0) {
    return Object.freeze({
      winner: "none",
      reason: "no_layer_present",
      appliedMemory: null,
      overriddenMemory: Object.freeze([]),
      overrides: Object.freeze([]),
    });
  }

  const winner = present[0]!;

  // Safety invariant: whenever a hard policy or Mission decision is present, one
  // of them MUST win. No Organization Memory or user preference can override
  // them. Ordering already guarantees this; the explicit assertion is the
  // deletable control that fails the override tests if the ordering is weakened.
  if (
    (input.hardPolicy !== undefined || input.missionDecision !== undefined) &&
    !OVERRIDE_IMMUNE_LAYERS.has(winner)
  ) {
    throw new Error("organization_memory_precedence_override_violation");
  }

  const overrides = present.slice(1);
  const overriddenMemory: Array<{ layer: PrecedenceLayerName; memory: OrganizationMemoryReference }> = [];
  for (const layer of overrides) {
    const memory = memoryForLayer(input, layer);
    if (memory) overriddenMemory.push({ layer, memory });
  }

  return Object.freeze({
    winner,
    reason: `${winner}_wins`,
    appliedMemory: memoryForLayer(input, winner),
    overriddenMemory: Object.freeze(overriddenMemory.map((entry) => Object.freeze(entry))),
    overrides: Object.freeze(overrides),
  });
}

/**
 * Map an Organization Memory head record to its precedence layer. Only ACTIVE
 * memory governs as confirmed Org Memory; pending states are inferred candidates;
 * disabled, rejected, deleted, and stale memory does not participate at all — so
 * a disabled memory stops influencing resolution the instant its head flips,
 * with no redeploy and no cache.
 */
export function organizationMemoryPrecedenceLayer(
  record: Pick<OrganizationMemoryRecord, "status">,
): "confirmed_org_memory" | "inferred_candidate" | "excluded" {
  switch (record.status) {
    case "ACTIVE":
      return "confirmed_org_memory";
    case "OBSERVATION":
    case "MEMORY_CANDIDATE":
    case "VALIDATION":
    case "CONFIRMED":
      return "inferred_candidate";
    case "REJECTED":
    case "STALE":
    case "DISABLED":
    case "DELETED":
      return "excluded";
  }
}

/** Narrow an Organization Memory head record to a precedence reference. */
export function toOrganizationMemoryReference(
  record: Pick<
    OrganizationMemoryRecord,
    "tenantId" | "memoryId" | "recordId" | "status" | "statement"
  >,
): OrganizationMemoryReference {
  return Object.freeze({
    tenantId: record.tenantId,
    memoryId: record.memoryId,
    recordId: record.recordId,
    status: record.status,
    statement: record.statement,
  });
}
