/**
 * A/B lift measurement — compare outcome rates with/without learned signals.
 * Uses outcome edges + optional experiment tags in edge props.
 */
import type { GraphLearnDb } from "./store.js";
import { listNodesByKind, edgesFrom } from "./store.js";

export type AbArm = {
  name: string;
  samples: number;
  success: number;
  successRate: number;
};

export type AbReport = {
  generatedAt: string;
  control: AbArm;
  treatment: AbArm;
  lift: number;
  liftPct: number;
  significant: boolean;
  targetLift: number;
  meetsTarget: boolean;
  notes: string[];
};

const OUTCOME_KINDS = [
  "OUTCOME_MERGED",
  "OUTCOME_WAIVED",
  "OUTCOME_CLOSED",
  "OUTCOME_BROKE",
] as const;

function armFromEdges(
  name: string,
  edges: Array<{ kind: string }>,
): AbArm {
  let success = 0;
  let fail = 0;
  for (const e of edges) {
    if (e.kind === "OUTCOME_MERGED" || e.kind === "OUTCOME_WAIVED") success++;
    else fail++;
  }
  const samples = success + fail;
  return {
    name,
    samples,
    success,
    successRate: samples ? success / samples : 0,
  };
}

/**
 * Partition outcomes by props.experiment = "treatment" | "control" (default control).
 * If no experiment tags, treatment = all with pattern success context, control = random half.
 */
export function measureAbLift(
  db: GraphLearnDb,
  opts?: { targetLift?: number },
): AbReport {
  const targetLift = opts?.targetLift ?? 0.1;
  const controlE: Array<{ kind: string }> = [];
  const treatmentE: Array<{ kind: string }> = [];

  for (const c of listNodesByKind(db, "Consumer")) {
    for (const kind of OUTCOME_KINDS) {
      for (const e of edgesFrom(db, c.id, [kind])) {
        const exp = String(
          (e.props as { experiment?: string } | undefined)?.experiment ?? "",
        ).toLowerCase();
        if (exp === "treatment" || exp === "b" || exp === "learned") {
          treatmentE.push(e);
        } else if (exp === "control" || exp === "a" || exp === "baseline") {
          controlE.push(e);
        } else {
          // untagged: alternate by edge id hash
          const h = e.id.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
          (h % 2 === 0 ? controlE : treatmentE).push(e);
        }
      }
    }
  }

  const control = armFromEdges("control", controlE);
  const treatment = armFromEdges("treatment", treatmentE);
  const lift = treatment.successRate - control.successRate;
  const notes: string[] = [];
  if (control.samples + treatment.samples < 10) {
    notes.push("Low sample size — lift is directional only.");
  }
  if (!control.samples || !treatment.samples) {
    notes.push("One arm empty — tag outcomes with props.experiment=control|treatment.");
  }
  const significant =
    control.samples >= 5 &&
    treatment.samples >= 5 &&
    Math.abs(lift) >= 0.05;
  return {
    generatedAt: new Date().toISOString(),
    control,
    treatment,
    lift,
    liftPct: lift * 100,
    significant,
    targetLift,
    meetsTarget: lift >= targetLift,
    notes,
  };
}

export function formatAbReport(r: AbReport): string {
  return [
    `### A/B lift`,
    `control: ${(r.control.successRate * 100).toFixed(1)}% (n=${r.control.samples})`,
    `treatment: ${(r.treatment.successRate * 100).toFixed(1)}% (n=${r.treatment.samples})`,
    `lift: ${r.liftPct.toFixed(1)}pp (target ${(r.targetLift * 100).toFixed(0)}pp) meets=${r.meetsTarget}`,
    ...r.notes.map((n) => `- ${n}`),
  ].join("\n");
}
