/**
 * CI-fix loop scaffold — check status → comment → optional local re-run commands.
 * Does not auto-merge. Bounded attempts.
 */
import { execSync } from "node:child_process";
import {
  formatCiCheckComment,
  type PrCommenter,
  type CiCheckInput,
  MockPrCommenter,
  postCiCheck,
} from "@mendpoint/github";

export type CiLoopStep =
  | { kind: "run_command"; command: string; cwd?: string }
  | { kind: "comment"; body: string }
  | { kind: "done"; ok: boolean; reason: string };

export type CiLoopResult = {
  ok: boolean;
  attempts: number;
  steps: Array<{ step: string; ok: boolean; output?: string }>;
  finalComment?: string;
};

export type CiLoopOptions = {
  maxAttempts?: number;
  /** Commands to run after each PR draft (e.g. npm test) */
  commands?: string[];
  cwd?: string;
  commenter?: PrCommenter;
  ciCheck?: CiCheckInput;
  dryRun?: boolean;
};

/**
 * Run bounded verify commands; on failure post advisory comment.
 * Real "agentic fix" would mutate files between attempts — here we re-run checks
 * and report; integrate with generation re-run externally.
 */
export async function runCiLoop(opts: CiLoopOptions = {}): Promise<CiLoopResult> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const commands = opts.commands ?? [];
  const steps: CiLoopResult["steps"] = [];
  let attempt = 0;
  let lastFail = "";

  while (attempt < maxAttempts) {
    attempt++;
    let allOk = true;
    for (const cmd of commands) {
      if (opts.dryRun) {
        steps.push({ step: `dry:${cmd}`, ok: true, output: "skipped (dryRun)" });
        continue;
      }
      try {
        const output = execSync(cmd, {
          cwd: opts.cwd,
          encoding: "utf8",
          timeout: 120_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        steps.push({ step: cmd, ok: true, output: output.slice(0, 500) });
      } catch (e: unknown) {
        allOk = false;
        const msg =
          e && typeof e === "object" && "stderr" in e
            ? String((e as { stderr?: Buffer }).stderr ?? e)
            : e instanceof Error
              ? e.message
              : String(e);
        lastFail = msg.slice(0, 800);
        steps.push({ step: cmd, ok: false, output: lastFail });
        break;
      }
    }
    if (allOk) {
      const finalComment = opts.ciCheck
        ? formatCiCheckComment({
            ...opts.ciCheck,
            harness: [
              ...(opts.ciCheck.harness ?? []),
              { name: "Local CI loop", passed: true, detail: `${attempt} attempt(s)` },
            ],
          })
        : undefined;
      if (finalComment && opts.commenter && opts.ciCheck) {
        await postCiCheck(opts.commenter, {
          ...opts.ciCheck,
          harness: [
            ...(opts.ciCheck.harness ?? []),
            { name: "Local CI loop", passed: true },
          ],
        });
      }
      return { ok: true, attempts: attempt, steps, finalComment };
    }
  }

  const commenter = opts.commenter ?? new MockPrCommenter();
  const finalComment = formatCiCheckComment({
    owner: opts.ciCheck?.owner ?? "local",
    repo: opts.ciCheck?.repo ?? "local",
    prNumber: opts.ciCheck?.prNumber ?? 0,
    title: opts.ciCheck?.title ?? "CI loop",
    policyNotes: [
      "CI loop failed after max attempts — human review required",
      lastFail.slice(0, 200),
    ],
    harness: [{ name: "Local CI loop", passed: false, detail: lastFail.slice(0, 120) }],
  });
  if (opts.ciCheck?.prNumber) {
    await postCiCheck(commenter, {
      ...opts.ciCheck,
      harness: [{ name: "Local CI loop", passed: false }],
      policyNotes: ["CI loop failed — no auto-merge"],
    });
  }
  return { ok: false, attempts: attempt, steps, finalComment };
}

export { formatCiCheckComment };
