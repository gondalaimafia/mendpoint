/**
 * Build a repair plan from observations (deterministic first, optional LLM later).
 */
import { fetchBoundedText } from "@mendpoint/shared";
import type { FailureObservation, RepairAction, RepairPlan } from "./types.js";

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

  const user = JSON.stringify({
    observations: observations.slice(0, 12),
    slices: slices.slice(0, 6).map((s) => ({
      filePath: s.filePath,
      content: s.content.slice(0, 2500),
    })),
  });

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
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { actions?: RepairAction[] };
    const actions = (parsed.actions ?? []).filter(
      (a) => a && a.type === "replace_in_file" && "from" in a && "to" in a,
    );
    if (!actions.length) return null;
    return {
      attempt: opts.attempt,
      observations,
      actions: actions.slice(0, 8),
      strategy: "llm",
      summary: `LLM proposed ${actions.length} action(s)`,
    };
  } catch {
    return null;
  }
}
