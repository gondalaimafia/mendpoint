/**
 * Agent tools — sandboxed to repoRoot.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runVerificationCommand } from "@mendpoint/repair";
import { commandBlocked, isCodeExt, pathBlocked, DEFAULT_NEVER_TOUCH } from "./policies.js";
import type { AgentSourceContextBudget, ToolCall, ToolResult } from "./types.js";

export type ToolSourceContextState = {
  requireObservation: boolean;
  budget: AgentSourceContextBudget;
  /** Immutable first content observed from the source tree for replay evidence. */
  sourceEvidenceFiles: Map<string, { digest: string; bytes: number }>;
  /** Current working content used by the read before write mutation fence. */
  observedFiles: Map<string, { digest: string; bytes: number }>;
  observedDirectories: Set<string>;
  searches: Set<string>;
  observedBytes: number;
  searchBytes: number;
  truncatedObservations: number;
  groundedMutations: number;
  blockedMutations: number;
  changedBytes: number;
};

export type ToolContext = {
  repoRoot: string;
  dryRun?: boolean;
  neverTouchPaths?: string[];
  readOnlyPaths?: string[];
  allowNetwork?: boolean;
  /** Test and explicitly trusted development use only. */
  allowPrivateNetwork?: boolean;
  allowedCommands?: string[];
  changedFiles: Set<string>;
  sourceContext?: ToolSourceContextState;
};

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const parts = normalized.split(".").map(Number);
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a! >= 224);
}

async function validateProbeTarget(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("probe protocol is not allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    if (!allowPrivateNetwork) throw new Error("private network probe blocked");
    return;
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("probe target did not resolve");
  if (!allowPrivateNetwork && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("private network probe blocked");
  }
}

function safeProbeHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!value || typeof value !== "object" || Array.isArray(value)) return headers;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_HEADER.test(name) || typeof raw !== "string") continue;
    if (["accept", "content-type", "user-agent", "x-request-id", "traceparent", "tracestate"]
      .includes(name.toLowerCase())) {
      headers.set(name, raw.slice(0, 1000));
    }
  }
  return headers;
}

function redactProbeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [redacted]")
    .replace(/\b(sk|rk)_(live|test)_[A-Za-z0-9_-]+\b/g, "[redacted key]");
}

type OriginalFileSnapshot = {
  existed: boolean;
  content?: string;
};

export type ToolRollbackResult = {
  performed: boolean;
  restoredFiles: string[];
  failedFiles: string[];
};

const originalFilesByContext = new WeakMap<
  ToolContext,
  Map<string, OriginalFileSnapshot>
