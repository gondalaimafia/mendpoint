/** Shared extractors for Warden (no fix/heuristic imports — avoid cycles). */

export function extractRenames(text: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const patterns = [
    /rename\s+[`'"]?([A-Za-z0-9_./-]+)[`'"]?\s+(?:to|→|->)\s+[`'"]?([A-Za-z0-9_./-]+)[`'"]?/gi,
    /[`'"]([A-Za-z0-9_./-]+)[`'"]\s*(?:→|->|=>)\s*[`'"]([A-Za-z0-9_./-]+)[`'"]/g,
    /\b([A-Za-z0-9_]+)\s+should\s+be\s+([A-Za-z0-9_]+)\b/gi,
    /\breplace\s+[`'"]?([A-Za-z0-9_./-]+)[`'"]?\s+with\s+[`'"]?([A-Za-z0-9_./-]+)[`'"]?/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m[1] && m[2] && m[1] !== m[2]) out.push({ from: m[1], to: m[2] });
    }
  }
  return out;
}

export function extractApiPaths(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(/(\/v\d+\/[A-Za-z0-9_./-]+)/g)) {
    paths.push(m[1]!);
  }
  return [...new Set(paths)];
}

export function extractHints(goal: string, errorLog?: string): string[] {
  const text = `${goal}\n${errorLog ?? ""}`;
  const hints: string[] = [];
  for (const m of text.matchAll(/['"`]([A-Za-z0-9_./{}-]+)['"`]/g)) {
    if (m[1]!.length > 2 && m[1]!.length < 80) hints.push(m[1]!);
  }
  for (const m of text.matchAll(
    /\b(amount_cents|starting_after|max_tokens|max_completion_tokens|Bearer|404|401|403|408|415|422|429|500|502|504|ETIMEDOUT|ENOENT|TypeError|fetch failed|Content-Type|application\/json|Retry-After|Idempotency-Key|webhook|graphql|grpc|circuit.?breaker)\b/gi,
  )) {
    hints.push(m[1]!);
  }
  for (const p of extractApiPaths(text)) hints.push(p);
  for (const r of extractRenames(text)) {
    hints.push(r.from, r.to);
  }
  if (/chargess|endpoint.*wrong|404/i.test(text)) hints.push("/v1/charges", "charges");
  if (/amount_cents|rename.*amount/i.test(text)) hints.push("amount_cents", "amount");
  if (/auth|401|unauthorized|api.?key/i.test(text)) hints.push("Authorization", "apiKey", "Bearer");
  if (/content-type|json body|application\/json|415/i.test(text)) {
    hints.push("Content-Type", "application/json");
  }
  if (/\b429\b|rate.?limit/i.test(text)) hints.push("429", "Retry-After", "rateLimit");
  if (/webhook/i.test(text)) hints.push("webhook", "event_id", "signature");
  if (/retry|backoff|cascad/i.test(text)) hints.push("retry", "backoff", "setTimeout");
  if (/timeout|504|ETIMEDOUT/i.test(text)) hints.push("timeout", "AbortController");
  if (/idempoten/i.test(text)) hints.push("Idempotency-Key");
  if (/graphql/i.test(text)) hints.push("graphql", "query");
  if (/grpc|protobuf/i.test(text)) hints.push("grpc", "protobuf");
  return [...new Set(hints)].slice(0, 20);
}
