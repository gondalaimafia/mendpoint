/**
 * API-domain heuristic planner — no LLM required.
 * Turns goal + observations into tool calls.
 */
import type { ToolCall, ToolResult } from "./types.js";

export type HeuristicState = {
  goal: string;
  errorLog?: string;
  step: number;
  lastResults: ToolResult[];
  filesChanged: string[];
  verifyCommand?: string;
  phase:
    | "explore"
    | "locate"
    | "read"
    | "fix"
    | "verify"
    | "done";
  candidates: string[];
  focusFile?: string;
  triedFixes: Set<string>;
};

const API_KEYWORDS =
  /fetch|axios|http|api|endpoint|Bearer|Authorization|status|json\(|\.get\(|\.post\(|\/v\d+\/|Content-Type|apiKey|api_key|amount_cents|starting_after|max_tokens/i;

/** Parse "rename X to Y" / "X → Y" style migration hints from free text. */
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

/** Pull API path tokens like /v1/charges from logs. */
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
    /\b(amount_cents|starting_after|max_tokens|max_completion_tokens|Bearer|404|401|403|422|500|ENOENT|Cannot find|TypeError|fetch failed|Content-Type|application\/json)\b/gi,
  )) {
    hints.push(m[1]!);
  }
  for (const p of extractApiPaths(text)) hints.push(p);
  for (const r of extractRenames(text)) {
    hints.push(r.from, r.to);
  }
  // common typo patterns
  if (/chargess|endpoint.*wrong|404/i.test(text)) hints.push("/v1/charges", "charges");
  if (/amount_cents|rename.*amount/i.test(text)) hints.push("amount_cents", "amount");
  if (/auth|401|unauthorized|api.?key/i.test(text)) hints.push("Authorization", "apiKey", "Bearer");
  if (/content-type|json body|application\/json/i.test(text)) {
    hints.push("Content-Type", "application/json");
  }
  return [...new Set(hints)].slice(0, 16);
}

