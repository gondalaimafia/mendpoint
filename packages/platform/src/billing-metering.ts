import { calculateMcuV1, type McuWork } from "./mcu.js";

/**
 * S0-B: server-computed MCU metering for real runs, behind the self-serve flag.
 *
 * The Wave C run path reserves a deterministic MCU *ceiling* at admission and, on
 * completion, settled that same reserved estimate. That estimate is a hold, not a
 * measurement. This module derives the *actual* MCU cost from the real work a
 * `pipeline.fanout` run performed and settles to that instead — never the client-
 * declared value and never a fabricated figure.
 *
 * Honesty rule (mirrors the agent-run meter's "null when unmeasured"): only the
 * work signals the run genuinely exposes are used. A completed `PipelineReport`
 * exposes the graph-scan / impact / edit-generation counts (surfaces, findings,
 * candidates, confirmed sites, generated edits). The fanout layer does NOT measure
 * retrieval bytes, model USD, or sandbox/verification vCPU/GiB minutes, so those
 * MCU dimensions are intentionally left absent rather than invented. When a
 * measured signal for those dimensions exists in a later layer it can be added
 * here; until then it is a documented gap, not a silent zero.
 */

/** Default-OFF flag gating all S0-B self-serve billing behavior. */
export const SELF_SERVE_BILLING_FLAG = "MENDPOINT_SELF_SERVE_BILLING" as const;

export function selfServeBillingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[SELF_SERVE_BILLING_FLAG] === "1";
}

/**
 * Real, run-exposed work signals for a completed `pipeline.fanout` run. Every field
 * is a genuine count the run produced; none is client-declared or fabricated.
 */
export type FanoutRunMeterSignals = Readonly<{
  /** Impactable surfaces the structural change normalizer produced (graph scan). */
  surfaces: number;
  /** Impact findings recorded across consumers (graph scan). */
  findings: number;
  /** Candidate sites the impact analysis traversed across consumers (graph scan). */
  candidates: number;
  /** Confirmed impact sites across consumers (graph scan). */
  confirmed: number;
  /** Generated/repaired edits across consumers (edit generation). */
  edits: number;
}>;

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Map the run's real work signals to an MCU work record. All exposed signals are
 * counts of graph/impact/edit objects the run scanned or produced, so they land on
 * the schedule's `graphObjects` dimension. Unmeasured dimensions stay absent.
 */
export function fanoutRunMcuWork(signals: FanoutRunMeterSignals): McuWork {
  const graphObjects =
    count(signals.surfaces) +
    count(signals.findings) +
    count(signals.candidates) +
    count(signals.confirmed) +
    count(signals.edits);
  return Object.freeze({ graphObjects });
}

/** Server-computed MCU micros for a completed fanout run, via `calculateMcuV1`. */
export function computeFanoutRunMcuMicros(signals: FanoutRunMeterSignals): number {
  return calculateMcuV1(fanoutRunMcuWork(signals)).totalMicros;
}

/**
 * Resolve the amount a completed fanout run settles against its reservation.
 *
 * - Flag OFF (default): settle to the reserved estimate — byte-for-byte identical
 *   to the Wave C completion path.
 * - Flag ON: settle to the server-computed MCU from real work, capped at the
 *   reservation so a settlement can never exceed the hold (the quota ceiling the
 *   admission reserved). The cap only ever lowers the figure; it never inflates it.
 */
export function resolveFanoutSettlementMcuMicros(input: {
  reservedMcuMicros: number;
  signals: FanoutRunMeterSignals;
  env?: NodeJS.ProcessEnv;
}): number {
  if (!selfServeBillingEnabled(input.env)) return input.reservedMcuMicros;
  const computed = computeFanoutRunMcuMicros(input.signals);
  return Math.min(input.reservedMcuMicros, computed);
}
