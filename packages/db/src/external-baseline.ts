/**
 * Declared external baseline references (Wave 3b).
 *
 * These are labeled, citation-backed reference points from OTHER systems. They
 * exist so a customer can read our own measured outcome metrics ALONGSIDE a
 * declared external reference, without us restating a third party's numbers as
 * our own measured fact and without any parity or superiority claim.
 *
 * Honesty rules encoded here:
 *  - Every entry carries an evidenceQuality label. Nothing here is
 *    independently reproduced by Mendpoint.
 *  - Every entry carries a comparability label because the external benchmark
 *    task distribution differs from Warden's API-migration candidate workload;
 *    the numbers are NOT one-to-one comparable to our accepted-candidate rate.
 *  - No field asserts Mendpoint parity with, or superiority over, any listed
 *    system. Consumers must render these as an external reference only.
 */

export type ExternalBaselineEvidenceQuality =
  /** Reported by the vendor; not independently audited or reproduced. */
  | "vendor_reported_unaudited"
  /** Published by an independent third party (leaderboard, paper). */
  | "third_party_published";

export type ExternalBaselineComparability =
  /** Different task distribution; treat only as a rough external anchor. */
  | "low"
  /** Related task distribution but still not identical to our workload. */
  | "moderate";

export type ExternalBaselineReferencePoint = Readonly<{
  id: string;
  /** Organization that produced the system being referenced. */
  source: string;
  /** External system the number describes. */
  system: string;
  /** Benchmark / dataset the number was measured on. */
  benchmark: string;
  /** Human-readable metric name. */
  metric: string;
  /** Reported value as a 0..1 rate. Never presented as a Mendpoint result. */
  value: number;
  unit: "rate";
  /** Date the value was reported / observed (ISO date). */
  asOf: string;
  evidenceQuality: ExternalBaselineEvidenceQuality;
  comparability: ExternalBaselineComparability;
  sourceUrl: string;
  /** Explicit caveat rendered next to the number. */
  note: string;
}>;

export type ExternalBaselineReference = Readonly<{
  /** Prominent, machine-readable disclaimer for any surface that renders this. */
  disclaimer: string;
  /** True only if Mendpoint has run a head-to-head against these systems. */
  headToHeadMeasured: boolean;
  references: readonly ExternalBaselineReferencePoint[];
}>;

const DISCLAIMER =
  "External reference points are declared by their sources and are not " +
  "independently reproduced by Mendpoint. They cover different task " +
  "distributions than Warden's API-migration candidates, so they are not a " +
  "like-for-like comparison and imply no parity or superiority claim. Our own " +
  "outcome metrics are measured only on our own workload.";

const REFERENCES: readonly ExternalBaselineReferencePoint[] = [
  Object.freeze({
    id: "devin-swebench-2024",
    source: "Cognition Labs",
    system: "Devin",
    benchmark: "SWE-bench (random 25% subset)",
    metric: "End-to-end issue resolution rate",
    value: 0.1386,
    unit: "rate",
    asOf: "2024-03-12",
    evidenceQuality: "vendor_reported_unaudited",
    comparability: "low",
    sourceUrl: "https://www.cognition.ai/blog/introducing-devin",
    note:
      "Vendor-reported on general GitHub issues, a different task distribution " +
      "than Warden's tenant-scoped API-migration candidates. Shown as an " +
      "external anchor only, not a Mendpoint measurement or a parity claim.",
  }),
];

const REFERENCE: ExternalBaselineReference = Object.freeze({
  disclaimer: DISCLAIMER,
  headToHeadMeasured: false,
  references: Object.freeze([...REFERENCES]),
});

/** Frozen, labeled external baseline references. Never a Mendpoint measurement. */
export function getExternalBaselineReference(): ExternalBaselineReference {
  return REFERENCE;
}
