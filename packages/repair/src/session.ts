/**
 * Agentic repair session with bounded, progress-aware mutation and verification.
 */
import { createHash } from "node:crypto";
import { newId } from "@mendpoint/shared";
import { diagnoseFailureLog, diagnoseWorkingTree } from "./diagnose.js";
import { planRepairs, planRepairsWithLlm } from "./plan.js";
import {
  applyActions,
  listCodeFilesWithContent,
  RepairPolicyError,
  rollbackPristineFiles,
  type PristineFile,
} from "./apply.js";
import type {
  AppliedEdit,
  FailureObservation,
  RepairAction,
  RepairPlan,
  RepairSessionInput,
  RepairSessionResult,
  VerifyResult,
} from "./types.js";
import {
  discoverVerificationCommands,
  runVerificationCommand,
  verifierProtectedPaths,
} from "./verify.js";

const HARD_MAX_ATTEMPTS = 5;
const HARD_MAX_ACTIONS_PER_ATTEMPT = 30;
const HARD_MAX_FILES_CHANGED = 50;
const HARD_MAX_TOTAL_EDITS = 100;

function boundedInteger(value: number | undefined, fallback: number, hardMax: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value!), hardMax));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedObservations(observations: FailureObservation[]) {
  return observations
    .map((observation) => ({
      kind: observation.kind,
      filePath: observation.filePath ?? "",
      line: observation.line ?? 0,
      column: observation.column ?? 0,
      symbol: observation.symbol ?? "",
      message: observation.message.trim(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function failureFingerprint(observations: FailureObservation[]): string {
  return fingerprint(normalizedObservations(observations));
}

function actionFingerprint(actions: RepairAction[]): string {
  return fingerprint(
    actions.map((action) => {
      if (action.type === "replace_in_file") {
        return {
          type: action.type,
          filePath: action.filePath.replace(/\\/g, "/"),
          from: action.from,
          to: action.to,
          global: action.global ?? true,
        };
      }
      if (action.type === "write_file") {
        return {
          type: action.type,
          filePath: action.filePath.replace(/\\/g, "/"),
          contentHash: fingerprint(action.content),
        };
      }
      if (action.type === "patch_line") {
        return {
          type: action.type,
          filePath: action.filePath.replace(/\\/g, "/"),
          line: action.line,
          newLine: action.newLine,
        };
      }
      return {
        type: action.type,
        filePath: action.filePath.replace(/\\/g, "/"),
      };
    }),
  );
}

function dedupeObservations(observations: FailureObservation[]): FailureObservation[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = JSON.stringify({
      kind: observation.kind,
      filePath: observation.filePath ?? "",
      line: observation.line ?? 0,
      column: observation.column ?? 0,
      symbol: observation.symbol ?? "",
      message: observation.message,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runVerify(repoRoot: string, commands: string[]): Promise<VerifyResult> {
  if (!commands.length) {
    return {
      ok: false,
      commands,
      output: "verification failed closed: no approved command profile configured",
      failures: [
        {
          kind: "unknown",
          message: "No approved verification command profile is configured",
        },
      ],
    };
  }
  const outputs: string[] = [];
  for (const command of commands) {
    const execution = await runVerificationCommand(command, repoRoot);
    if (execution.ok) {
      outputs.push(`$ ${command}\n${execution.stdout}`);
    } else {
      const combined = `${execution.stdout}\n${execution.stderr}\n${execution.error ?? ""}`;
      outputs.push(`$ ${command}\n${combined}`);
      return {
        ok: false,
        commands,
        output: outputs.join("\n---\n").slice(0, 12_000),
        failures: diagnoseFailureLog(combined),
      };
    }
  }
  return {
    ok: true,
    commands,
    output: outputs.join("\n---\n").slice(0, 12_000),
    failures: [],
  };
}

function formatReport(r: Omit<RepairSessionResult, "reportMarkdown">): string {
  const status = r.simulated ? "SIMULATED" : r.ok ? "VERIFIED" : "NEEDS HUMAN";
  const lines = [
    "### Mendpoint agentic repair",
    "",
    `- **Status:** ${status}`,
    `- **Stop reason:** ${r.stopReason}`,
    `- **Attempts:** ${r.attempts}/${r.maxAttempts}`,
    `- **Edits retained:** ${r.edits.length}`,
    "",
    "#### Plans",
    ...r.plans.map(
      (plan) =>
        `- attempt ${plan.attempt} (${plan.strategy}): ${plan.summary} — ${plan.actions.length} action(s)`,
    ),
    "",
    "#### Files touched",
    ...(r.edits.length
      ? r.edits.map((edit) => `- \`${edit.filePath}\` — ${edit.reason}`)
      : ["- _(none retained)_"]),
    "",
    "#### Policy",
    ...r.policyNotes.map((note) => `- ${note}`),
    "",
    "_Agentic repair never auto-merges. Human review required._",
  ];
  return lines.join("\n");
}

/**
 * Run a full repair session against a local repo checkout.
 */
export async function runRepairSession(
  input: RepairSessionInput,
): Promise<RepairSessionResult> {
  const sessionId = input.sessionId ?? newId();
  const maxAttempts = boundedInteger(input.maxAttempts, 3, HARD_MAX_ATTEMPTS);
  const maxActionsPerAttempt = boundedInteger(
    input.maxActionsPerAttempt,
    20,
    HARD_MAX_ACTIONS_PER_ATTEMPT,
  );
  const maxFilesChanged = boundedInteger(
    input.maxFilesChanged,
    20,
    HARD_MAX_FILES_CHANGED,
  );
  const maxTotalEdits = boundedInteger(
    input.maxTotalEdits,
    40,
    HARD_MAX_TOTAL_EDITS,
  );
  const verifyCommands =
    input.verifyCommands?.length
      ? input.verifyCommands
      : discoverVerificationCommands(input.repoRoot);
  const protectedVerifierPaths = [
    ...new Set(
      verifyCommands.flatMap((command) =>
        verifierProtectedPaths(command, input.repoRoot),
      ),
    ),
  ];
  const neverTouchPaths = [
    ...(input.neverTouchPaths ?? []),
    ...protectedVerifierPaths,
  ];
  const repairFiles = () =>
    listCodeFilesWithContent(input.repoRoot).filter(
      (file) => !protectedVerifierPaths.includes(file.path),
    );
  const plans: RepairPlan[] = [];
  const retainedEdits = new Map<string, AppliedEdit>();
  const pristineFiles = new Map<string, PristineFile>();
  const failureFingerprints: string[] = [];
  const actionFingerprints: string[] = [];
  const seenFailures = new Set<string>();
  const seenActions = new Set<string>();
  let totalAppliedEdits = 0;
  let finalVerify: VerifyResult | undefined;
  let attempt = 0;
  const policyNotes = [
    "Auto-merge disabled",
    "Canonical repository containment and symbolic-link rejection enforced",
    `Repair budgets: ${maxAttempts} attempts, ${maxActionsPerAttempt} actions per attempt, ${maxFilesChanged} files, ${maxTotalEdits} edits`,
    input.verifyCommands?.length
      ? "Operator verification profile selected"
      : verifyCommands.length
        ? "Repository verification profile discovered"
        : "No approved verification profile discovered",
    ...(protectedVerifierPaths.length
      ? [`Protected verifier files: ${protectedVerifierPaths.join(", ")}`]
      : []),
  ];

  const makeResult = (
    ok: boolean,
    simulated: boolean,
    stopReason: RepairSessionResult["stopReason"],
    edits: AppliedEdit[],
  ): RepairSessionResult => {
    const result: Omit<RepairSessionResult, "reportMarkdown"> = {
      sessionId,
      ok,
      simulated,
      stopReason,
      attempts: attempt,
      maxAttempts,
      plans,
      edits,
      failureFingerprints,
      actionFingerprints,
      finalVerify,
      policyNotes,
    };
    return { ...result, reportMarkdown: formatReport(result) };
  };

  const fail = (
    stopReason: Exclude<
      RepairSessionResult["stopReason"],
      "verified" | "already_green" | "simulated"
    >,
    note: string,
  ) => {
    policyNotes.push(note);
    rollbackPristineFiles(input.repoRoot, pristineFiles);
    return makeResult(false, false, stopReason, []);
  };
  const leaseActive = () => input.shouldContinue?.() !== false;

  try {
    let observations: FailureObservation[] = [];
    if (input.seedFailureLog) {
      observations = diagnoseFailureLog(input.seedFailureLog);
    }
    observations = dedupeObservations([
      ...observations,
      ...diagnoseWorkingTree(
        repairFiles(),
        input.renameMap,
      ),
    ]);

    if (input.dryRun) {
      attempt = observations.length ? 1 : 0;
      finalVerify = {
        ok: false,
        commands: verifyCommands,
        output: "simulation only: changes were not written and verification was not executed",
        failures: observations,
      };
      if (observations.length) {
        const initialFingerprint = failureFingerprint(observations);
        failureFingerprints.push(initialFingerprint);
        let plan = planRepairs(observations, {
          attempt,
          renameMap: input.renameMap,
          strategy: "deterministic",
        });
        if (input.useLlm && plan.actions.length < 2) {
          const currentFiles = repairFiles();
          const slices = currentFiles
            .filter((file) =>
              observations.some(
                (observation) =>
                  observation.filePath && file.path.includes(observation.filePath),
              ),
            )
            .slice(0, 6)
            .map((file) => ({ filePath: file.path, content: file.content }));
          const llmPlan = await planRepairsWithLlm(observations, slices, { attempt });
          if (llmPlan?.actions.length) {
            plan = {
              ...llmPlan,
              strategy: "hybrid",
              actions: [...plan.actions, ...llmPlan.actions].slice(
                0,
                maxActionsPerAttempt,
              ),
              summary: `${plan.summary}; ${llmPlan.summary}`,
            };
          }
        }
        plan = { ...plan, actions: plan.actions.slice(0, maxActionsPerAttempt) };
        plans.push(plan);
        if (plan.actions.length) {
          actionFingerprints.push(actionFingerprint(plan.actions));
          const edits = applyActions(plan.actions, {
            repoRoot: input.repoRoot,
            dryRun: true,
            neverTouchPaths,
            maxActions: maxActionsPerAttempt,
            maxFilesChanged,
            pristineFiles,
          });
          for (const edit of edits) retainedEdits.set(edit.filePath, edit);
        }
      }
      policyNotes.push("Simulation cannot claim a verified repair");
      return makeResult(false, true, "simulated", [...retainedEdits.values()]);
    }

    if (!leaseActive()) return fail("lease_lost", "Worker lease was lost before verification");
    finalVerify = await runVerify(input.repoRoot, verifyCommands);
    if (!leaseActive()) return fail("lease_lost", "Worker lease was lost during verification");
    if (!finalVerify.ok) {
      observations = dedupeObservations([...observations, ...finalVerify.failures]);
    } else if (!observations.length) {
      return makeResult(true, false, "already_green", []);
    }

    while (attempt < maxAttempts) {
      if (!leaseActive()) return fail("lease_lost", "Worker lease was lost before repair");
      attempt++;
      observations = dedupeObservations(observations);
      const currentFailureFingerprint = failureFingerprint(observations);
      failureFingerprints.push(currentFailureFingerprint);
      seenFailures.add(currentFailureFingerprint);

      let plan = planRepairs(observations, {
        attempt,
        renameMap: input.renameMap,
        strategy: "deterministic",
      });

      if (input.useLlm && plan.actions.length < 2) {
        // Refresh every attempt so proposals never use pre-edit source slices.
        const currentFiles = repairFiles();
        const slices = currentFiles
          .filter((file) =>
            observations.some(
              (observation) =>
                observation.filePath && file.path.includes(observation.filePath),
            ),
          )
          .slice(0, 6)
          .map((file) => ({ filePath: file.path, content: file.content }));
        const llmPlan = await planRepairsWithLlm(observations, slices, { attempt });
        if (!leaseActive()) return fail("lease_lost", "Worker lease was lost during planning");
        if (llmPlan?.actions.length) {
          plan = {
            ...llmPlan,
            strategy: "hybrid",
            actions: [...plan.actions, ...llmPlan.actions].slice(
              0,
              maxActionsPerAttempt,
            ),
            summary: `${plan.summary}; ${llmPlan.summary}`,
          };
        }
      }

      if (!input.allowBroadSearch) {
        plan = {
          ...plan,
          actions: plan.actions.filter(
            (action) => action.type !== "replace_in_file" || action.filePath !== "*",
          ),
        };
      }
      plan = { ...plan, actions: plan.actions.slice(0, maxActionsPerAttempt) };
      plans.push(plan);

      if (!plan.actions.length) {
        return fail("no_actions", `Attempt ${attempt}: no grounded actions`);
      }

      const currentActionFingerprint = actionFingerprint(plan.actions);
      actionFingerprints.push(currentActionFingerprint);
      if (seenActions.has(currentActionFingerprint)) {
        return fail(
          "repeated_actions",
          `Attempt ${attempt}: repeated action fingerprint`,
        );
      }
      seenActions.add(currentActionFingerprint);

      const edits = applyActions(plan.actions, {
        repoRoot: input.repoRoot,
        neverTouchPaths,
        maxActions: maxActionsPerAttempt,
        maxFilesChanged,
        pristineFiles,
      });
      if (!edits.length) {
        return fail("no_edits", `Attempt ${attempt}: actions changed no bytes`);
      }
      totalAppliedEdits += edits.length;
      if (totalAppliedEdits > maxTotalEdits) {
        return fail(
          "policy_violation",
          `Repair edit budget exceeded: ${totalAppliedEdits}/${maxTotalEdits}`,
        );
      }
      for (const edit of edits) retainedEdits.set(edit.filePath, edit);

      if (!leaseActive()) return fail("lease_lost", "Worker lease was lost after mutation");
      finalVerify = await runVerify(input.repoRoot, verifyCommands);
      if (!leaseActive()) return fail("lease_lost", "Worker lease was lost during verification");
      const remaining = diagnoseWorkingTree(
        repairFiles(),
        input.renameMap,
      );
      if (finalVerify.ok && !remaining.length) {
        return makeResult(true, false, "verified", [...retainedEdits.values()]);
      }

      observations = dedupeObservations([
        ...finalVerify.failures,
        ...remaining,
      ]);
      const nextFailureFingerprint = failureFingerprint(observations);
      if (seenFailures.has(nextFailureFingerprint)) {
        failureFingerprints.push(nextFailureFingerprint);
        return fail(
          "repeated_failure",
          `Attempt ${attempt}: verification made no observable progress`,
        );
      }
    }

    return fail(
      "max_attempts",
      "Repair exhausted its bounded attempts and requires human review",
    );
  } catch (error) {
    rollbackPristineFiles(input.repoRoot, pristineFiles);
    if (error instanceof RepairPolicyError) {
      policyNotes.push(error.message);
      return makeResult(false, false, "policy_violation", []);
    }
    throw error;
  }
}
