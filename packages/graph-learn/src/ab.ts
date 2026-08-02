/**
 * A/B lift measurement — tagged experiment arms only by default.
 * Significance via two-proportion z-test (not absolute 5pp heuristic).
 */
import type { GraphLearnDb } from "./store.js";
import { listNodesByKind, edgesFrom } from "./store.js";
import {
  graphNodeBelongsToTenant,
  type GraphTenantScope,
} from "./tenant-scope.js";

export type AbArm = {
  name: string;
  samples: number;
  success: number;
  successRate: number;
  /** Wilson score interval 95% */
  ci95: [number, number];
};

export type AbReport = {
  generatedAt: string;
  control: AbArm;
  treatment: AbArm;
  lift: number;
  liftPct: number;
  /** Two-proportion z-test p-value (approx) */
  pValue: number;
  zScore: number;
  significant: boolean;
  /** alpha for significance (default 0.05) */
  alpha: number;
  targetLift: number;
  meetsTarget: boolean;
  taggedOnly: boolean;
  untaggedSkipped: number;
  notes: string[];
};

const OUTCOME_KINDS = [
  "OUTCOME_MERGED",
  "OUTCOME_WAIVED",
  "OUTCOME_CLOSED",
  "OUTCOME_BROKE",
] as const;

function wilson(success: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = success / n;
  const den = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin =
    z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [
    Math.max(0, (center - margin) / den),
    Math.min(1, (center + margin) / den),
  ];
}

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
    ci95: wilson(success, samples),
  };
}

/** Normal CDF approx for two-sided p-value */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function twoPropZ(
  s1: number,
  n1: number,
  s2: number,
  n2: number,
): { z: number; p: number } {
  if (n1 < 1 || n2 < 1) return { z: 0, p: 1 };
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const p = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p2 - p1) / se;
  const pValue = Math.max(
    0,
    Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))),
  );
  return { z, p: pValue };
}

function normalizeArm(exp: string): "control" | "treatment" | "untagged" {
  const e = exp.toLowerCase();
  if (e === "treatment" || e === "b" || e === "learned") return "treatment";
  if (e === "control" || e === "a" || e === "baseline") return "control";
  return "untagged";
}

/**
 * Measure A/B lift.
 * @param opts.taggedOnly default true — untagged outcomes excluded (no id-hash split)
 * @param opts.includeUntaggedAsControl if true, untagged count as control
 */
export function measureAbLift(
  db: GraphLearnDb,
  opts?: {
    targetLift?: number;
    alpha?: number;
    taggedOnly?: boolean;
    includeUntaggedAsControl?: boolean;
  },
  scope?: GraphTenantScope,
): AbReport {
  const targetLift = opts?.targetLift ?? 0.1;
  const alpha = opts?.alpha ?? 0.05;
  const taggedOnly = opts?.taggedOnly !== false;
  const controlE: Array<{ kind: string }> = [];
  const treatmentE: Array<{ kind: string }> = [];
  let untaggedSkipped = 0;

  for (const c of listNodesByKind(db, "Consumer")) {
    if (scope && !graphNodeBelongsToTenant(c, scope)) continue;
    for (const kind of OUTCOME_KINDS) {
      for (const e of edgesFrom(db, c.id, [kind])) {
        const raw = String(
          (e.props as { experiment?: string } | undefined)?.experiment ?? "",
        );
        const arm = normalizeArm(raw);
        if (arm === "treatment") treatmentE.push(e);
        else if (arm === "control") controlE.push(e);
        else if (opts?.includeUntaggedAsControl) controlE.push(e);
        else if (!taggedOnly) {
          // legacy hash split only when explicitly disabled taggedOnly
          const h = e.id.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
          (h % 2 === 0 ? controlE : treatmentE).push(e);
        } else {
          untaggedSkipped++;
        }
      }
    }
  }

  const control = armFromEdges("control", controlE);
  const treatment = armFromEdges("treatment", treatmentE);
  const lift = treatment.successRate - control.successRate;
  const { z, p } = twoPropZ(
    control.success,
    control.samples,
    treatment.success,
    treatment.samples,
  );
  const notes: string[] = [];
  if (taggedOnly) {
    notes.push("Tagged-only mode: untagged outcomes excluded from lift.");
  }
  if (untaggedSkipped) {
    notes.push(`Skipped ${untaggedSkipped} untagged outcome edge(s).`);
  }
  if (control.samples + treatment.samples < 10) {
    notes.push("Low sample size — treat lift as directional.");
  }
  if (!control.samples || !treatment.samples) {
    notes.push(
      "One arm empty — tag PR body with [experiment:control|treatment] or pass experiment on feedback.",
    );
  }
  const significant =
    control.samples >= 5 &&
    treatment.samples >= 5 &&
    p < alpha;

  return {
    generatedAt: new Date().toISOString(),
    control,
    treatment,
    lift,
    liftPct: lift * 100,
    pValue: p,
    zScore: z,
    significant,
    alpha,
    targetLift,
    meetsTarget: lift >= targetLift && significant,
    taggedOnly,
    untaggedSkipped,
    notes,
  };
}

export function formatAbReport(r: AbReport): string {
  return [
    `### A/B lift`,
    `control: ${(r.control.successRate * 100).toFixed(1)}% (n=${r.control.samples}) CI95=[${(r.control.ci95[0] * 100).toFixed(1)},${(r.control.ci95[1] * 100).toFixed(1)}]`,
    `treatment: ${(r.treatment.successRate * 100).toFixed(1)}% (n=${r.treatment.samples}) CI95=[${(r.treatment.ci95[0] * 100).toFixed(1)},${(r.treatment.ci95[1] * 100).toFixed(1)}]`,
    `lift: ${r.liftPct.toFixed(1)}pp z=${r.zScore.toFixed(2)} p=${r.pValue.toFixed(4)} significant=${r.significant}`,
    `meetsTarget: ${r.meetsTarget} (lift≥${(r.targetLift * 100).toFixed(0)}pp and p<${r.alpha})`,
    ...r.notes.map((n) => `- ${n}`),
  ].join("\n");
}
