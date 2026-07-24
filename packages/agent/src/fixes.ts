/**
 * Warden fix proposers — code-level repairs for trained failure modes.
 */
import type { ToolCall } from "./types.js";
import { extractApiPaths, extractRenames } from "./heuristics-core.js";
import { classifyFailures } from "./knowledge.js";

export type FixProposal = { key: string; call: ToolCall; modeId?: string };

function tryReplace(
  path: string,
  from: string,
  to: string,
  key: string,
  thought: string,
  tried: Set<string>,
  modeId?: string,
): FixProposal | null {
  if (tried.has(key) || from === to) return null;
  return {
    key,
    modeId,
    call: {
      tool: "replace_in_file",
      args: { path, from, to, global: true },
      thought,
    },
  };
}

/**
 * Propose one API communication fix for the given file content.
 */
export function proposeWardenFix(
  content: string,
  path: string,
  goal: string,
  errorLog: string | undefined,
  tried: Set<string>,
): FixProposal | null {
  const goalErr = `${goal}\n${errorLog ?? ""}`;
  const blob = `${goalErr}\n${content}`;
  const modes = classifyFailures(goal, errorLog, content);

  // 1) Explicit renames from goal/error
  for (const { from, to } of extractRenames(goalErr)) {
    if (content.includes(from)) {
      const p = tryReplace(
        path,
        from,
        to,
        `${path}:rename:${from}->${to}`,
        `serialization: rename ${from} → ${to}`,
        tried,
        "field_rename",
      );
      if (p) return p;
    }
  }

  // 2) Path typo chargess
  if (/chargess/.test(content)) {
    const p = tryReplace(
      path,
      "chargess",
      "charges",
      `${path}:chargess`,
      "protocol: fix path typo chargess → charges",
      tried,
      "wrong_http_path",
    );
    if (p) return p;
  }

  // 3) API path normalization / swap
  {
    const filePaths = extractApiPaths(content);
    const logPaths = extractApiPaths(goalErr);
    for (const wrong of filePaths) {
      const corrected = wrong.replace(/ss(\/|$)/, "s$1").replace(/\/\/+/g, "/");
      if (corrected !== wrong && content.includes(wrong)) {
        const p = tryReplace(
          path,
          wrong,
          corrected,
          `${path}:pathfix:${wrong}`,
          `protocol: normalize path ${wrong} → ${corrected}`,
          tried,
          "wrong_http_path",
        );
        if (p) return p;
      }
      for (const good of logPaths) {
        if (
          good !== wrong &&
          !content.includes(good) &&
          (goalErr.includes("404") || /should be|expected|correct path|fix/i.test(goalErr))
        ) {
          const wTail = wrong.split("/").pop() ?? "";
          const gTail = good.split("/").pop() ?? "";
          if (wTail && gTail && (wTail.startsWith(gTail) || gTail.startsWith(wTail.slice(0, -1)))) {
            const p = tryReplace(
              path,
              wrong,
              good,
              `${path}:swap:${wrong}->${good}`,
              `protocol: swap path ${wrong} → ${good}`,
              tried,
              "wrong_http_path",
            );
            if (p) return p;
          }
        }
      }
    }
  }

  // 4) amount_cents → amount
  if (/\bamount_cents\b/.test(content) && /amount_cents|rename.*amount|amount\b/i.test(blob)) {
    const p = tryReplace(
      path,
      "amount_cents",
      "amount",
      `${path}:amount_cents`,
      "serialization/semantic: amount_cents → amount",
      tried,
      "field_rename",
    );
    if (p) return p;
  }

  // 5) pagination starting_after
  if (/\bstarting_after\b/.test(content) && /page|cursor|pagination|starting_after/i.test(goalErr)) {
    const to = /cursor/i.test(goalErr) ? "cursor" : "page";
    const p = tryReplace(
      path,
      "starting_after",
      to,
      `${path}:starting_after`,
      `serialization: starting_after → ${to}`,
      tried,
      "field_rename",
    );
    if (p) return p;
  }

  // 6) max_tokens
  if (/\bmax_tokens\b/.test(content) && /max_completion|deprecated|max_tokens/i.test(goalErr)) {
    const p = tryReplace(
      path,
      "max_tokens",
      "max_completion_tokens",
      `${path}:max_tokens`,
      "serialization: max_tokens → max_completion_tokens",
      tried,
      "field_rename",
    );
    if (p) return p;
  }

  // 7) Bearer auth
  if (
    /Authorization/i.test(content) &&
    !/Bearer/i.test(content) &&
    /401|unauthorized|auth|Bearer/i.test(blob)
  ) {
    const candidates: Array<[string, string]> = [
      ["Authorization: apiKey", "Authorization: Bearer ${apiKey}"],
      ['"Authorization": apiKey', '"Authorization": `Bearer ${apiKey}`'],
      ["'Authorization': apiKey", "'Authorization': `Bearer ${apiKey}`"],
      ["Authorization: ${apiKey}", "Authorization: Bearer ${apiKey}"],
      ['"Authorization": `${apiKey}`', '"Authorization": `Bearer ${apiKey}`'],
      ['"Authorization": apiKey', '"Authorization": "Bearer " + apiKey'],
    ];
    for (const [from, to] of candidates) {
      if (content.includes(from)) {
        const p = tryReplace(
          path,
          from,
          to,
          `${path}:bearer`,
          "protocol: add Bearer prefix to Authorization",
          tried,
          "header_preservation",
        );
        if (p) return p;
      }
    }
  }

  // 8) Content-Type application/json
  if (
    (/content-type|application\/json|json body|415|unsupported media/i.test(goalErr) ||
      modes.some((m) => m.id === "content_type_json")) &&
    /method:\s*["'](POST|PUT|PATCH)["']|\.post\(|\.put\(|fetch\(/i.test(content) &&
    !/Content-Type|content-type|application\/json/i.test(content) &&
    /headers\s*:\s*\{/.test(content)
  ) {
    const p = tryReplace(
      path,
      "headers: {",
      'headers: { "Content-Type": "application/json",',
      `${path}:content-type`,
      "protocol: add Content-Type application/json",
      tried,
      "content_type_json",
    );
    if (p) return p;
  }

  // 9) Accept header
  if (
    (/406|not acceptable|accept header|content negotiation/i.test(goalErr) ||
      modes.some((m) => m.id === "accept_header")) &&
    /headers\s*:\s*\{/.test(content) &&
    !/Accept\s*:/i.test(content)
  ) {
    const p = tryReplace(
      path,
      "headers: {",
      'headers: { Accept: "application/json",',
      `${path}:accept`,
      "protocol: add Accept application/json",
      tried,
      "accept_header",
    );
    if (p) return p;
  }

  // 10) API version header (when goal names it)
  {
    const vm = goalErr.match(
      /(?:add|set|send|include)\s+[`'"]?([A-Za-z0-9_-]*(?:[Vv]ersion)[A-Za-z0-9_-]*)[`'"]?\s*(?:header)?\s*[:=]?\s*[`'"]?([A-Za-z0-9._-]+)[`'"]?/,
    );
    if (vm && /headers\s*:\s*\{/.test(content) && !content.includes(vm[1]!)) {
      const header = vm[1]!;
      const value = vm[2]!;
      const p = tryReplace(
        path,
        "headers: {",
        `headers: { "${header}": "${value}",`,
        `${path}:apiver:${header}`,
        `protocol: add ${header}: ${value}`,
        tried,
        "api_version_header",
      );
      if (p) return p;
    }
  }

  // 11) https upgrade
  if (
    /http:\/\/api\./.test(content) &&
    (/https|ssl|tls|mixed|insecure/i.test(goalErr) || modes.some((m) => m.id === "tls_https"))
  ) {
    const p = tryReplace(
      path,
      "http://api.",
      "https://api.",
      `${path}:https`,
      "network: upgrade API base URL to https",
      tried,
      "tls_https",
    );
    if (p) return p;
  }

  // 12) Double slash
  if (/\/v\d+\/\/\w+/.test(content)) {
    const m = content.match(/\/(v\d+)\/\//);
    const ver = m?.[1] ?? "v1";
    const p = tryReplace(
      path,
      `/${ver}//`,
      `/${ver}/`,
      `${path}:doubleslash`,
      "protocol: fix double-slash in API path",
      tried,
      "wrong_http_path",
    );
    if (p) return p;
  }

  // 13) Trailing slash
  if (/trailing.?slash|308|301.*slash/i.test(goalErr) && /\/v\d+\/[A-Za-z0-9_-]+\/["'`]/.test(content)) {
    const m = content.match(/(\/v\d+\/[A-Za-z0-9_-]+)\/(["'`])/);
    if (m) {
      const p = tryReplace(
        path,
        `${m[1]}/${m[2]}`,
        `${m[1]}${m[2]}`,
        `${path}:trailslash`,
        "protocol: remove trailing slash",
        tried,
        "trailing_slash",
      );
      if (p) return p;
    }
  }

  // 14) Idempotency-Key on POST
  if (
    (/idempotenc|double.?charg|duplicate (order|payment)/i.test(goalErr) ||
      modes.some((m) => m.id === "missing_idempotency")) &&
    /method:\s*["']POST["']|\.post\(/i.test(content) &&
    /headers\s*:\s*\{/.test(content) &&
    !/Idempotency-Key|idempotency.key/i.test(content)
  ) {
    const p = tryReplace(
      path,
      "headers: {",
      'headers: { "Idempotency-Key": crypto.randomUUID?.() ?? String(Date.now()),',
      `${path}:idempotency`,
      "resilience: add Idempotency-Key on mutating request",
      tried,
      "missing_idempotency",
    );
    if (p) return p;
  }

  // 15) Naive retry without delay → add backoff sleep comment pattern
  //     Replace `for (let attempt = 0; attempt < 5; attempt++) {` body first line with backoff
  if (
    (/retry storm|no backoff|aggressive retry|without backoff/i.test(goalErr) ||
      modes.some((m) => m.id === "retry_no_backoff")) &&
    /for\s*\(\s*let\s+attempt/i.test(content) &&
    !/setTimeout|sleep|backoff|2\s*\*\*\s*attempt/i.test(content)
  ) {
    const m = content.match(/(for\s*\(\s*let\s+attempt\s*=\s*0;\s*attempt\s*<\s*\d+;\s*attempt\+\+\s*\)\s*\{)/);
    if (m) {
      const injection = `${m[1]}\n  await new Promise(r => setTimeout(r, Math.min(8000, 100 * 2 ** attempt) + Math.random() * 100)); // Warden: exp backoff + jitter`;
      const p = tryReplace(
        path,
        m[1]!,
        injection,
        `${path}:backoff`,
        "resilience: exponential backoff + jitter on retries",
        tried,
        "retry_no_backoff",
      );
      if (p) return p;
    }
  }

  // 16) Retry only on 5xx/429 — flag status < 500 retries
  if (
    (/retry.*4\d\d|do not retry 4xx|only retry 5xx/i.test(goalErr) ||
      modes.some((m) => m.id === "retry_4xx")) &&
    /status\s*(?:Code)?\s*[<>=!]+\s*400/.test(content)
  ) {
    // Broaden: if `if (status >= 400) retry` → only 408/429/5xx
    const bad = content.match(/if\s*\(\s*(?:res(?:ponse)?\.)?status\s*>=\s*400\s*\)/);
    if (bad) {
      const p = tryReplace(
        path,
        bad[0],
        "if ([408, 429].includes(res.status) || res.status >= 500)",
        `${path}:retry4xx`,
        "resilience: only retry 408/429/5xx (not all 4xx)",
        tried,
        "retry_4xx",
      );
      if (p) return p;
    }
  }

  // 17) 429 Retry-After handling — inject after status === 429
  if (
    (/\b429\b|rate.?limit|retry-after/i.test(goalErr) || modes.some((m) => m.id === "rate_limit_429")) &&
    /status\s*===?\s*429|status\s*==\s*429/.test(content) &&
    !/Retry-After|retry-after/i.test(content)
  ) {
    const m = content.match(/(if\s*\([^)]*429[^)]*\)\s*\{)/);
    if (m) {
      const injection = `${m[1]}\n  const ra = Number(res.headers?.get?.("retry-after") ?? res.headers?.["retry-after"] ?? 1);\n  await new Promise(r => setTimeout(r, (Number.isFinite(ra) ? ra : 1) * 1000)); // Warden: honor Retry-After`;
      const p = tryReplace(
        path,
        m[1]!,
        injection,
        `${path}:retry-after`,
        "rate-limit: honor Retry-After on 429",
        tried,
        "rate_limit_429",
      );
      if (p) return p;
    }
  }

  // 18) Check res.ok before json()
  if (
    (/did not check status|check status|res\.ok|assumed 200/i.test(goalErr) ||
      modes.some((m) => m.id === "no_status_check")) &&
    /await\s+res(?:ponse)?\.json\(\)/.test(content) &&
    !/res(?:ponse)?\.ok|status\s*!==?\s*200|status\s*>=\s*400/.test(content)
  ) {
    const m = content.match(/(const\s+\w+\s*=\s*await\s+res(?:ponse)?\.json\(\))/);
    if (m) {
      const injection = `if (!res.ok) throw new Error(\`HTTP \${res.status}\`); // Warden: check status before parse\n  ${m[1]}`;
      const p = tryReplace(
        path,
        m[1]!,
        injection,
        `${path}:res.ok`,
        "resilience: check HTTP status before parsing JSON",
        tried,
        "no_status_check",
      );
      if (p) return p;
    }
  }

  // 19) Webhook event id dedupe stub
  if (
    (/webhook/i.test(blob) && /duplicate|idempoten|already processed|event_id/i.test(goalErr)) ||
    (modes.some((m) => m.id === "webhook_idempotency") && /webhook/i.test(content))
  ) {
    if (
      /function\s+handleWebhook|exports\.handler|async\s+function\s+webhook/i.test(content) &&
      !/processedEvents|seenEvents|idempoten/i.test(content)
    ) {
      const m = content.match(/(async\s+function\s+\w*webhook\w*\s*\([^)]*\)\s*\{|function\s+\w*webhook\w*\s*\([^)]*\)\s*\{)/i);
      if (m) {
        const injection = `${m[1]}\n  const _wardenSeen = globalThis.__wardenWebhookSeen ??= new Set();\n  const _eid = body?.id ?? body?.event_id ?? headers?.["x-delivery-id"];\n  if (_eid && _wardenSeen.has(_eid)) return { ok: true, duplicate: true };\n  if (_eid) _wardenSeen.add(_eid); // Warden: webhook idempotency`;
        const p = tryReplace(
          path,
          m[1]!,
          injection,
          `${path}:webhook-dedupe`,
          "async: dedupe webhook deliveries by event id",
          tried,
          "webhook_idempotency",
        );
        if (p) return p;
      }
    }
  }

  // 20) GraphQL body shape — REST { data } mistaken
  if (
    (/graphql/i.test(blob) || modes.some((m) => m.id === "graphql_vs_rest")) &&
    /\/graphql/.test(content) &&
    /body:\s*\{[^}]*data\s*:/.test(content) &&
    !/query\s*:/.test(content)
  ) {
    // Too risky to rewrite freely; only if clear pattern body: { data:
    if (content.includes("body: { data:")) {
      const p = tryReplace(
        path,
        "body: { data:",
        "body: { query:",
        `${path}:gql-query`,
        "protocol: GraphQL expects query, not REST data field",
        tried,
        "graphql_vs_rest",
      );
      if (p) return p;
    }
  }

  // 21) Timeout constant bump when goal says timeout too low
  if (
    (/timeout/i.test(goalErr) || modes.some((m) => m.id === "timeouts")) &&
    /timeout\s*[:=]\s*\d{1,4}\b/.test(content)
  ) {
    const m = content.match(/timeout\s*[:=]\s*(\d{1,4})\b/);
    if (m && Number(m[1]) < 10_000) {
      const from = m[0];
      const to = from.replace(m[1]!, "30000");
      const p = tryReplace(
        path,
        from,
        to,
        `${path}:timeout`,
        "network: raise client timeout to 30s",
        tried,
        "timeouts",
      );
      if (p) return p;
    }
  }

  // 22) Epoch seconds vs ms
  if (
    /epoch|milliseconds|seconds since/i.test(goalErr) &&
    /Date\.now\(\)/.test(content) &&
    /seconds/i.test(goalErr) &&
    !/Date\.now\(\)\s*\/\s*1000/.test(content)
  ) {
    const p = tryReplace(
      path,
      "Date.now()",
      "Math.floor(Date.now() / 1000)",
      `${path}:epoch-sec`,
      "semantic: convert epoch ms → seconds",
      tried,
      "timezone_semantic",
    );
    if (p) return p;
  }

  // 23) Correlation / request id header
  if (
    (/x-request-id|correlation|traceparent/i.test(goalErr) ||
      modes.some((m) => m.id === "header_preservation")) &&
    /headers\s*:\s*\{/.test(content) &&
    !/x-request-id|X-Request-Id/i.test(content) &&
    /request.?id|correlation/i.test(goalErr)
  ) {
    const p = tryReplace(
      path,
      "headers: {",
      'headers: { "X-Request-Id": crypto.randomUUID?.() ?? String(Date.now()),',
      `${path}:req-id`,
      "network: propagate X-Request-Id for tracing",
      tried,
      "header_preservation",
    );
    if (p) return p;
  }

  return null;
}
