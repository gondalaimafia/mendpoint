/**
 * Product entry: agentic repair loop (verify → repair → verify).
 * Replaces "just re-run CI" with actual mutations between attempts.
 */
import { runCiLoop, type CiLoopResult } from "@mendpoint/ci-loop";
import type { PrCommenter, CiCheckInput } from "@mendpoint/github";
import { MockPrCommenter, postCiCheck } from "@mendpoint/github";
import { runRepairSession } from "./session.js";
import type { RepairSessionResult } from "./types.js";

export type AgenticRepairLoopInput = {
  repoRoot: string;
  verifyCommands?: string[];
  maxAttempts?: number;
  renameMap?: Record<string, string>;
  useLlm?: boolean;
  dryRun?: boolean;
  neverTouchPaths?: string[];
  commenter?: PrCommenter;
  ciCheck?: CiCheckInput;
};

export type AgenticRepairLoopResult = {
  repair: RepairSessionResult;
  ci?: CiLoopResult;
  ok: boolean;
};

/**
 * 1) Run repair session (diagnose tree + optional seed failures from first verify)
 * 2) Post repair report as PR comment when ciCheck provided
 * 3) Optional final CI loop dry-pass for harness reporting
 */
export async function runAgenticRepairLoop(
  input: AgenticRepairLoopInput,
): Promise<AgenticRepairLoopResult> {
  // First capture failure log from verify if commands given
  let seedFailureLog: string | undefined;
  if (input.verifyCommands?.length && !input.dryRun) {
    const first = await runCiLoop({
      commands: input.verifyCommands,
      cwd: input.repoRoot,
      maxAttempts: 1,
      dryRun: false,
    });
    if (!first.ok) {
      seedFailureLog = first.steps
        .filter((s) => !s.ok)
        .map((s) => s.output ?? s.step)
        .join("\n");
    } else {
      // Already green — still scan for rename leftovers
    }
  }

  const repair = await runRepairSession({
    repoRoot: input.repoRoot,
    verifyCommands: input.verifyCommands,
    maxAttempts: input.maxAttempts ?? 3,
    renameMap: input.renameMap,
    useLlm: input.useLlm,
    dryRun: input.dryRun,
    neverTouchPaths: input.neverTouchPaths,
    seedFailureLog,
  });

  const commenter = input.commenter ?? new MockPrCommenter();
  if (input.ciCheck) {
    await postCiCheck(commenter, {
      ...input.ciCheck,
      harness: [
        ...(input.ciCheck.harness ?? []),
        {
          name: "Agentic repair",
          passed: repair.ok,
          detail: `${repair.attempts} attempt(s), ${repair.edits.length} edit(s)`,
        },
      ],
      policyNotes: repair.policyNotes,
    });
  }

  // Final advisory CI pass for reporting
  let ci: CiLoopResult | undefined;
  if (input.verifyCommands?.length) {
    ci = await runCiLoop({
      commands: input.verifyCommands,
      cwd: input.repoRoot,
      maxAttempts: 1,
      dryRun: input.dryRun,
      commenter,
      ciCheck: input.ciCheck,
    });
  }

  return {
    repair,
    ci,
    ok: repair.ok && (ci?.ok ?? true),
  };
}
