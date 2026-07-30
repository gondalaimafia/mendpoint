/**
 * Agent tools — sandboxed to repoRoot.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runVerificationCommand } from "@mendpoint/repair";
import { commandBlocked, isCodeExt, pathBlocked, DEFAULT_NEVER_TOUCH } from "./policies.js";
import type { ToolCall, ToolResult } from "./types.js";

export type ToolContext = {
  repoRoot: string;
  dryRun?: boolean;
  neverTouchPaths?: string[];
  allowNetwork?: boolean;
  allowedCommands?: string[];
  changedFiles: Set<string>;
};

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRel(repoRoot: string, p: string, allowMissing = false): string | null {
  const root = realpathSync(resolve(repoRoot));
  const abs = resolve(root, p);
  if (!isWithin(root, abs)) return null;

  if (existsSync(abs)) {
    const real = realpathSync(abs);
    if (!isWithin(root, real)) return null;
  } else if (allowMissing) {
    let parent = dirname(abs);
    while (!existsSync(parent)) {
      const next = dirname(parent);
      if (next === parent) return null;
      parent = next;
    }
    if (!isWithin(root, realpathSync(parent))) return null;
  } else {
    return null;
  }
  return relative(root, abs).replace(/\\/g, "/") || ".";
}

function walk(dir: string, root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === ".next") {
      continue;
    }
    const abs = join(dir, name);
    let st;
    try {
      const link = lstatSync(abs);
      if (link.isSymbolicLink()) continue;
      st = statSync(abs);
    } catch {
      continue;
    }
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (st.isDirectory()) walk(abs, root, out, depth + 1);
    else if (isCodeExt(name)) out.push(rel);
  }
  return out;
}

export function executeTool(ctx: ToolContext, call: ToolCall): ToolResult {
  const never = ctx.neverTouchPaths ?? DEFAULT_NEVER_TOUCH;
  const tool = call.tool;
  const args = call.args;

  try {
    switch (tool) {
      case "list_dir": {
        const rel = String(args.path ?? ".");
        const safe = safeRel(ctx.repoRoot, rel);
        if (!safe) return { ok: false, tool, summary: "path escape blocked", error: "path" };
        const abs = join(ctx.repoRoot, safe);
        if (!existsSync(abs)) return { ok: false, tool, summary: "not found", error: "ENOENT" };
        const st = statSync(abs);
        if (st.isFile()) {
          return { ok: true, tool, summary: `file ${safe}`, data: { files: [safe] } };
        }
        const files = walk(abs, ctx.repoRoot).slice(0, 200);
        return {
          ok: true,
          tool,
          summary: `${files.length} code files under ${safe}`,
          data: { files },
        };
      }

      case "read_file": {
        const rel = String(args.path ?? "");
        const safe = safeRel(ctx.repoRoot, rel);
        if (!safe || pathBlocked(safe, never)) {
          return { ok: false, tool, summary: "blocked path", error: "policy" };
        }
        const abs = join(ctx.repoRoot, safe);
        if (!existsSync(abs)) return { ok: false, tool, summary: "not found", error: "ENOENT" };
        const content = readFileSync(abs, "utf8");
        const max = Number(args.maxChars ?? 12_000);
        return {
          ok: true,
          tool,
          summary: `read ${safe} (${content.length} chars)`,
          data: { path: safe, content: content.slice(0, max) },
        };
      }

      case "search": {
        const query = String(args.query ?? "");
        if (!query || query.length < 2) {
          return { ok: false, tool, summary: "query too short", error: "args" };
        }
        const files = walk(ctx.repoRoot, ctx.repoRoot);
        const hits: Array<{ path: string; line: number; text: string }> = [];
        const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        for (const f of files) {
          if (pathBlocked(f, never)) continue;
          let text: string;
          try {
            text = readFileSync(join(ctx.repoRoot, f), "utf8");
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          lines.forEach((line, i) => {
            if (re.test(line) && hits.length < 40) {
              hits.push({ path: f, line: i + 1, text: line.trim().slice(0, 200) });
            }
          });
        }
        return {
          ok: true,
          tool,
          summary: `${hits.length} hits for ${JSON.stringify(query)}`,
          data: { hits },
        };
      }

      case "write_file": {
        const rel = String(args.path ?? "");
        const content = String(args.content ?? "");
        const safe = safeRel(ctx.repoRoot, rel, true);
        if (!safe || pathBlocked(safe, never)) {
          return { ok: false, tool, summary: "blocked path", error: "policy" };
        }
        if (ctx.dryRun) {
          ctx.changedFiles.add(safe);
          return { ok: true, tool, summary: `dry-run write ${safe}`, data: { path: safe } };
        }
        const abs = join(ctx.repoRoot, safe);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        ctx.changedFiles.add(safe);
        return { ok: true, tool, summary: `wrote ${safe}`, data: { path: safe } };
      }

      case "replace_in_file": {
        const rel = String(args.path ?? "");
        const from = String(args.from ?? "");
        const to = String(args.to ?? "");
        const global = args.global !== false;
        const safe = safeRel(ctx.repoRoot, rel);
        if (!safe || pathBlocked(safe, never)) {
          return { ok: false, tool, summary: "blocked path", error: "policy" };
        }
        if (!from) return { ok: false, tool, summary: "from required", error: "args" };
        const abs = join(ctx.repoRoot, safe);
        if (!existsSync(abs)) return { ok: false, tool, summary: "not found", error: "ENOENT" };
        const original = readFileSync(abs, "utf8");
        const re = new RegExp(
          from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          global ? "g" : "",
        );
        if (!re.test(original)) {
          return { ok: false, tool, summary: `pattern not found in ${safe}`, error: "no_match" };
        }
        const updated = original.replace(re, to);
        if (ctx.dryRun) {
          ctx.changedFiles.add(safe);
          return {
            ok: true,
            tool,
            summary: `dry-run replace in ${safe}`,
            data: { path: safe, preview: updated.slice(0, 500) },
          };
        }
        writeFileSync(abs, updated, "utf8");
        ctx.changedFiles.add(safe);
        return { ok: true, tool, summary: `replaced in ${safe}`, data: { path: safe } };
      }

      case "run_command": {
        const cmd = String(args.command ?? "");
        if (!cmd) return { ok: false, tool, summary: "command required", error: "args" };
        if (
          commandBlocked(cmd) ||
          !ctx.allowedCommands?.includes(cmd)
        ) {
          return { ok: false, tool, summary: "command blocked by policy", error: "policy" };
        }
        if (ctx.dryRun) {
          return { ok: true, tool, summary: `dry-run: ${cmd}`, data: { stdout: "" } };
        }
        const execution = runVerificationCommand(
          cmd,
          ctx.repoRoot,
          Number(args.timeoutMs ?? 60_000),
        );
        if (execution.ok) {
          return {
            ok: true,
            tool,
            summary: `exit 0: ${cmd}`,
            data: { stdout: execution.stdout.slice(0, 8000), exitCode: 0 },
          };
        }
        return {
          ok: false,
          tool,
          summary: `exit ${execution.exitCode}: ${cmd}`,
          error: (
            execution.stderr ||
            execution.stdout ||
            execution.error ||
            "verification failed"
          ).slice(0, 4000),
          data: {
            stdout: execution.stdout.slice(0, 4000),
            stderr: execution.stderr.slice(0, 4000),
            exitCode: execution.exitCode,
          },
        };
      }

      case "http_probe": {
        if (!ctx.allowNetwork) {
          return {
            ok: false,
            tool,
            summary: "network disabled (set allowNetwork)",
            error: "policy",
          };
        }
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, tool, summary: "invalid url", error: "args" };
        }
        // Synchronous-ish via deasync alternative: use Atomics wait not available —
        // return note that probe must be async wrapper
        return {
          ok: false,
          tool,
          summary: "use http_probe_async",
          error: "sync_not_supported",
        };
      }

      case "finish": {
        const ok = Boolean(args.ok ?? false);
        const message = String(args.message ?? (ok ? "done" : "failed"));
        return { ok, tool, summary: message, data: { ok, message } };
      }

      default:
        return { ok: false, tool, summary: "unknown tool", error: "unknown" };
    }
  } catch (e) {
    return {
      ok: false,
      tool,
      summary: "tool exception",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function executeToolAsync(
  ctx: ToolContext,
  call: ToolCall,
): Promise<ToolResult> {
  if (call.tool === "http_probe") {
    if (!ctx.allowNetwork) {
      return {
        ok: false,
        tool: "http_probe",
        summary: "network disabled",
        error: "policy",
      };
    }
    const url = String(call.args.url ?? "");
    const method = String(call.args.method ?? "GET").toUpperCase();
    try {
      const ctrl = new AbortController();
      const timeoutMs = Math.max(
        100,
        Math.min(Number(call.args.timeoutMs ?? 10_000), 60_000),
      );
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          signal: ctrl.signal,
          headers: (call.args.headers as Record<string, string>) ?? undefined,
          body: call.args.body ? String(call.args.body) : undefined,
        });
        const reader = res.body?.getReader();
        let text = "";
        if (reader) {
          const decoder = new TextDecoder();
          while (text.length < 2000) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
          }
          await reader.cancel();
        }
        return {
          ok: res.ok,
          tool: "http_probe",
          summary: `${method} ${url} → ${res.status}`,
          data: {
            status: res.status,
            body: text.slice(0, 2000),
            headers: Object.fromEntries([...res.headers.entries()].slice(0, 20)),
          },
        };
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      return {
        ok: false,
        tool: "http_probe",
        summary: "request failed",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return executeTool(ctx, call);
}
