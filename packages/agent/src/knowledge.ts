/**
 * Warden training knowledge — API communication failure modes.
 * Source map: protocol/contract, serialization, semantic, network,
 * cascading errors, async/webhooks, rate limiting.
 *
 * Categories marked `client_fixable` can be repaired by Warden edits.
 * Others surface as diagnosis + FDE guidance (infra / multi-service).
 */

export type FailureCategoryId =
  | "protocol_contract"
  | "serialization_drift"
  | "semantic_mismatch"
  | "network_latency"
  | "cascading_errors"
  | "async_webhooks"
  | "rate_limiting";

export type FailureMode = {
  id: string;
  category: FailureCategoryId;
  title: string;
  /** Signals in goals, error logs, or code */
  signals: RegExp[];
  /** Typical HTTP/status symptoms */
  symptoms: string[];
  /** What Warden tries in-repo */
  clientFix: string;
  /** When Warden should hand off */
  fdeWhen?: string;
  clientFixable: boolean;
};

export const FAILURE_CATEGORIES: Record<
  FailureCategoryId,
  { title: string; summary: string }
> = {
  protocol_contract: {
    title: "Protocol & contract mismatches",
    summary:
      "REST / GraphQL / gRPC bridges, wrong content types, version headers, path/contract drift",
  },
  serialization_drift: {
    title: "Serialization version mismatches",
    summary:
      "Field rename/restructure, polyglot null/enum/date edge cases, consumer lagging producer",
  },
  semantic_mismatch: {
    title: "Semantic interoperability gaps",
    summary:
      "Same field names, different meaning/units/algorithms; docs vs implementation drift",
  },
  network_latency: {
    title: "Network-level failures & latency",
    summary: "Timeouts, 502/504, TLS, header stripping, connection pools, clock-skew auth",
  },
  cascading_errors: {
    title: "Error handling & cascading failures",
    summary: "Retries without backoff, missing circuit breakers, 4xx vs 5xx confusion, non-idempotent retries",
  },
  async_webhooks: {
    title: "Sync vs async / webhook gaps",
    summary: "Lost events, ordering, duplicates, state reconciliation, idempotency keys",
  },
  rate_limiting: {
    title: "Rate limiting & traffic coordination",
    summary: "429 storms, missing Retry-After, uncoordinated client bursts",
  },
};

