/**
 * Warden — specialized LOOP NODE in Mendpoint's agent GRAPH.
 * Graph engineering: other nodes do change intel / expand / generate;
 * this node is discover → plan → act → VERIFY for API client bugs.
 * Tool loop with API-domain heuristics (+ optional LLM).
 */
import { newId } from "@mendpoint/shared";
import { executeTool, executeToolAsync, type ToolContext } from "./tools.js";
import { nextHeuristicCall, type HeuristicState } from "./heuristics.js";
import { DEFAULT_NEVER_TOUCH } from "./policies.js";
import {
  classifyFailures,
  wardenPlaybook,
  type FailureMode,
} from "./knowledge.js";
import type { AgentRunResult, AgentStep, AgentTask, ToolCall } from "./types.js";

async function llmSuggestTool(
  task: AgentTask,
  steps: AgentStep[],
): Promise<ToolCall | null> {
  if (!task.useLlm) return null;
  const endpoint = process.env.LLM_AGENT_URL ?? process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.XAI_API_KEY;
  if (!endpoint || !apiKey) return null;

  const base = endpoint.replace(/\/$/, "");
  const url = base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;

  const diagnosed = classifyFailures(task.goal, task.errorLog);
  const system = `${wardenPlaybook()}

Reply with JSON only:
{"tool":"search|read_file|replace_in_file|run_command|list_dir|finish","args":{...},"thought":"..."}
Tools only. Prefer minimal edits. Never touch secrets/.env. Never claim merge.`;

  const user = JSON.stringify({
    goal: task.goal,
    errorLog: task.errorLog?.slice(0, 2000),
    verifyCommand: task.verifyCommand,
    diagnosedModes: diagnosed.map((m) => ({
      id: m.id,
      category: m.category,
      title: m.title,
      clientFix: m.clientFix,
    })),
    recentSteps: steps.slice(-6).map((s) => ({
      thought: s.thought,
      tool: s.call.tool,
      ok: s.result.ok,
      summary: s.result.summary,
      error: s.result.error?.slice(0, 400),
    })),
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.LLM_AGENT_MODEL ?? "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as ToolCall;
    if (!parsed.tool) return null;
    return parsed;
  } catch {
    return null;
  }
}

function formatReport(
  r: Omit<AgentRunResult, "reportMarkdown">,
  diagnosed: FailureMode[],
): string {
  return [
    "### Warden (Mendpoint API debug agent)",
    "",
    `- **Goal:** ${r.goal}`,
    `- **Status:** ${r.ok ? "✅ fixed (verify passed or edits applied)" : "❌ needs FDE / human"}`,
    `- **Steps:** ${r.steps.length}`,
    `- **Files changed:** ${r.filesChanged.length ? r.filesChanged.map((f) => `\`${f}\``).join(", ") : "_(none)_"}`,
    `- **Stop:** ${r.stoppedReason}`,
    "",
    "#### Diagnosed failure modes",
    ...(diagnosed.length
      ? diagnosed.slice(0, 8).map(
          (m) =>
            `- **${m.title}** (\`${m.id}\` / ${m.category})${m.clientFixable ? "" : " · *infra/FDE*"} — ${m.clientFix}`,
        )
      : ["- _(no strong signal — general API client pass)_"]),
    "",
    "#### Trace",
    ...r.steps.slice(-12).map(
      (s) =>
        `${s.step}. *${s.thought}* → \`${s.call.tool}\` ${s.result.ok ? "ok" : "fail"} — ${s.result.summary}`,
    ),
    "",
    "#### Trained coverage",
    "- Protocol/contract · Serialization drift · Semantic mismatch",
    "- Network/latency · Cascading errors · Async/webhooks · Rate limiting",
    "",
    "#### Policy",
    "- Never auto-merges",
    "- Path denylist for secrets/lockfiles",
    "- API communication fixes only (code + optional http_probe)",
    "",
    "_Human / FDE review required before merge._",
  ].join("\n");
}

/**
 * Run Warden (API debug agent) to completion (bounded steps).
 * `runApiBugAgent` is kept as a stable alias.
 */
