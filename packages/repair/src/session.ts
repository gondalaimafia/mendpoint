/**
 * Agentic repair session — the product loop.
 */
import { newId } from "@mendpoint/shared";
import { diagnoseFailureLog, diagnoseWorkingTree } from "./diagnose.js";
import { planRepairs, planRepairsWithLlm } from "./plan.js";
import { applyActions, listCodeFilesWithContent } from "./apply.js";
import type {
  AppliedEdit,
  FailureObservation,
  RepairPlan,
  RepairSessionInput,
  RepairSessionResult,
  VerifyResult,
} from "./types.js";
import { runVerificationCommand } from "./verify.js";

function runVerify(repoRoot: string, commands: string[], dryRun?: boolean): VerifyResult {
  if (dryRun) {
    return {
      ok: true,
      commands,
      output: "dry-run skip verify",
      failures: [],
    };
  }
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
  for (const cmd of commands) {
    const execution = runVerificationCommand(cmd, repoRoot);
    if (execution.ok) {
      outputs.push(`$ ${cmd}\n${execution.stdout}`);
    } else {
      const combined = `${execution.stdout}\n${execution.stderr}\n${execution.error ?? ""}`;
      outputs.push(`$ ${cmd}\n${combined}`);
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
  const lines = [
    "### Mendpoint agentic repair",
    "",
    `- **Status:** ${r.ok ? "✅ repaired" : "❌ needs human"}`,
    `- **Attempts:** ${r.attempts}/${r.maxAttempts}`,
    `- **Edits applied:** ${r.edits.length}`,
    "",
    "#### Plans",
    ...r.plans.map(
      (p) =>
        `- attempt ${p.attempt} (${p.strategy}): ${p.summary} — ${p.actions.length} action(s)`,
    ),
    "",
    "#### Files touched",
    ...(r.edits.length
      ? r.edits.map((e) => `- \`${e.filePath}\` — ${e.reason}`)
      : ["- _(none)_"]),
    "",
    "#### Policy",
    ...r.policyNotes.map((n) => `- ${n}`),
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
  const maxAttempts = input.maxAttempts ?? 3;
  const verifyCommands = input.verifyCommands ?? [];
  const plans: RepairPlan[] = [];
  const allEdits: AppliedEdit[] = [];
  const policyNotes = [
    "Auto-merge disabled",
    "Path denylist enforced",
    "Bounded repair attempts",
  ];

  let observations: FailureObservation[] = [];
  if (input.seedFailureLog) {
    observations = diagnoseFailureLog(input.seedFailureLog);
  }

  // Initial tree scan
  const files = listCodeFilesWithContent(input.repoRoot);
  observations = [
    ...observations,
    ...diagnoseWorkingTree(files, input.renameMap),
  ];

  // Initial verify if we have commands and no seed failures from tree
  let finalVerify = runVerify(input.repoRoot, verifyCommands, input.dryRun);
  if (!finalVerify.ok) {
    observations = [...observations, ...finalVerify.failures];
  } else if (!observations.length && verifyCommands.length) {
    // Already green
    const result: Omit<RepairSessionResult, "reportMarkdown"> = {
      sessionId,
      ok: true,
      attempts: 0,
      maxAttempts,
      plans: [],
      edits: [],
      finalVerify,
      policyNotes,
    };
    return { ...result, reportMarkdown: formatReport(result) };
  }

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    // Dedup observations
    const seen = new Set<string>();
    observations = observations.filter((o) => {
      const k = `${o.kind}:${o.filePath}:${o.symbol}:${o.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    let plan = planRepairs(observations, {
      attempt,
      renameMap: input.renameMap,
      strategy: "deterministic",
    });

    if (input.useLlm && plan.actions.length < 2) {
      const slices = files
        .filter((f) =>
          observations.some((o) => o.filePath && f.path.includes(o.filePath)),
        )
        .slice(0, 6)
        .map((f) => ({ filePath: f.path, content: f.content }));
      const llmPlan = await planRepairsWithLlm(observations, slices, { attempt });
      if (llmPlan?.actions.length) {
        plan = {
          ...llmPlan,
          strategy: "hybrid",
          actions: [...plan.actions, ...llmPlan.actions].slice(0, 30),
          summary: `${plan.summary}; ${llmPlan.summary}`,
        };
      }
    }

    plans.push(plan);

    if (!plan.actions.length) {
      policyNotes.push(`Attempt ${attempt}: no actions — stop`);
      break;
    }

    const edits = applyActions(plan.actions, {
      repoRoot: input.repoRoot,
      dryRun: input.dryRun,
      neverTouchPaths: input.neverTouchPaths,
    });
    allEdits.push(...edits);

    finalVerify = runVerify(input.repoRoot, verifyCommands, input.dryRun);
    if (finalVerify.ok) {
      // Re-scan tree for leftovers
      const still = diagnoseWorkingTree(
        listCodeFilesWithContent(input.repoRoot),
        input.renameMap,
      );
      if (!still.length || input.dryRun) {
        const result: Omit<RepairSessionResult, "reportMarkdown"> = {
          sessionId,
          ok: true,
          attempts: attempt,
          maxAttempts,
          plans,
          edits: allEdits,
          finalVerify,
          policyNotes,
        };
        return { ...result, reportMarkdown: formatReport(result) };
      }
      observations = still;
    } else {
      observations = [
        ...finalVerify.failures,
        ...diagnoseWorkingTree(listCodeFilesWithContent(input.repoRoot), input.renameMap),
      ];
    }
  }

  const result: Omit<RepairSessionResult, "reportMarkdown"> = {
    sessionId,
    ok: false,
    attempts: attempt,
    maxAttempts,
    plans,
    edits: allEdits,
    finalVerify,
    policyNotes: [
      ...policyNotes,
      "Repair exhausted max attempts — escalate to human",
    ],
  };
  return { ...result, reportMarkdown: formatReport(result) };
}