>();

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRel(repoRoot: string, p: string, allowMissing = false): string | null {
  const root = realpathSync(resolve(repoRoot));
  const abs = resolve(root, p);
  if (!isWithin(root, abs)) return null;
  let cursor = root;
  for (const segment of relative(root, abs).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return null;
    } catch {
      break;
    }
  }

  if (existsSync(abs)) {
    const real = realpathSync(abs);
    if (!isWithin(root, real)) return null;
    return relative(root, real).replace(/\\/g, "/") || ".";
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

function walk(
  dir: string,
  root: string,
  out: string[] = [],
  depth = 0,
  maxFiles = 2_000,
): string[] {
  if (depth > 8 || out.length >= maxFiles) return out;
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
    if (st.isDirectory()) walk(abs, root, out, depth + 1, maxFiles);
    else if (isCodeExt(name) && out.length < maxFiles) out.push(rel);
  }
  return out;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function blockMutation(ctx: ToolContext, tool: ToolCall["tool"], summary: string, error: string): ToolResult {
  if (ctx.sourceContext) ctx.sourceContext.blockedMutations++;
  return { ok: false, tool, summary, error };
}

function assertObservedMutation(
  ctx: ToolContext,
  safe: string,
  absolutePath: string,
): ToolResult | undefined {
  const state = ctx.sourceContext;
  if (!state?.requireObservation) return undefined;
  if (existsSync(absolutePath)) {
    const observed = state.observedFiles.get(safe);
    if (!observed) {
      return blockMutation(ctx, "write_file", `read ${safe} before changing it`, "source_context_required");
    }
    const stat = statSync(absolutePath);
    if (!stat.isFile() || stat.size > state.budget.maxFileBytes) {
      return blockMutation(ctx, "write_file", `source fence rejected ${safe}`, "source_context_invalid");
    }
    const current = readFileSync(absolutePath);
    if (sha256(current) !== observed.digest) {
      return blockMutation(ctx, "write_file", `source changed after observation: ${safe}`, "source_context_stale");
    }
    return undefined;
  }
  const parent = relative(realpathSync(resolve(ctx.repoRoot)), dirname(absolutePath))
    .replace(/\\/g, "/") || ".";
  if (!state.observedDirectories.has(parent)) {
    return blockMutation(ctx, "write_file", `list ${parent} before creating ${safe}`, "source_context_required");
  }
  return undefined;
}

function recordMutation(ctx: ToolContext, safe: string, content: string): void {
  const state = ctx.sourceContext;
  if (!state) return;
  const bytes = Buffer.byteLength(content, "utf8");
  state.changedBytes += bytes;
  state.groundedMutations++;
  state.observedFiles.set(safe, { digest: sha256(content), bytes });
}

function captureOriginal(
  ctx: ToolContext,
  safe: string,
  absolutePath: string,
): void {
  let originals = originalFilesByContext.get(ctx);
  if (!originals) {
    originals = new Map();
    originalFilesByContext.set(ctx, originals);
  }
  if (originals.has(safe)) return;
  if (existsSync(absolutePath)) {
    originals.set(safe, {
      existed: true,
      content: readFileSync(absolutePath, "utf8"),
    });
  } else {
    originals.set(safe, { existed: false });
  }
}

export function rollbackToolWrites(ctx: ToolContext): ToolRollbackResult {
  const restoredFiles: string[] = [];
  const failedFiles: string[] = [];
  const originals = originalFilesByContext.get(ctx);
  if (!originals?.size || ctx.dryRun) {
    return { performed: false, restoredFiles, failedFiles };
  }

  for (const [rel, original] of originals) {
    try {
      const safe = safeRel(ctx.repoRoot, rel, true);
      if (
        !safe || safe !== rel ||
        pathBlocked(safe, [
          ...DEFAULT_NEVER_TOUCH,
          ...(ctx.neverTouchPaths ?? []),
          ...(ctx.readOnlyPaths ?? []),
        ])
      ) {
        failedFiles.push(rel);
        continue;
      }
      const absolutePath = join(ctx.repoRoot, safe);
      if (original.existed) {
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, original.content ?? "", "utf8");
      } else if (existsSync(absolutePath)) {
        rmSync(absolutePath, { force: true });
      }
      restoredFiles.push(rel);
    } catch {
      failedFiles.push(rel);
    }
  }

  return {
    performed: restoredFiles.length > 0 || failedFiles.length > 0,
    restoredFiles,
    failedFiles,
  };
}

