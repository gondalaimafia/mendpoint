/**
 * Build a repair plan from observations (deterministic first, optional LLM later).
 */
import {
  enforceModelEndpointEgress,
  fetchBoundedText,
  redactSourceForModel,
} from "@mendpoint/shared";
import type {
  FailureObservation,
  RepairAction,
  RepairModelProvenance,
  RepairPlan,
} from "./types.js";

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize a repo-relative path for slice-scope comparison: forward slashes and
 * no leading "./". Intentionally does NOT resolve ".." — traversal is rejected
 * separately so a malicious segment can never normalize into an allowed path.
 */
function normalizeSlicePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * An LLM-proposed edit may only target a slice that was actually shown to the
 * model. Fails closed: a non-string or empty path, an absolute path (POSIX root
 * or Windows drive), any ".." traversal segment, and any path under .git/ are
 * rejected before slice membership is even consulted, so a prompt-injected
 * action cannot rewrite package.json, CI workflows, or .git/config.
 */
function isAllowedModelEditPath(
  filePath: unknown,
  allowed: ReadonlySet<string>,
): filePath is string {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  // Absolute paths: POSIX ("/etc/..."), UNC/backslash roots, or a Windows drive.
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) return false;
  const normalized = normalizeSlicePath(filePath);
  if (!normalized) return false;
  if (normalized.split("/").some((segment) => segment === "..")) return false;
  if (normalized === ".git" || normalized.startsWith(".git/")) return false;
  return allowed.has(normalized);
}

function parseModelRepairAction(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
): RepairAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (action.type !== "replace_in_file") return null;
  if (!isAllowedModelEditPath(action.filePath, allowedPaths)) return null;
  if (
    typeof action.from !== "string" ||
    action.from.length < 1 ||
    action.from.length > 2_500 ||
    action.from.includes("\0") ||
    typeof action.to !== "string" ||
    action.to.length < 1 ||
    action.to.length > 2_500 ||
    action.to.includes("\0") ||
    action.from === action.to ||
    typeof action.reason !== "string" ||
    action.reason.trim().length < 1 ||
    action.reason.length > 500 ||
    (action.global !== undefined && typeof action.global !== "boolean")
  ) {
    return null;
  }
  return {
    type: "replace_in_file",
    filePath: normalizeSlicePath(action.filePath),
    from: action.from,
    to: action.to,
    ...(action.global === undefined ? {} : { global: action.global }),
    reason: action.reason,
  };
}

