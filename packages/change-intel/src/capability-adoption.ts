/**
 * Warden capability-adoption alerts.
 *
 * Detects NEW additive API capabilities in a provider change, and — given a
 * per-consumer adoption measurement — prioritizes the low-adoption ones so a
 * team can be alerted to adopt-opportunities they are missing.
 *
 * Detection REUSES the existing new-capability classification: it runs the
 * change through {@link toImpactableSurfaces} and keeps the surfaces the diff
 * already tagged `severity: "new_capability"` (the additive path/method/response
 * -field ops). This module never re-implements diff classification.
 *
 * Adoption itself is measured elsewhere (see `@mendpoint/code-impact`) from the
 * STATIC code presence of a capability's endpoint / symbols in a consumer's
 * indexed source. That is an estimate, not runtime telemetry:
 *   - a missing token does NOT prove the capability is unused (dynamic paths,
 *     wrappers, config-driven URLs), and
 *   - a present token does NOT prove it is actively called.
 * Callers should read `adopted` as "statically references the capability" and
 * the priority as an opportunity-reach estimate, not a usage metric.
 */
import type { DiffOp, ImpactableSurface, StructuralDiff } from "@mendpoint/shared";
import { toImpactableSurfaces } from "./index.js";

/** Additive ops that introduce a new capability a consumer could adopt. */
const ADDITIVE_OPS: ReadonlySet<DiffOp> = new Set<DiffOp>([
  "path_added",
  "method_added",
  "response_field_added",
]);

/** A single additive capability introduced by a provider change. */
export type NewCapability = {
  /** Canonical, stable id (mirrors the impactable surface canonicalId). */
  capabilityId: string;
  provider: string;
  op: DiffOp;
  path?: string;
  method?: string;
  field?: string;
  /** Human label, e.g. "POST /v1/payment_links" or "response field balance". */
  endpoint: string;
  /** Tokens to look for in consumer code to estimate adoption. */
  searchTokens: string[];
  explanation: string;
};

/** One consumer's measured adoption of a capability. */
export type ConsumerCapabilityAdoption = {
  consumerId: string;
  consumerName: string;
  /** True when the consumer statically references the capability. */
  adopted: boolean;
  /** Static-presence evidence, e.g. "src/pay.ts:12 /v1/balance". Empty when not adopted. */
  evidence: string[];
  /** Always "static_code_presence" — see module docs for the honesty caveat. */
  basis: "static_code_presence";
};

export type CapabilityConsumerRef = {
  consumerId: string;
  consumerName: string;
  evidence: string[];
};

/** A prioritized capability-adoption opportunity for one capability. */
export type CapabilityAdoptionOpportunity = {
  capability: NewCapability;
  linkedConsumerCount: number;
  adoptingCount: number;
  nonAdoptingCount: number;
  /** adoptingCount / linkedConsumerCount; 0 when nobody is linked. */
  adoptionRate: number;
  adoptingConsumers: CapabilityConsumerRef[];
  nonAdoptingConsumers: CapabilityConsumerRef[];
  /**
   * Opportunity-reach signal: how many linked consumers could adopt this
   * capability but statically do not yet. Higher = larger adoption gap. This is
   * a count of real linked consumers, not a fabricated score.
   */
  priority: number;
  /** Plain-English basis for the value signal, including its honesty caveat. */
  valueBasis: string;
  /** Suggested next action (does not auto-open PRs). */
  suggestedAction: string;
  /** True when this is a low-adoption opportunity worth alerting on. */
  isOpportunity: boolean;
};

export type CapabilityOpportunityOptions = {
  /**
   * Maximum adoption rate (adoptingCount / linkedConsumerCount) still considered
   * "low adoption". Default 0.5: flag capabilities that at most half of the
   * linked consumers already use. A fully-adopted capability (rate 1) is never
   * flagged; a capability with no linked consumers is never flagged.
   */
  maxAdoptionRate?: number;
};

const DEFAULT_MAX_ADOPTION_RATE = 0.5;

/** Relative op weight used only as a deterministic prioritization tie-break. */
const OP_WEIGHT: Readonly<Record<string, number>> = {
  path_added: 3,
  method_added: 2,
  response_field_added: 1,
};