export async function runWarden(task: AgentTask): Promise<AgentRunResult> {
  const sessionId = task.sessionId ?? newId();
  const maxSteps = task.maxSteps ?? 24;
  const steps: AgentStep[] = [];
  const changed = new Set<string>();
  const ctx: ToolContext = {
    repoRoot: task.repoRoot,
    dryRun: task.dryRun,
    neverTouchPaths: task.neverTouchPaths ?? DEFAULT_NEVER_TOUCH,
    allowNetwork: task.allowNetwork ?? false,
    allowedCommands: task.verifyCommand ? [task.verifyCommand] : [],
    changedFiles: changed,
  };

  let diagnosed = classifyFailures(task.goal, task.errorLog);

  const hState: HeuristicState = {
    goal: task.goal,
    errorLog: task.errorLog,
    step: 0,
    lastResults: [],
    filesChanged: [],
    verifyCommand: task.verifyCommand,
    phase: "explore",
    candidates: [],
    triedFixes: new Set(),
    diagnosedModes: diagnosed.map((m) => m.id),
  };

  let stoppedReason = "max_steps";
  let ok = false;
  let verifyOutput: string | undefined;

  // Seed: run verify once to capture failure
  if (task.verifyCommand && !task.errorLog) {
    const seed = executeTool(ctx, {
      tool: "run_command",
      args: { command: task.verifyCommand },
      thought: "Capture initial failure",
    });
    steps.push({
      step: 0,
      thought: "Initial verify",
      call: { tool: "run_command", args: { command: task.verifyCommand } },
      result: seed,
    });
    hState.lastResults.push(seed);
    if (seed.ok) {
      ok = true;
      stoppedReason = "already_passing";
      const base = {
        sessionId,
        ok: true,
        goal: task.goal,
        steps,
        filesChanged: [] as string[],
        verifyOutput: String((seed.data as { stdout?: string })?.stdout ?? ""),
        stoppedReason,
      };
      return { ...base, reportMarkdown: formatReport(base, diagnosed) };
    }
    hState.errorLog = seed.error ?? JSON.stringify(seed.data);
    diagnosed = classifyFailures(task.goal, hState.errorLog);
    hState.diagnosedModes = diagnosed.map((m) => m.id);
  }

  for (let i = 1; i <= maxSteps; i++) {
    hState.step = i;
    hState.filesChanged = [...changed];

    let call: ToolCall | null = null;
    if (task.useLlm && i > 2) {
      call = await llmSuggestTool(task, steps);
    }
    if (!call) call = nextHeuristicCall(hState);

    const result =
      call.tool === "http_probe"
        ? await executeToolAsync(ctx, call)
        : executeTool(ctx, call);

    const step: AgentStep = {
      step: i,
      thought: call.thought ?? "",
      call,
      result,
    };
    steps.push(step);
    hState.lastResults.push(result);

    if (result.ok && (call.tool === "replace_in_file" || call.tool === "write_file")) {
      hState.phase = "verify";
    }

    if (call.tool === "run_command" && call.args.command === task.verifyCommand) {
      verifyOutput =
        result.error ??
        String((result.data as { stdout?: string })?.stdout ?? result.summary);
      if (result.ok) {
        ok = true;
        stoppedReason = "verify_passed";
        break;
      }
      hState.errorLog = verifyOutput;
      hState.phase = "locate";
    }

    if (call.tool === "finish") {
      ok = Boolean(call.args.ok) || (changed.size > 0 && !task.verifyCommand);
      if (result.ok && call.args.ok) ok = true;
      stoppedReason = String(call.args.message ?? "finish");
      // If we claim ok but have verifyCommand, must pass verify
      if (ok && task.verifyCommand && !task.dryRun) {
        const v = executeTool(ctx, {
          tool: "run_command",
          args: { command: task.verifyCommand },
        });
        steps.push({
          step: i + 0.5,
          thought: "Confirm finish with verify",
          call: { tool: "run_command", args: { command: task.verifyCommand } },
          result: v,
        });
        ok = v.ok;
        verifyOutput = v.error ?? String((v.data as { stdout?: string })?.stdout ?? "");
        stoppedReason = ok ? "finish_verified" : "finish_verify_failed";
      }
      break;
    }
  }

  diagnosed = classifyFailures(task.goal, hState.errorLog ?? task.errorLog);
  const base: Omit<AgentRunResult, "reportMarkdown"> = {
    sessionId,
    ok,
    goal: task.goal,
    steps,
    filesChanged: [...changed],
    verifyOutput,
    stoppedReason,
  };
  return { ...base, reportMarkdown: formatReport(base, diagnosed) };
}

/** @deprecated Prefer `runWarden` — same implementation. */
export const runApiBugAgent = runWarden;

/** @deprecated Renamed to `runWarden`. */
export const runWelder = runWarden;