export function nextHeuristicCall(state: HeuristicState): ToolCall {
  const hints = extractHints(state.goal, state.errorLog);

  // After fix, verify
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

  // After a successful edit, prefer verify before more exploration
  if (lastReplace?.ok && state.verifyCommand && state.phase !== "locate") {
    state.phase = "verify";
    return {
      tool: "run_command",
      args: { command: state.verifyCommand },
      thought: "Re-run verification after edit",
    };
  }

  // After reading a file, try an API-domain fix immediately
  if (lastRead?.ok && (state.phase === "read" || state.phase === "fix" || state.focusFile)) {
    const content = String((lastRead.data as { content?: string })?.content ?? "");
    const path = String((lastRead.data as { path?: string })?.path ?? state.focusFile ?? "");
    const fix = proposeApiFix(content, path, state.goal, state.errorLog, state.triedFixes);
    if (fix) {
      state.phase = "fix";
      state.triedFixes.add(fix.key);
      return fix.call;
    }
    // Try next candidate file
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

  // Promote search hits into candidates and read first hit
  if (lastSearch?.ok && state.candidates.length === 0) {
    const hits = (lastSearch.data as { hits?: Array<{ path: string }> })?.hits ?? [];
    state.candidates = [...new Set(hits.map((h) => h.path))].slice(0, 8);
  }
  if (lastList?.ok && state.candidates.length === 0) {
    const files = (lastList.data as { files?: string[] })?.files ?? [];
    state.candidates = files.filter(
      (f) => API_KEYWORDS.test(f) || /client|api|http|sdk|charge/i.test(f),
    );
    if (!state.candidates.length) state.candidates = files.slice(0, 5);
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

  // Explore listing once
  if (!lastList) {
    state.phase = "explore";
    return {
      tool: "list_dir",
      args: { path: "." },
      thought: "Map repository structure for API client code",
    };
  }

  // Search for API-related symbols (rotate hints; avoid infinite same search)
  const searchCount = state.lastResults.filter((r) => r.tool === "search").length;
  if (searchCount < Math.min(hints.length + 1, 6) || state.candidates.length === 0) {
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

  // If verify failed, continue locating with error
  const lastRun = [...state.lastResults].reverse().find((r) => r.tool === "run_command");
  if (lastRun && !lastRun.ok) {
    state.errorLog = (lastRun.error ?? "") + "\n" + JSON.stringify(lastRun.data ?? "");
    state.phase = "read";
    // Re-read focus file with updated error context for another fix
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

  // Exhausted
  const ok =
    lastRun?.ok === true || (state.filesChanged.length > 0 && !state.verifyCommand);
  return {
    tool: "finish",
    args: {
      ok,
      message: ok
        ? "Applied API-focused fixes"
        : "Could not fully resolve — human review needed",
    },
    thought: "Stop: max heuristic path",
  };
}

function proposeApiFix(
  content: string,
  path: string,
  goal: string,
  errorLog: string | undefined,
  tried: Set<string>,
): { key: string; call: ToolCall } | null {
  const blob = `${goal}\n${errorLog ?? ""}\n${content}`;
  const goalErr = `${goal}\n${errorLog ?? ""}`;

  // Explicit renames from goal/error ("rename amount_cents to amount")
  for (const { from, to } of extractRenames(goalErr)) {
    if (content.includes(from) && !tried.has(`${path}:rename:${from}->${to}`)) {
      const key = `${path}:rename:${from}->${to}`;
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: { path, from, to, global: true },
          thought: `Apply rename ${from} → ${to}`,
        },
      };
    }
  }

  // Typo: /v1/chargess → /v1/charges
  if (/chargess/.test(content)) {
    const key = `${path}:chargess`;
    if (!tried.has(key)) {
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: { path, from: "chargess", to: "charges", global: true },
          thought: "Fix API path typo chargess → charges",
        },
      };
    }
  }

  // Path in file that looks wrong vs paths mentioned as correct in goal/error
  {
    const filePaths = extractApiPaths(content);
    const logPaths = extractApiPaths(goalErr);
    // Prefer correct form without double-s / trailing junk
    for (const wrong of filePaths) {
      const corrected = wrong.replace(/ss(\/|$)/, "s$1").replace(/\/\/+/g, "/");
      if (corrected !== wrong && content.includes(wrong)) {
        const key = `${path}:pathfix:${wrong}`;
        if (!tried.has(key)) {
          return {
            key,
            call: {
              tool: "replace_in_file",
              args: { path, from: wrong, to: corrected, global: true },
              thought: `Normalize API path ${wrong} → ${corrected}`,
            },
          };
        }
      }
      // If error/goal names a different path and file has the bad one only
      for (const good of logPaths) {
        if (
          good !== wrong &&
          !content.includes(good) &&
          (goalErr.includes("404") || /should be|expected|correct path|fix/i.test(goalErr))
        ) {
          // Only swap when similar (same resource family)
          const wTail = wrong.split("/").pop() ?? "";
          const gTail = good.split("/").pop() ?? "";
          if (wTail && gTail && (wTail.startsWith(gTail) || gTail.startsWith(wTail.slice(0, -1)))) {
            const key = `${path}:swap:${wrong}->${good}`;
            if (!tried.has(key)) {
              return {
                key,
                call: {
                  tool: "replace_in_file",
                  args: { path, from: wrong, to: good, global: true },
                  thought: `Swap broken path ${wrong} → ${good}`,
                },
              };
            }
          }
        }
      }
    }
  }

  // amount_cents → amount when goal/error mentions rename
  if (
    /\bamount_cents\b/.test(content) &&
    (/amount_cents.*amount|rename.*amount|amount\b/i.test(blob) ||
      /amount_cents/i.test(goalErr))
  ) {
    const key = `${path}:amount_cents`;
    if (!tried.has(key)) {
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: { path, from: "amount_cents", to: "amount", global: true },
          thought: "Migrate field amount_cents → amount",
        },
      };
    }
  }

  // starting_after → page / cursor when mentioned
  if (/\bstarting_after\b/.test(content) && /starting_after|pagination|cursor|page/i.test(blob)) {
    const key = `${path}:starting_after`;
    if (!tried.has(key) && /page|cursor/i.test(goalErr)) {
      const to = /cursor/i.test(goalErr) ? "cursor" : "page";
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: { path, from: "starting_after", to, global: true },
          thought: `Pagination field starting_after → ${to}`,
        },
      };
    }
  }

  // max_tokens → max_completion_tokens
  if (/\bmax_tokens\b/.test(content) && /max_tokens|max_completion/i.test(blob)) {
    const key = `${path}:max_tokens`;
    if (!tried.has(key) && /max_completion|deprecated/i.test(goalErr)) {
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: { path, from: "max_tokens", to: "max_completion_tokens", global: true },
          thought: "OpenAI-style max_tokens → max_completion_tokens",
        },
      };
    }
  }

  // Missing Bearer prefix
  if (
    /Authorization['":\s]+['"]?\$\{?\w+\}?['"]?/.test(content) &&
    !/Bearer/.test(content) &&
    /401|unauthorized|auth/i.test(blob)
  ) {
    const key = `${path}:bearer`;
    if (!tried.has(key)) {
      if (content.includes("Authorization") && content.includes("apiKey")) {
        // Try common patterns
        const candidates: Array<[string, string]> = [
          ["Authorization: apiKey", "Authorization: Bearer ${apiKey}"],
          ['"Authorization": apiKey', '"Authorization": `Bearer ${apiKey}`'],
          ["'Authorization': apiKey", "'Authorization': `Bearer ${apiKey}`"],
          ["Authorization: ${apiKey}", "Authorization: Bearer ${apiKey}"],
          ['"Authorization": `${apiKey}`', '"Authorization": `Bearer ${apiKey}`'],
        ];
        for (const [from, to] of candidates) {
          if (content.includes(from)) {
            return {
              key,
              call: {
                tool: "replace_in_file",
                args: { path, from, to, global: false },
                thought: "Add Bearer prefix to Authorization header",
              },
            };
          }
        }
      }
    }
  }

  // Missing Content-Type: application/json on POST/PUT bodies
  if (
    /content-type|application\/json|json body/i.test(goalErr) &&
    /method:\s*["']POST["']|method:\s*["']PUT["']|\.post\(|fetch\(/i.test(content) &&
    !/Content-Type|content-type|application\/json/i.test(content)
  ) {
    const key = `${path}:content-type`;
    if (!tried.has(key) && /headers\s*:\s*\{/.test(content)) {
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: {
            path,
            from: "headers: {",
            to: 'headers: { "Content-Type": "application/json",',
            global: false,
          },
          thought: "Add Content-Type: application/json header",
        },
      };
    }
  }

  // http → https for API base URLs when mixed content / SSL mentioned
  if (/http:\/\/api\./.test(content) && /https|ssl|mixed/i.test(blob)) {
    const key = `${path}:https`;
    if (!tried.has(key)) {
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: { path, from: "http://api.", to: "https://api.", global: true },
          thought: "Upgrade API base URL to https",
        },
      };
    }
  }

  // Double slash path bug
  if (/\/v\d+\/\/\w+/.test(content)) {
    const key = `${path}:doubleslash`;
    if (!tried.has(key)) {
      const m = content.match(/\/(v\d+)\/\//);
      const ver = m?.[1] ?? "v1";
      return {
        key,
        call: {
          tool: "replace_in_file",
          args: { path, from: `/${ver}//`, to: `/${ver}/`, global: true },
          thought: "Fix double-slash in API path",
        },
      };
    }
  }

  // Trailing slash inconsistency when error mentions redirect / 308 / trailing
  if (
    /trailing.?slash|308|301.*slash/i.test(goalErr) &&
    /\/v\d+\/[A-Za-z0-9_-]+\/["'`]/.test(content)
  ) {
    const key = `${path}:trailslash`;
    if (!tried.has(key)) {
      const m = content.match(/(\/v\d+\/[A-Za-z0-9_-]+)\/(["'`])/);
      if (m) {
        return {
          key,
          call: {
            tool: "replace_in_file",
            args: { path, from: `${m[1]}/${m[2]}`, to: `${m[1]}${m[2]}`, global: true },
            thought: "Remove trailing slash on API path",
          },
        };
      }
    }
  }

  return null;
}
