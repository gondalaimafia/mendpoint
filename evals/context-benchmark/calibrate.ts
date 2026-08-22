/**
 * CALIBRATION PROBE for the context benchmark's candidate scenarios.
 *
 *   MENDPOINT_LIVE_APPROVED_HOST=<host> npx tsx evals/context-benchmark/calibrate.ts
 *
 * This is NOT part of the graded cohort and defines NO sealed truth the grader
 * reads. It exists to answer the one empirical question the redesign turns on:
 * for a CANDIDATE arbitrary convention, how often does the real model, given ONLY
 * the immediate context (the stateless prompt), pick the option the organization
 * actually resolved on? If it picks it almost always, the distinguishing fact is
 * NOT arbitrary (a model reaches it from its priors) and the candidate is
 * discarded; if it lands near chance, the candidate discriminates and is worth
 * shipping. It also checks that the PERSISTENT prompt (the convention rendered by
 * the real compiler) is followed, so the persistent arm is not itself guessing.
 *
 * It reuses the EXACT real prompt path: each candidate is a one-hazard scenario
 * whose convention lives in the persistent bucket, so `planLiveCalls` renders the
 * stateless prompt with no governing context and the persistent prompt with the
 * compiler-rendered convention — byte-identical to what the graded live arm would
 * send. Only the number of repetitions differs (N per arm per candidate).
 *
 * Safety: the same host pin, approved model, and API-key handling as the live
 * arm; a hard USD cap is enforced before any call; the API key is never printed.
 * Every prompt is synthetic (tenant tenant-northwind), exactly as the live arm.
 */
import { computeModelCostUsd } from "@mendpoint/agent";
import {
  ARM_IDS,
  type ArmId,
  type BenchmarkScenario,
} from "./context-benchmark.js";
import {
  hazardMessages,
  inheritedContextPromptBody,
  openAiCompatibleModelCall,
  parseModelChoice,
  resolveLiveContextArmConfig,
  type LiveModelCall,
} from "./live-arm.js";

const TENANT = "tenant-northwind";

/**
 * A candidate arbitrary convention. `optionA`/`optionB` must be roughly equally
 * defensible on general engineering grounds; `resolved` is the option the
 * (fictional) organization actually chose, picked by a preference-independent
 * story rule and NOT to anti-correlate with the model. Calibration then measures
 * whether the stateless model can recover `resolved`.
 */
interface Candidate {
  readonly id: string;
  readonly subject: string;
  readonly optionA: string;
  readonly optionB: string;
  readonly resolved: string;
  readonly note: string;
}

/**
 * The candidate set, committed before calibration. Each is a genuine, arbitrary
 * infrastructure/format convention where both options are real choices some
 * organizations make. `resolved` is fixed by a plausible org story, not tuned to
 * the model. Direction is deliberately mixed across the alphabetical order of the
 * options so there is no systematic "always pick the second option" bias.
 */
const CANDIDATES: readonly Candidate[] = [
  { id: "cand-timestamp", subject: "timestamp-storage-format", optionA: "epoch-millis-int", optionB: "iso-8601-text", resolved: "iso-8601-text", note: "both common; ISO text vs epoch integer" },
  { id: "cand-id", subject: "primary-id-format", optionA: "ulid", optionB: "uuid-v7", resolved: "ulid", note: "both modern sortable ids" },
  { id: "cand-config", subject: "service-config-format", optionA: "toml", optionB: "yaml", resolved: "toml", note: "both fine for service config" },
  { id: "cand-jsoncase", subject: "json-field-naming", optionA: "camelCase", optionB: "snake_case", resolved: "snake_case", note: "arbitrary API field casing" },
  { id: "cand-region", subject: "default-cloud-region", optionA: "eu-west-1", optionB: "us-east-1", resolved: "eu-west-1", note: "arbitrary default region" },
  { id: "cand-enum", subject: "enum-column-storage", optionA: "int-code", optionB: "string-label", resolved: "string-label", note: "store enums as int codes or string labels" },
  { id: "cand-softdelete", subject: "soft-delete-marker", optionA: "deleted-at-timestamp", optionB: "is-deleted-flag", resolved: "deleted-at-timestamp", note: "timestamp column vs boolean flag" },
  { id: "cand-apiversion", subject: "api-version-placement", optionA: "accept-header", optionB: "url-path", resolved: "url-path", note: "header vs url path versioning" },
  { id: "cand-uuidstore", subject: "uuid-db-storage", optionA: "binary-16", optionB: "text-36", resolved: "text-36", note: "store uuids as binary(16) or text(36)" },
];

/** Number of repetitions per (candidate, arm). The model is a reasoning model at
 * temperature 0 and is not guaranteed deterministic; repetitions give a rate. */
const REPS = Number(process.env.CALIBRATE_REPS ?? "8");

/** A hard local cap for the calibration probe (kept well under the $5 ceiling). */
const CALIBRATE_MAX_USD = Number(process.env.CALIBRATE_MAX_USD ?? "1.0");

