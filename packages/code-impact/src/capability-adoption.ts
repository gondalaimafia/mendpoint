/**
 * Capability-adoption measurement bridge.
 *
 * Estimates whether a consumer already uses a NEW provider capability by looking
 * for the capability's endpoint / symbols in the consumer's codebase index
 * (`apiUsages`). This is STATIC code presence, not runtime telemetry — see the
 * honesty caveat in `@mendpoint/change-intel`'s capability-adoption module.
 *
 * Heuristic (deliberately conservative to avoid false "adopted" positives):
 *   - HTTP-path capabilities match `http_path` usages whose normalized value
 *     contains (or is contained by) the normalized capability path.
 *   - The capability's last path segment / response field name matches
 *     `sdk_call` / `graphql` / `import` / `field_token` usages on a word boundary.
 *   - `config` usages (whole-line snippets) are intentionally NOT matched: they
 *     are too noisy to be honest evidence of adoption.
 */
import { buildIndex, type CodebaseIndex } from "@mendpoint/codebase-index";
import {
  buildCapabilityOpportunity,
  detectNewCapabilities,
  prioritizeCapabilityOpportunities,
  type CapabilityAdoptionOpportunity,
  type CapabilityOpportunityOptions,
  type ConsumerCapabilityAdoption,
  type NewCapability,
} from "@mendpoint/change-intel";
import type { StructuralDiff } from "@mendpoint/shared";

function normalizePath(value: string): string {
  return value.replace(/\{[^}]+\}/g, "").replace(/\/+$/, "").toLowerCase();
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolTokens(capability: NewCapability): string[] {
  const tokens = new Set<string>();
  if (capability.field) tokens.add(capability.field.toLowerCase());
  if (capability.path) {
    const segs = capability.path.split("/").filter((s) => s && !s.startsWith("{"));
    const last = segs[segs.length - 1];
    if (last) tokens.add(last.toLowerCase());
  }
  return [...tokens].filter((t) => t.length >= 3);
}

const SYMBOL_USAGE_KINDS = new Set(["sdk_call", "graphql", "import", "field_token"]);

/**
 * Does this consumer's index statically reference the capability? Returns the
 * matching evidence lines (capped) alongside the boolean.
 */
export function consumerUsesCapability(
  index: CodebaseIndex,
  capability: NewCapability,
): { adopted: boolean; evidence: string[] } {
  const wantPath = capability.path ? normalizePath(capability.path) : "";
  const tokens = symbolTokens(capability);
  const tokenMatchers = tokens.map(
    (t) => new RegExp(`(^|[^a-z0-9])${escapeReg(t)}([^a-z0-9]|$)`, "i"),
  );
  const evidence: string[] = [];
  for (const usage of index.apiUsages) {
    const value = String(usage.value ?? "");
    let matched = false;
    if (wantPath.length >= 4 && usage.kind === "http_path") {
      const norm = normalizePath(value);
      if (norm.includes(wantPath) || (norm.length >= 4 && wantPath.includes(norm))) {
        matched = true;
      }
    }
    if (!matched && SYMBOL_USAGE_KINDS.has(usage.kind)) {
      matched = tokenMatchers.some((re) => re.test(value));
    }
    if (matched) {
      evidence.push(`${usage.filePath}:${usage.line} ${value}`.slice(0, 200));
    }
  }
  const unique = [...new Set(evidence)].slice(0, 10);
  return { adopted: unique.length > 0, evidence: unique };
}

export function assessConsumerAdoption(
  index: CodebaseIndex,
  consumer: { consumerId: string; consumerName: string },
  capability: NewCapability,
): ConsumerCapabilityAdoption {
  const { adopted, evidence } = consumerUsesCapability(index, capability);
  return {
    consumerId: consumer.consumerId,
    consumerName: consumer.consumerName,
    adopted,
    evidence,
    basis: "static_code_presence",
  };
}

export type CapabilityConsumerInput = {
  consumerId: string;
  consumerName: string;
  /** Pre-built index; takes precedence over repoRoot. */
  index?: CodebaseIndex;
  /** Repo root to index on demand when no index is supplied. */
  repoRoot?: string;
};

/**
 * Full detect -> measure -> prioritize pass. Returns only the low-adoption
 * opportunities worth alerting on, ordered by opportunity reach. A consumer with
 * neither `index` nor `repoRoot` is treated as non-adopting with no evidence.
 */
export function analyzeCapabilityAdoption(
  diff: StructuralDiff,
  consumers: CapabilityConsumerInput[],
  opts: {
    provider?: string;
    providerSlug?: string;
    providerNotes?: string;
  } & CapabilityOpportunityOptions = {},
): CapabilityAdoptionOpportunity[] {
  const capabilities = detectNewCapabilities(diff, opts);
  if (!capabilities.length) return [];
  const resolved = consumers.map((consumer) => ({
    consumer,
    index: consumer.index ?? (consumer.repoRoot ? buildIndex(consumer.repoRoot) : undefined),
  }));
  const opportunities = capabilities.map((capability) => {
    const adoptions: ConsumerCapabilityAdoption[] = resolved.map(({ consumer, index }) =>
      index
        ? assessConsumerAdoption(index, consumer, capability)
        : {
            consumerId: consumer.consumerId,
            consumerName: consumer.consumerName,
            adopted: false,
            evidence: [],
            basis: "static_code_presence" as const,
          },
    );
    return buildCapabilityOpportunity(capability, adoptions, opts);
  });
  return prioritizeCapabilityOpportunities(opportunities);
}