export const FAILURE_MODES: FailureMode[] = [
  // ── Protocol / contract ───────────────────────────────────────────
  {
    id: "wrong_http_path",
    category: "protocol_contract",
    title: "Wrong HTTP path / resource name",
    signals: [/404/, /not found/i, /chargess/, /\/v\d+\/[a-z]+ss\b/i, /wrong path|endpoint/i],
    symptoms: ["404", "405"],
    clientFix: "Correct path typo or swap to expected /vN/resource",
    clientFixable: true,
  },
  {
    id: "content_type_json",
    category: "protocol_contract",
    title: "Missing or wrong Content-Type",
    signals: [/content-type/i, /application\/json/, /unsupported media/i, /415/],
    symptoms: ["415", "400"],
    clientFix: "Set Content-Type: application/json (or correct MIME)",
    clientFixable: true,
  },
  {
    id: "accept_header",
    category: "protocol_contract",
    title: "Missing Accept / content negotiation",
    signals: [/accept header/i, /not acceptable/i, /406/, /content negotiation/i],
    symptoms: ["406"],
    clientFix: "Add Accept: application/json (or protobuf MIME)",
    clientFixable: true,
  },
  {
    id: "api_version_header",
    category: "protocol_contract",
    title: "Missing API version header",
    signals: [/api-version/i, /x-api-version/i, /version header/i, /unsupported version/i],
    symptoms: ["400", "404"],
    clientFix: "Add version header (e.g. Stripe-Version, Api-Version)",
    clientFixable: true,
  },
  {
    id: "graphql_vs_rest",
    category: "protocol_contract",
    title: "REST payload sent to GraphQL (or vice versa)",
    signals: [/graphql/i, /must provide query/i, /__typename/, /query\s*\{/],
    symptoms: ["400"],
    clientFix: "POST GraphQL body { query, variables } to /graphql; avoid REST body shape",
    clientFixable: true,
  },
  {
    id: "grpc_json_bridge",
    category: "protocol_contract",
    title: "gRPC / JSON-transcoding mismatch",
    signals: [/grpc/i, /application\/grpc/i, /protobuf/i, /proto\./i],
    symptoms: ["415", "400", "UNIMPLEMENTED"],
    clientFix: "Use correct content-type or REST transcoding path; avoid raw proto in JSON clients",
    fdeWhen: "Service mesh / protoc codegen upgrades",
    clientFixable: true,
  },
  {
    id: "trailing_slash",
    category: "protocol_contract",
    title: "Trailing slash / redirect contract",
    signals: [/trailing.?slash/i, /\b308\b/, /\b301\b.*slash/i],
    symptoms: ["301", "308"],
    clientFix: "Normalize trailing slash on paths",
    clientFixable: true,
  },

  // ── Serialization ─────────────────────────────────────────────────
  {
    id: "field_rename",
    category: "serialization_drift",
    title: "Field renamed / restructured",
    signals: [/rename\s+\w+\s+to/i, /amount_cents/, /max_tokens/, /starting_after/, /unknown field/i, /extra fields/i],
    symptoms: ["400", "422"],
    clientFix: "Rename fields to current schema (amount_cents→amount, etc.)",
    clientFixable: true,
  },
  {
    id: "null_vs_omit",
    category: "serialization_drift",
    title: "Null vs omit / optional field semantics",
    signals: [/null not allowed/i, /cannot be null/i, /required field/i, /omitnull|omit.?null/i],
    symptoms: ["400", "422"],
    clientFix: "Omit nulls or send empty string per API contract",
    clientFixable: true,
  },
  {
    id: "date_format",
    category: "serialization_drift",
    title: "Date / time format mismatch",
    signals: [/iso.?8601/i, /invalid date/i, /timestamp/, /DateTimeParse/i, /rfc3339/i],
    symptoms: ["400"],
    clientFix: "Use ISO-8601 / RFC3339 UTC strings",
    clientFixable: true,
  },
  {
    id: "enum_case",
    category: "serialization_drift",
    title: "Enum / status case mismatch",
    signals: [/invalid enum/i, /unknown value.*status/i, /must be one of/i],
    symptoms: ["400", "422"],
    clientFix: "Align enum casing (often UPPER_SNAKE or lower)",
    clientFixable: true,
  },
  {
    id: "snake_camel",
    category: "serialization_drift",
    title: "snake_case vs camelCase",
    signals: [/snake_case|camelCase|camel_case/i, /expected.*camel/i, /use snake/i],
    symptoms: ["400"],
    clientFix: "Convert key style to producer convention",
    clientFixable: true,
  },

  // ── Semantic ──────────────────────────────────────────────────────
  {
    id: "units_cents",
    category: "semantic_mismatch",
    title: "Units: cents vs major currency units",
    signals: [/amount_cents/, /smallest currency/i, /units? (?:are|must)/i, /multiply by 100/i],
    symptoms: ["wrong totals", "400"],
    clientFix: "Use producer unit (e.g. amount in cents vs dollars)",
    clientFixable: true,
  },
  {
    id: "timezone_semantic",
    category: "semantic_mismatch",
    title: "Timezone / epoch semantic mismatch",
    signals: [/timezone/i, /utc required/i, /epoch (ms|seconds)/i, /milliseconds/i],
    symptoms: ["skewed times", "400"],
    clientFix: "Normalize to UTC ISO or correct epoch scale",
    clientFixable: true,
  },
  {
    id: "docs_vs_impl",
    category: "semantic_mismatch",
    title: "Docs vs live implementation drift",
    signals: [/docs? (?:outdated|wrong)/i, /openapi.*mismatch/i, /undocumented/i],
    symptoms: ["works in isolation, fails integration"],
    clientFix: "Prefer error bodies / OpenAPI over stale docs; apply observed field names",
    fdeWhen: "Producer must refresh contract catalog",
    clientFixable: true,
  },

  // ── Network ───────────────────────────────────────────────────────
  {
    id: "timeouts",
    category: "network_latency",
    title: "Client timeouts too aggressive",
    signals: [/timeout/i, /ETIMEDOUT/, /AbortError/, /504/, /gateway timeout/i],
    symptoms: ["504", "ETIMEDOUT"],
    clientFix: "Raise timeout; add AbortController with configurable ms",
    fdeWhen: "Gateway/route misconfig (often not client)",
    clientFixable: true,
  },
  {
    id: "tls_https",
    category: "network_latency",
    title: "HTTP vs HTTPS / TLS",
    signals: [/https|ssl|tls|mixed content|certificate/i, /http:\/\/api\./],
    symptoms: ["SSL errors", "mixed content"],
    clientFix: "Use https:// base URLs",
    clientFixable: true,
  },
  {
    id: "auth_clock_skew",
    category: "network_latency",
    title: "Token / JWT clock skew",
    signals: [/clock skew/i, /token used before/i, /nbf/i, /exp.*invalid/i],
    symptoms: ["401"],
    clientFix: "Allow small clock tolerance if SDK supports; otherwise FDE NTP",
    fdeWhen: "NTP sync on hosts / IdP",
    clientFixable: false,
  },
  {
    id: "header_preservation",
    category: "network_latency",
    title: "Headers stripped / missing required headers",
    signals: [/header.*required/i, /missing.*header/i, /x-request-id/i, /correlation/i],
    symptoms: ["400", "401"],
    clientFix: "Set required headers; propagate x-request-id / correlation id",
    clientFixable: true,
  },

  // ── Cascading errors ──────────────────────────────────────────────
  {
    id: "retry_no_backoff",
    category: "cascading_errors",
    title: "Aggressive retries without backoff",
    signals: [/retry/i, /for\s*\(.*attempt/i, /while\s*\(.*retry/i, /no backoff/i, /retry storm/i],
    symptoms: ["amplified 5xx", "latency spikes"],
    clientFix: "Exponential backoff + jitter; do not retry most 4xx",
    clientFixable: true,
  },
  {
    id: "retry_4xx",
    category: "cascading_errors",
    title: "Retrying non-retryable 4xx",
    signals: [/retry.*401|retry.*400|retry.*404/i, /status\s*[<>]=?\s*400/],
    symptoms: ["repeated client errors"],
    clientFix: "Only retry 408/429/5xx (and 409 when idempotent)",
    clientFixable: true,
  },
  {
    id: "missing_idempotency",
    category: "cascading_errors",
    title: "Non-idempotent POST without Idempotency-Key",
    signals: [/idempotenc/i, /double.?charg/i, /duplicate (order|payment|record)/i],
    symptoms: ["duplicate side effects"],
    clientFix: "Send Idempotency-Key header on mutating calls",
    clientFixable: true,
  },
  {
    id: "no_status_check",
    category: "cascading_errors",
    title: "Ignoring HTTP status before parsing body",
    signals: [/res\.json\(\)|response\.json\(\)/i, /did not check status/i, /assumed 200/i],
    symptoms: ["silent bad data"],
    clientFix: "Check res.ok / status before json(); branch 4xx vs 5xx",
    clientFixable: true,
  },
  {
    id: "circuit_breaker",
    category: "cascading_errors",
    title: "Missing circuit breaker / bulkhead",
    signals: [/circuit.?breaker/i, /bulkhead/i, /cascading/i, /open circuit/i],
    symptoms: ["full outage cascade"],
    clientFix: "Add simple open/half-open circuit after consecutive failures",
    fdeWhen: "Service mesh / platform resilience policy",
    clientFixable: true,
  },

  // ── Async / webhooks ──────────────────────────────────────────────
  {
    id: "webhook_idempotency",
    category: "async_webhooks",
    title: "Webhook handler not idempotent",
    signals: [/webhook/i, /duplicate event/i, /event_id|eventId|delivery_id/i, /already processed/i],
    symptoms: ["duplicate processing"],
    clientFix: "Dedupe on event id / delivery id before side effects",
    clientFixable: true,
  },
  {
    id: "webhook_signature",
    category: "async_webhooks",
    title: "Webhook signature verification missing/wrong",
    signals: [/webhook.*sign/i, /stripe-signature/i, /x-hub-signature/i, /svix/i],
    symptoms: ["401", "rejected webhooks"],
    clientFix: "Verify signature with raw body; use provider secret",
    clientFixable: true,
  },
  {
    id: "async_polling",
    category: "async_webhooks",
    title: "Busy-polling long-running job",
    signals: [/poll.*status/i, /while\s*\(.*pending/i, /setInterval.*status/i, /long.?running/i],
    symptoms: ["rate limits", "latency"],
    clientFix: "Backoff polling or prefer webhooks when available",
    clientFixable: true,
  },

  // ── Rate limiting ─────────────────────────────────────────────────
  {
    id: "rate_limit_429",
    category: "rate_limiting",
    title: "No 429 / Retry-After handling",
    signals: [/\b429\b/, /too many requests/i, /rate.?limit/i, /retry-after/i],
    symptoms: ["429"],
    clientFix: "Honor Retry-After; exponential backoff on 429",
    clientFixable: true,
  },
  {
    id: "no_client_throttle",
    category: "rate_limiting",
    title: "Unthrottled concurrent clients",
    signals: [/Promise\.all\(.*map/i, /no throttle/i, /concurrency/i, /burst/i],
    symptoms: ["429 across clients"],
    clientFix: "Limit concurrency; add client-side rate limiter",
    fdeWhen: "Shared gateway quotas across services",
    clientFixable: true,
  },
];

/** Classify which failure modes match goal + error log (+ optional code). */
export function classifyFailures(
  goal: string,
  errorLog?: string,
  codeSample?: string,
): FailureMode[] {
  const text = `${goal}\n${errorLog ?? ""}\n${codeSample ?? ""}`;
  const hits = FAILURE_MODES.filter((m) => m.signals.some((re) => re.test(text)));
  // Always include path/contract baseline on 404-ish language
  if (!hits.length && /api|http|fetch|endpoint|webhook|graphql|grpc/i.test(text)) {
    return FAILURE_MODES.filter((m) =>
      ["wrong_http_path", "field_rename", "content_type_json"].includes(m.id),
    );
  }
  return hits;
}

export function categoryCoverageSummary(): string {
  return (Object.keys(FAILURE_CATEGORIES) as FailureCategoryId[])
    .map((id) => {
      const c = FAILURE_CATEGORIES[id];
      const modes = FAILURE_MODES.filter((m) => m.category === id);
      const fixable = modes.filter((m) => m.clientFixable).length;
      return `- **${c.title}**: ${modes.length} modes (${fixable} client-fixable) — ${c.summary}`;
    })
    .join("\n");
}

/** Compact playbook injected into LLM planner. */
export function wardenPlaybook(): string {
  return `You are Warden, Mendpoint's API debug agent. Fix client-side API communication bugs only.
Never auto-merge. Prefer minimal surgical edits. Never touch secrets/.env.

Failure categories you handle:
${categoryCoverageSummary()}

Playbook:
1) Classify from goal + error log (4xx client vs 5xx server vs 429 rate limit).
2) Search/read API client, SDK, webhook handler, retry helpers.
3) Apply: path/contract, serialization renames, headers (Content-Type, Accept, Auth, Idempotency-Key, version),
   https, timeouts, exponential backoff+jitter, 429 Retry-After, status checks, webhook idempotency/signature.
4) Re-run verify command. Stop if infra-only (NTP, gateway routes, mesh) — report FDE handoff.
5) Tools only JSON: {"tool":"...","args":{...},"thought":"..."}.`;
}