/** Build a one-hazard scenario whose convention lives in the persistent bucket. */
function candidateScenario(c: Candidate): BenchmarkScenario {
  const options = [c.optionA, c.optionB];
  return {
    scenarioId: c.id,
    tenantId: TENANT,
    description: `Calibration probe for ${c.subject}`,
    tasks: [
      {
        taskId: `${c.id}-task`,
        stage: 1,
        instructionTokens: 200,
        hazards: [
          {
            hazardId: `${c.id}-h`,
            resolutionKey: c.subject,
            options,
            naiveDefault: c.optionA === c.resolved ? c.optionB : c.optionA,
            consistencyGroup: "",
          },
        ],
        context: [
          {
            itemId: `${c.id}-mem`,
            resolutionKey: c.subject,
            recommends: c.resolved,
            layer: "confirmed_org_memory",
            bucket: "persistent",
            status: "active",
            tokens: 60,
          },
        ],
      },
    ],
  };
}

interface ArmTally {
  readonly reps: number;
  resolvedPicks: number;
  otherPicks: number;
  invalid: number;
}

function fmtRate(picks: number, reps: number): string {
  return reps === 0 ? "n/a" : (picks / reps).toFixed(3);
}

async function main(): Promise<void> {
  const config = resolveLiveContextArmConfig(process.env);
  if (config.status !== "ready") {
    console.log(`CALIBRATION: not run — ${config.reason}`);
    return;
  }

  const call: LiveModelCall = openAiCompatibleModelCall(process.env, config);

  // Pre-flight worst-case spend estimate for the whole probe, refused if over cap.
  const totalCalls = CANDIDATES.length * ARM_IDS.length * REPS;
  const worstPerCall = computeModelCostUsd(config.approved.model, 2048, config.maxOutputTokens);
  if (worstPerCall === null) {
    console.log(`CALIBRATION: not run — model ${config.approved.model} is unpriced`);
    return;
  }
  const worstTotal = worstPerCall * totalCalls;
  console.log(
    `CALIBRATION: ${CANDIDATES.length} candidates x ${ARM_IDS.length} arms x ${REPS} reps = ${totalCalls} calls; ` +
      `worst-case spend $${worstTotal.toFixed(4)} against local cap $${CALIBRATE_MAX_USD.toFixed(2)} ` +
      `(model ${config.approved.model} @ ${config.approved.host}; synthetic tenant ${TENANT}).`,
  );
  if (worstTotal > CALIBRATE_MAX_USD) {
    console.log("CALIBRATION: refused — worst-case exceeds local cap.");
    return;
  }

  let spentUsd = 0;
  const rows: string[] = [];
  rows.push("candidate\tsubject\tresolved\tstateless_P(resolved)\tpersistent_P(resolved)\tstateless_invalid\tpersistent_invalid");

  for (const c of CANDIDATES) {
    const scenario = candidateScenario(c);
    const task = scenario.tasks[0]!;
    const hazard = task.hazards[0]!;
    const tallies: Record<ArmId, ArmTally> = {
      stateless: { reps: REPS, resolvedPicks: 0, otherPicks: 0, invalid: 0 },
      persistent: { reps: REPS, resolvedPicks: 0, otherPicks: 0, invalid: 0 },
    };

    for (const arm of ARM_IDS) {
      const promptBody = inheritedContextPromptBody(scenario, task, arm);
      const messages = hazardMessages(promptBody, hazard);
      for (let i = 0; i < REPS; i++) {
        if (spentUsd + worstPerCall > CALIBRATE_MAX_USD) {
          console.log("CALIBRATION: stopping early — local cap reached.");
          break;
        }
        const result = await call({ messages, maxOutputTokens: config.maxOutputTokens });
        if (!result.ok) {
          console.log(`  ${c.id} ${arm} rep ${i}: delivery failed (${result.reason})`);
          tallies[arm].invalid += 1;
          continue;
        }
        if (typeof result.costUsd === "number" && Number.isFinite(result.costUsd)) {
          spentUsd += result.costUsd;
        } else {
          spentUsd += worstPerCall;
        }
        const choice = parseModelChoice(result.content, hazard.options);
        if (choice === c.resolved) tallies[arm].resolvedPicks += 1;
        else if (choice === c.optionA || choice === c.optionB) tallies[arm].otherPicks += 1;
        else tallies[arm].invalid += 1;
      }
    }

    rows.push(
      [
        c.id,
        c.subject,
        c.resolved,
        fmtRate(tallies.stateless.resolvedPicks, tallies.stateless.reps),
        fmtRate(tallies.persistent.resolvedPicks, tallies.persistent.reps),
        String(tallies.stateless.invalid),
        String(tallies.persistent.invalid),
      ].join("\t"),
    );
    console.log(
      `  ${c.id} (${c.subject}) resolved=${c.resolved}: ` +
        `stateless P(resolved)=${fmtRate(tallies.stateless.resolvedPicks, tallies.stateless.reps)} ` +
        `persistent P(resolved)=${fmtRate(tallies.persistent.resolvedPicks, tallies.persistent.reps)} ` +
        `[running spend $${spentUsd.toFixed(4)}]`,
    );
  }

  console.log("\n=== CALIBRATION TABLE ===");
  for (const r of rows) console.log(r);
  console.log(`\nCALIBRATION ACTUAL SPEND=$${spentUsd.toFixed(4)}`);
}

void main();