export function planRepairs(
  observations: FailureObservation[],
  opts: {
    attempt: number;
    renameMap?: Record<string, string>;
    strategy?: "deterministic" | "llm" | "hybrid";
  },
): RepairPlan {
  const actions: RepairAction[] = [];
  const renameMap = opts.renameMap ?? {};

  for (const obs of observations) {
    if (obs.kind === "api_rename_leftover" && obs.symbol && renameMap[obs.symbol]) {
      if (obs.filePath) {
        actions.push({
          type: "replace_in_file",
          filePath: obs.filePath,
          from: obs.symbol,
          to: renameMap[obs.symbol]!,
          global: true,
          reason: `Leftover rename ${obs.symbol} → ${renameMap[obs.symbol]}`,
        });
      }
    }

    if (obs.kind === "undefined_symbol" && obs.symbol && renameMap[obs.symbol]) {
      if (obs.filePath) {
        actions.push({
          type: "replace_in_file",
          filePath: obs.filePath,
          from: obs.symbol,
          to: renameMap[obs.symbol]!,
          global: true,
          reason: `Undefined '${obs.symbol}' mapped via rename map`,
        });
      } else {
        // Will be applied repo-wide in apply phase via allowBroadSearch
        actions.push({
          type: "replace_in_file",
          filePath: "*",
          from: obs.symbol,
          to: renameMap[obs.symbol]!,
          global: true,
          reason: `Repo-wide rename for undefined '${obs.symbol}'`,
        });
      }
    }

    // Parse suggestion rename X to Y
    if (obs.suggestion) {
      const m =
        obs.suggestion.match(/rename\s+(\w+)\s+to\s+(\w+)/i) ??
        obs.suggestion.match(/replace\s+(\w+)\s+with\s+(\w+)/i);
      if (m && obs.filePath) {
        actions.push({
          type: "replace_in_file",
          filePath: obs.filePath,
          from: m[1]!,
          to: m[2]!,
          global: true,
          reason: `From suggestion: ${obs.suggestion}`,
        });
      }
    }

    // TS "Did you mean 'X'?" 
    const didYouMean = obs.message.match(/Did you mean ['"](\w+)['"]\??/i);
    if (didYouMean && obs.symbol && obs.filePath) {
      actions.push({
        type: "replace_in_file",
        filePath: obs.filePath,
        from: obs.symbol,
        to: didYouMean[1]!,
        global: false,
        reason: `Compiler suggestion: ${obs.symbol} → ${didYouMean[1]}`,
      });
    }
  }

  // Always try remaining rename map entries if leftovers observed anywhere
  const hasLeftover = observations.some((o) => o.kind === "api_rename_leftover");
  if (hasLeftover || observations.some((o) => o.kind === "unknown")) {
    for (const [from, to] of Object.entries(renameMap)) {
      if (from === to) continue;
      if (actions.some((a) => a.type === "replace_in_file" && a.from === from)) continue;
      actions.push({
        type: "replace_in_file",
        filePath: "*",
        from,
        to,
        global: true,
        reason: `Sweep rename map ${from} → ${to}`,
      });
    }
  }

  // Dedupe
  const key = (a: RepairAction) => JSON.stringify(a);
  const uniq = new Map<string, RepairAction>();
  for (const a of actions) uniq.set(key(a), a);

  const list = [...uniq.values()].slice(0, 30);
  return {
    attempt: opts.attempt,
    observations,
    actions: list,
    strategy: opts.strategy ?? "deterministic",
    summary:
      list.length === 0
        ? "No deterministic repairs found"
        : `Planned ${list.length} action(s) from ${observations.length} observation(s)`,
  };
}

/** Optional OpenAI-compatible repair proposals (slice-only). */
export async function planRepairsWithLlm(
  observations: FailureObservation[],
  slices: Array<{ filePath: string; content: string }>,
  opts: { attempt: number; endpoint?: string; apiKey?: string; model?: string },
): Promise<RepairPlan | null> {
  const endpoint =
    opts.endpoint ?? process.env.LLM_REPAIR_URL ?? process.env.OPENAI_BASE_URL;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.XAI_API_KEY;
  if (!endpoint || !apiKey || !observations.length) return null;

  const base = endpoint.replace(/\/$/, "");
  const url = base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const loopback =
    target.hostname === "localhost" ||
    target.hostname === "127.0.0.1" ||
    target.hostname === "::1" ||
    target.hostname === "[::1]";
  if (
    (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) ||
    target.username ||
    target.password
  ) {
    return null;
  }
  // Enforced no-egress mode: repository source slices may only reach a private,
  // loopback, link-local, unique-local, or operator allowlisted model host. This
  // is the same policy the agent and provider gateway apply; the repair lane
  // builds its endpoint outside resolveAgentModelEndpoint, so it must call the
  // shared enforcement primitive itself. Throws (rather than returning null) so a
  // local_only violation fails loud instead of silently degrading.
  enforceModelEndpointEgress(target.toString(), process.env);
  const configuredTimeout = Number(process.env.LLM_REPAIR_TIMEOUT_MS ?? 30_000);
  const timeoutMs =
    Number.isSafeInteger(configuredTimeout) &&
    configuredTimeout >= 1 &&
    configuredTimeout <= 120_000
      ? configuredTimeout
      : 30_000;

  const system = `You are Mendpoint repair agent. Propose JSON only:
{"actions":[{"type":"replace_in_file","filePath":"...","from":"...","to":"...","global":true,"reason":"..."}]}
Only edit provided slices. Never invent secrets. Max 8 actions.`;

  // The exact slices shown to the model; edit proposals are later constrained to
  // these paths so a proposal can never target a file the model was not shown.
  const shownSlices = slices.slice(0, 6);
  const rawUser = JSON.stringify({
    observations: observations.slice(0, 12),
    slices: shownSlices.map((s) => ({
      filePath: s.filePath,
      content: s.content.slice(0, 2500),
    })),
  });
  // Redact secret material from the raw file slices before egress. Fail closed:
  // if the redaction engine excludes on high-entropy residue, send nothing.
  const redaction = redactSourceForModel(
    rawUser,
    Math.min(Math.max(rawUser.length, 1), 1_000_000),
  );
  if (redaction.excluded) return null;
  const user = redaction.text;

  try {
    const { response: res, text: responseText } = await fetchBoundedText(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model ?? process.env.LLM_REPAIR_MODEL ?? "gpt-4o-mini",
          temperature: 0.1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      },
      {
        timeoutMs,
        maxResponseBytes: 128 * 1_024,
      },
    );
    if (!res.ok) return null;
    const data = JSON.parse(responseText) as {
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { actions?: RepairAction[] };
    // The model is told "Only edit provided slices"; enforce it. An action may
    // only target one of the exact slice paths shown to the model, and never an
    // absolute path, a ".." traversal, or anything under .git/. This is the
    // request-triggerable, prompt-injectable path, so it fails closed: a
    // non-string / missing filePath or any out-of-slice target is dropped.
    const allowedPaths = new Set(
      shownSlices.map((slice) => normalizeSlicePath(slice.filePath)),
    );
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions
          .map((action) => parseModelRepairAction(action, allowedPaths))
          .filter((action): action is RepairAction => action !== null)
      : [];
    if (!actions.length) return null;
    // Account for the call: record the model that ACTUALLY answered (provider
    // echo) and its token usage, rather than discarding them. This is the
    // repair-lane equivalent of the agent's live-model provenance.
    const promptTokens = finiteOrNull(data.usage?.prompt_tokens);
    const completionTokens = finiteOrNull(data.usage?.completion_tokens);
    const totalTokens = finiteOrNull(data.usage?.total_tokens);
    const modelProvenance: RepairModelProvenance = {
      model: typeof data.model === "string" && data.model ? data.model : null,
      host: target.host,
      promptTokens,
      completionTokens,
      totalTokens,
      measured: promptTokens !== null || completionTokens !== null || totalTokens !== null,
    };
    return {
      attempt: opts.attempt,
      observations,
      actions: actions.slice(0, 8),
      strategy: "llm",
      summary: `LLM proposed ${actions.length} action(s)`,
      modelProvenance,
    };
  } catch {
    return null;
  }
}
