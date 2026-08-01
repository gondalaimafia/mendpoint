export type CiHarnessEvidence = {
  name: string;
  passed: boolean;
  recall?: number;
  threshold?: number;
  detail?: string;
};

const MISSING_VERIFIER_EVIDENCE: CiHarnessEvidence = {
  name: "Verifier evidence",
  passed: false,
  detail: "No verifier evidence supplied",
};

/** Missing verifier output is a failed check, never an inferred pass. */
export function resolveCiHarnessEvidence(
  harness: CiHarnessEvidence[] | undefined,
): CiHarnessEvidence[] {
  return harness?.length ? harness : [{ ...MISSING_VERIFIER_EVIDENCE }];
}
