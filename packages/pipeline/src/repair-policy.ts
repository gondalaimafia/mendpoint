import { evaluatePolicy, type PolicyConfig } from "@mendpoint/policy";
import type { ImpactFinding, MigrationDraft } from "@mendpoint/shared";

export type RepairEditCandidate = Readonly<{
  filePath: string;
  original: string;
  updated: string;
}>;

export type FilteredRepairEdits = Readonly<{
  allowed: MigrationDraft["fileEdits"];
  blockedPaths: string[];
  rejectedPaths: string[];
  fullyAuthorized: boolean;
}>;

/**
 * Apply the original migration policy to paths introduced by repair.
 * Verification does not authorize a path that the policy decision rejected.
 */
export function filterRepairEdits(input: Readonly<{
  draft: MigrationDraft;
  findings: ImpactFinding[];
  policy: Partial<PolicyConfig>;
  edits: RepairEditCandidate[];
  existingPaths: Iterable<string>;
}>): FilteredRepairEdits {
  const existing = new Set(input.existingPaths);
  const candidates = input.edits
    .filter((edit) => !existing.has(edit.filePath))
    .map((edit) => ({
      path: edit.filePath,
      original: edit.original,
      updated: edit.updated,
    }));

  if (candidates.length === 0) {
    return {
      allowed: [],
      blockedPaths: [],
      rejectedPaths: [],
      fullyAuthorized: true,
    };
  }

  const decision = evaluatePolicy(
    { ...input.draft, fileEdits: candidates },
    input.findings,
    { policy: input.policy, risk: input.draft.risk },
  );
  const admitted = new Set(decision.allowedEdits.map((edit) => edit.path));
  const blocked = new Set(decision.blockedFiles);

  const rejectedPaths = candidates
    .map((edit) => edit.path)
    .filter((path) => !admitted.has(path) && !blocked.has(path));

  return {
    allowed: decision.allowedEdits,
    blockedPaths: [...blocked],
    rejectedPaths,
    fullyAuthorized: blocked.size === 0 && rejectedPaths.length === 0,
  };
}
