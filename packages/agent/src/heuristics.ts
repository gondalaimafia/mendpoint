/**
 * Warden heuristic planner — no LLM required.
 * Turns goal + observations into tool calls across API communication failure modes.
 */
import type { ToolCall, ToolResult } from "./types.js";
import { extractHints } from "./heuristics-core.js";
import { proposeWardenFix } from "./fixes.js";
import { classifyFailures } from "./knowledge.js";

export type HeuristicState = {
  goal: string;
  errorLog?: string;
  step: number;
  lastResults: ToolResult[];
  filesChanged: string[];
  verifyCommand?: string;
  phase: "explore" | "locate" | "read" | "fix" | "verify" | "done";
  candidates: string[];
  focusFile?: string;
  triedFixes: Set<string>;
  /** Classified failure mode ids for reporting */
  diagnosedModes?: string[];
};

export { extractHints, extractRenames, extractApiPaths } from "./heuristics-core.js";

const API_KEYWORDS =
  /fetch|axios|http|api|endpoint|Bearer|Authorization|status|json\(|\.get\(|\.post\(|\/v\d+\/|Content-Type|apiKey|api_key|amount_cents|starting_after|max_tokens|webhook|retry|timeout|graphql|grpc|rate.?limit|idempoten/i;

export function nextHeuristicCall(state: HeuristicState): ToolCall {
  if (!state.diagnosedModes) {
    state.diagnosedModes = classifyFailures(state.goal, state.errorLog).map((m) => m.id);
  }
  const hints = extractHints(state.goal, state.errorLog);

  if (state.phase === "verify" && state.verifyCommand) {
    return {
      tool: "run_command",
      args: { command: state.verifyCommand },
      thought: "Re-run verification after edits",
    };
  }

  if (state.phase === "done") {
    return {
      tool: "finish",
      args: { ok: state.filesChanged.length > 0, message: "complete" },
      thought: "Done",
    };
  }

  const lastSearch = [...state.lastResults].reverse().find((r) => r.tool === "search" && r.ok);
  const lastRead = [...state.lastResults].reverse().find((r) => r.tool === "read_file" && r.ok);
  const lastList = [...state.lastResults].reverse().find((r) => r.tool === "list_dir" && r.ok);
  const lastReplace = [...state.lastResults]
    .reverse()
    .find((r) => r.tool === "replace_in_file" || r.tool === "write_file");

  if (lastReplace?.ok && state.verifyCommand && state.phase !== "locate") {
    state.phase = "verify";
    return {
      tool: "run_command",
      args: { command: state.verifyCommand },
      thought: "Re-run verification after edit",
    };
  }

  if (lastRead?.ok && (state.phase === "read" || state.phase === "fix" || state.focusFile)) {
    const content = String((lastRead.data as { content?: string })?.content ?? "");
    const path = String((lastRead.data as { path?: string })?.path ?? state.focusFile ?? "");
    const fix = proposeWardenFix(content, path, state.goal, state.errorLog, state.triedFixes);
    if (fix) {
      state.phase = "fix";
      state.triedFixes.add(fix.key);
      return {
        ...fix.call,
        thought: fix.call.thought ?? `Apply Warden fix${fix.modeId ? ` [${fix.modeId}]` : ""}`,
      };
    }
    const idx = state.candidates.indexOf(path);
    if (idx >= 0 && idx < state.candidates.length - 1) {
      state.focusFile = state.candidates[idx + 1];
      state.phase = "read";
      return {
        tool: "read_file",
        args: { path: state.focusFile },
        thought: `Read next candidate ${state.focusFile}`,
      };
    }
  }

  if (lastSearch?.ok && state.candidates.length === 0) {
    const hits = (lastSearch.data as { hits?: Array<{ path: string }> })?.hits ?? [];
    state.candidates = [...new Set(hits.map((h) => h.path))].slice(0, 10);
  }
  if (lastList?.ok && state.candidates.length === 0) {
    const files = (lastList.data as { files?: string[] })?.files ?? [];
    state.candidates = files.filter(
      (f) => API_KEYWORDS.test(f) || /client|api|http|sdk|charge|webhook|retry|fetch/i.test(f),
    );
    if (!state.candidates.length) state.candidates = files.slice(0, 8);
  }
  if (state.candidates.length && !state.focusFile) {
    state.focusFile = state.candidates[0];
    state.phase = "read";
    return {
      tool: "read_file",
      args: { path: state.focusFile },
      thought: `Read API client candidate ${state.focusFile}`,
    };
  }

  if (!lastList) {
    state.phase = "explore";
    return {
      tool: "list_dir",
      args: { path: "." },
      thought: "Map repository structure for API client / webhook / retry code",
    };
  }

  const searchCount = state.lastResults.filter((r) => r.tool === "search").length;
  if (searchCount < Math.min(hints.length + 1, 8) || state.candidates.length === 0) {
    state.phase = "locate";
    const q = hints[searchCount % Math.max(hints.length, 1)] ?? "fetch";
    const key = `search:${q}`;
    if (!state.triedFixes.has(key) || state.candidates.length === 0) {
      state.triedFixes.add(key);
      return {
        tool: "search",
        args: { query: q },
        thought: `Locate API usage: ${q}`,
      };
    }
  }

  const lastRun = [...state.lastResults].reverse().find((r) => r.tool === "run_command");
  if (lastRun && !lastRun.ok) {
    state.errorLog = (lastRun.error ?? "") + "\n" + JSON.stringify(lastRun.data ?? "");
    state.diagnosedModes = classifyFailures(state.goal, state.errorLog).map((m) => m.id);
    state.phase = "read";
    if (state.focusFile) {
      return {
        tool: "read_file",
        args: { path: state.focusFile },
        thought: `Verify failed — re-read ${state.focusFile} for next fix`,
      };
    }
    state.phase = "locate";
    state.candidates = [];
    state.focusFile = undefined;
  }

  if (state.verifyCommand && state.filesChanged.length) {
    state.phase = "verify";
    return {
      tool: "run_command",
      args: { command: state.verifyCommand },
      thought: "Final verify",
    };
  }

  const ok =
    lastRun?.ok === true || (state.filesChanged.length > 0 && !state.verifyCommand);
  const modes = state.diagnosedModes?.slice(0, 6).join(", ") ?? "";
  return {
    tool: "finish",
    args: {
      ok,
      message: ok
        ? `Applied Warden API fixes${modes ? ` (${modes})` : ""}`
        : `Could not fully resolve — FDE review needed${modes ? ` · modes: ${modes}` : ""}`,
    },
    thought: "Stop: max heuristic path",
  };
}