export function executeTool(ctx: ToolContext, call: ToolCall): ToolResult {
  const never = [...DEFAULT_NEVER_TOUCH, ...(ctx.neverTouchPaths ?? [])];
  const neverMutate = [...never, ...(ctx.readOnlyPaths ?? [])];
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
        ctx.sourceContext?.observedDirectories.add(safe);
        const files = walk(
          abs,
          ctx.repoRoot,
          [],
          0,
          Math.min(ctx.sourceContext?.budget.maxSearchFiles ?? 200, 2_000),
        ).slice(0, 200);
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
        const stat = statSync(abs);
        const maxFileBytes = ctx.sourceContext?.budget.maxFileBytes ?? 1024 * 1024;
        if (!stat.isFile() || stat.size > maxFileBytes) {
          return { ok: false, tool, summary: "file exceeds source budget", error: "source_budget" };
        }
        const bytes = readFileSync(abs);
        const state = ctx.sourceContext;
        if (state && state.observedBytes + bytes.byteLength > state.budget.maxTotalReadBytes) {
          return { ok: false, tool, summary: "source read budget exhausted", error: "source_budget" };
        }
        const requestedMax = Number(args.maxChars ?? 12_000);
        const max = Number.isFinite(requestedMax)
          ? Math.max(1, Math.min(Math.floor(requestedMax), maxFileBytes))
          : Math.min(12_000, maxFileBytes);
        const content = bytes.toString("utf8");
        if (state) {
          state.observedBytes += bytes.byteLength;
          const observation = { digest: sha256(bytes), bytes: bytes.byteLength };
          if (!state.sourceEvidenceFiles.has(safe)) {
            state.sourceEvidenceFiles.set(safe, observation);
          }
          state.observedFiles.set(safe, observation);
          if (content.length > max) state.truncatedObservations++;
        }
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
        const state = ctx.sourceContext;
        const maxFiles = state?.budget.maxSearchFiles ?? 2_000;
        const maxBytes = state?.budget.maxSearchBytes ?? 8 * 1024 * 1024;
        const maxHits = state?.budget.maxSearchHits ?? 40;
        const files = walk(ctx.repoRoot, ctx.repoRoot, [], 0, maxFiles);
        const hits: Array<{ path: string; line: number; text: string }> = [];
        const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        let scannedBytes = 0;
        for (const f of files) {
          if (pathBlocked(f, never)) continue;
          let text: string;
          try {
            const stat = statSync(join(ctx.repoRoot, f));
            if (!stat.isFile() || stat.size > (state?.budget.maxFileBytes ?? 1024 * 1024)) continue;
            if (scannedBytes + stat.size > maxBytes) break;
            const value = readFileSync(join(ctx.repoRoot, f));
            scannedBytes += value.byteLength;
            text = value.toString("utf8");
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          lines.forEach((line, i) => {
            if (re.test(line) && hits.length < maxHits) {
              hits.push({ path: f, line: i + 1, text: line.trim().slice(0, 200) });
            }
          });
        }
        if (state) {
          state.searches.add(query);
          state.searchBytes += scannedBytes;
          if (files.length >= maxFiles || scannedBytes >= maxBytes || hits.length >= maxHits) {
            state.truncatedObservations++;
          }
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
        if (!safe || pathBlocked(safe, neverMutate)) {
          return { ok: false, tool, summary: "blocked path", error: "policy" };
        }
        const abs = join(ctx.repoRoot, safe);
        const state = ctx.sourceContext;
        const contentBytes = Buffer.byteLength(content, "utf8");
        if (state && (
          contentBytes > state.budget.maxFileBytes ||
          (!ctx.changedFiles.has(safe) && ctx.changedFiles.size >= state.budget.maxChangedFiles) ||
          state.changedBytes + contentBytes > state.budget.maxChangedBytes
        )) {
          return blockMutation(ctx, tool, `change budget rejected ${safe}`, "change_budget");
        }
        const sourceFence = assertObservedMutation(ctx, safe, abs);
        if (sourceFence) return { ...sourceFence, tool };
        if (existsSync(abs) && readFileSync(abs, "utf8") === content) {
          return {
            ok: false,
            tool,
            summary: `no change for ${safe}`,
            error: "no_change",
          };
        }
        captureOriginal(ctx, safe, abs);
        if (ctx.dryRun) {
          ctx.changedFiles.add(safe);
          recordMutation(ctx, safe, content);
          return {
            ok: true,
            tool,
            summary: `dry-run write ${safe}`,
            data: { path: safe, simulated: true },
          };
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        ctx.changedFiles.add(safe);
        recordMutation(ctx, safe, content);
        return { ok: true, tool, summary: `wrote ${safe}`, data: { path: safe } };
      }

      case "replace_in_file": {
        const rel = String(args.path ?? "");
        const from = String(args.from ?? "");
        const to = String(args.to ?? "");
        const global = args.global !== false;
        const safe = safeRel(ctx.repoRoot, rel);
        if (!safe || pathBlocked(safe, neverMutate)) {
          return { ok: false, tool, summary: "blocked path", error: "policy" };
        }
        if (!from) return { ok: false, tool, summary: "from required", error: "args" };
        const abs = join(ctx.repoRoot, safe);
        if (!existsSync(abs)) return { ok: false, tool, summary: "not found", error: "ENOENT" };
        const original = readFileSync(abs, "utf8");
        const sourceFence = assertObservedMutation(ctx, safe, abs);
        if (sourceFence) return { ...sourceFence, tool };
        const re = new RegExp(
          from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          global ? "g" : "",
        );
        if (!re.test(original)) {
          return { ok: false, tool, summary: `pattern not found in ${safe}`, error: "no_match" };
        }
        const updated = original.replace(re, to);
        if (updated === original) {
          return {
            ok: false,
            tool,
            summary: `no change for ${safe}`,
            error: "no_change",
          };
        }
        const state = ctx.sourceContext;
        const updatedBytes = Buffer.byteLength(updated, "utf8");
        if (state && (
          updatedBytes > state.budget.maxFileBytes ||
          (!ctx.changedFiles.has(safe) && ctx.changedFiles.size >= state.budget.maxChangedFiles) ||
          state.changedBytes + updatedBytes > state.budget.maxChangedBytes
        )) {
          return blockMutation(ctx, tool, `change budget rejected ${safe}`, "change_budget");
        }
        captureOriginal(ctx, safe, abs);
        if (ctx.dryRun) {
          ctx.changedFiles.add(safe);
          recordMutation(ctx, safe, updated);
          return {
            ok: true,
            tool,
            summary: `dry-run replace in ${safe}`,
            data: { path: safe, preview: updated.slice(0, 500), simulated: true },
          };
        }
        writeFileSync(abs, updated, "utf8");
        ctx.changedFiles.add(safe);
        recordMutation(ctx, safe, updated);
        return { ok: true, tool, summary: `replaced in ${safe}`, data: { path: safe } };
      }

      case "run_command": {
        return {
          ok: false,
          tool,
          summary: "command requires asynchronous execution",
          error: "async_required",
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
  if (call.tool === "run_command") {
    const cmd = String(call.args.command ?? "");
    if (!cmd) {
      return { ok: false, tool: "run_command", summary: "command required", error: "args" };
    }
    if (commandBlocked(cmd) || !ctx.allowedCommands?.includes(cmd)) {
      return {
        ok: false,
        tool: "run_command",
        summary: "command blocked by policy",
        error: "policy",
      };
    }
    if (ctx.dryRun) {
      return {
        ok: true,
        tool: "run_command",
        summary: `dry-run: ${cmd}`,
        data: { stdout: "", simulated: true },
      };
    }
    const execution = await runVerificationCommand(
      cmd,
      ctx.repoRoot,
      Number(call.args.timeoutMs ?? 60_000),
    );
    if (execution.ok) {
      return {
        ok: true,
        tool: "run_command",
        summary: `exit 0: ${cmd}`,
        data: { stdout: execution.stdout.slice(0, 8000), exitCode: 0 },
      };
    }
    return {
      ok: false,
      tool: "run_command",
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
    if (!new Set(["GET", "HEAD"]).has(method)) {
      return {
        ok: false,
        tool: "http_probe",
        summary: "probe method blocked by policy",
        error: "policy",
      };
    }
    try {
      const ctrl = new AbortController();
      const timeoutMs = Math.max(
        100,
        Math.min(Number(call.args.timeoutMs ?? 10_000), 60_000),
      );
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        let target = new URL(url);
        let res: Response | undefined;
        const headers = safeProbeHeaders(call.args.headers);
        for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
          await validateProbeTarget(target, ctx.allowPrivateNetwork ?? false);
          res = await fetch(target, {
            method,
            signal: ctrl.signal,
            headers,
            redirect: "manual",
          });
          if (![301, 302, 303, 307, 308].includes(res.status)) break;
          const location = res.headers.get("location");
          if (!location) break;
          if (redirectCount === 3) throw new Error("probe redirect limit exceeded");
          const next = new URL(location, target);
          if (next.origin !== target.origin) {
            for (const name of [...headers.keys()]) {
              if (name !== "accept" && name !== "user-agent") headers.delete(name);
            }
          }
          target = next;
        }
        if (!res) throw new Error("probe did not produce a response");
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
            body: redactProbeText(text.slice(0, 2000)),
            headers: Object.fromEntries(
              [...res.headers.entries()]
                .filter(([name]) => !SENSITIVE_HEADER.test(name))
                .slice(0, 20),
            ),
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