/**
 * Extract the additive NEW capabilities from a structural diff. Reuses the
 * existing surface classification; a diff that is breaking overall can still
 * introduce new capabilities, so this looks at per-surface severity, not the
 * whole-diff risk.
 */
export function detectNewCapabilities(
  diff: StructuralDiff,
  opts: { provider?: string; providerSlug?: string; providerNotes?: string } = {},
): NewCapability[] {
  const provider = opts.provider ?? opts.providerSlug ?? "api";
  const surfaces = toImpactableSurfaces(diff, {
    providerSlug: provider,
    providerNotes: opts.providerNotes,
  });
  return surfaces
    .filter((s) => s.severity === "new_capability" && ADDITIVE_OPS.has(s.op))
    .map((s) => surfaceToCapability(provider, s));
}

function surfaceToCapability(provider: string, s: ImpactableSurface): NewCapability {
  const method = s.method?.toUpperCase();
  const endpoint =
    s.op === "response_field_added"
      ? `response field ${s.field ?? ""}${s.path ? ` on ${method ? `${method} ` : ""}${s.path}` : ""}`
      : `${method ? `${method} ` : ""}${s.path ?? s.field ?? s.canonicalId}`;
  return {
    capabilityId: s.canonicalId,
    provider,
    op: s.op,
    path: s.path,
    method: s.method,
    field: s.field,
    endpoint: endpoint.trim(),
    searchTokens: s.searchTokens,
    explanation: s.explanation,
  };
}

function ref(a: ConsumerCapabilityAdoption): CapabilityConsumerRef {
  return { consumerId: a.consumerId, consumerName: a.consumerName, evidence: a.evidence };
}

/**
 * Build the opportunity record for one capability from per-consumer adoption
 * measurements. Value = the adoption gap (linked consumers not yet using it).
 */
export function buildCapabilityOpportunity(
  capability: NewCapability,
  adoptions: ConsumerCapabilityAdoption[],
  opts: CapabilityOpportunityOptions = {},
): CapabilityAdoptionOpportunity {
  const maxAdoptionRate = opts.maxAdoptionRate ?? DEFAULT_MAX_ADOPTION_RATE;
  const linkedConsumerCount = adoptions.length;
  const adopting = adoptions.filter((a) => a.adopted);
  const nonAdopting = adoptions.filter((a) => !a.adopted);
  const adoptionRate = linkedConsumerCount === 0 ? 0 : adopting.length / linkedConsumerCount;
  const priority = nonAdopting.length;
  const isOpportunity = nonAdopting.length > 0 && adoptionRate <= maxAdoptionRate;
  return {
    capability,
    linkedConsumerCount,
    adoptingCount: adopting.length,
    nonAdoptingCount: nonAdopting.length,
    adoptionRate,
    adoptingConsumers: adopting.map(ref),
    nonAdoptingConsumers: nonAdopting.map(ref),
    priority,
    valueBasis:
      `${nonAdopting.length} of ${linkedConsumerCount} linked consumer(s) do not statically ` +
      `reference ${capability.endpoint}. Value is the adoption gap (linked consumers not yet ` +
      `using it), measured from static code presence, not runtime usage.`,
    suggestedAction: nonAdopting.length
      ? `Generate an adopt-PR (pipeline mode "adopt") for ${capability.endpoint} in: ` +
        `${nonAdopting.map((a) => a.consumerName).join(", ")}.`
      : `All linked consumers already reference ${capability.endpoint}.`,
    isOpportunity,
  };
}

/**
 * Filter to low-adoption opportunities and order them by opportunity reach.
 * Deterministic tie-break: higher priority, then op weight, then lower adoption
 * rate, then capability id.
 */
export function prioritizeCapabilityOpportunities(
  opportunities: CapabilityAdoptionOpportunity[],
): CapabilityAdoptionOpportunity[] {
  return opportunities
    .filter((o) => o.isOpportunity)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const wa = OP_WEIGHT[a.capability.op] ?? 0;
      const wb = OP_WEIGHT[b.capability.op] ?? 0;
      if (wb !== wa) return wb - wa;
      if (a.adoptionRate !== b.adoptionRate) return a.adoptionRate - b.adoptionRate;
      return a.capability.capabilityId.localeCompare(b.capability.capabilityId);
    });
}
