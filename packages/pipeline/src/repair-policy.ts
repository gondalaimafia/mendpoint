/**
 * Repair-edit policy filtering.
 *
 * Repair may produce edits the migration draft never touched. They must pass the
 * SAME policy gate as the draft edits — pathBlocked + minConfidenceForEdit — so a
 * repair edit can never be delivered past a denylist or confidence threshold that
 * would have rejected it as a draft edit. Previously the pipeline pushed repair
 * edits straight onto the decision's allowedEdits array, appending them AFTER
 * evaluatePolicy had already run and bypassing the filter entirely.
 */
import { evaluatePolicy, type PolicyConfig } from "@mendpoint/policy";
import type { ImpactFinding, MigrationDraft } from "@mendpoint/shared";

export type RepairEditCandidate = {
  filePath: string;
  original: string;
  updated: string;
};

export type FilteredRepairEdits = {
  /** Repair edits that survive the policy filter and may be delivered. */
  allowed: MigrationDraft["fileEdits"];
  /** Repair edit paths the policy rejected (denylist or confidence gate). */
  blocked: string[];
};

export function filterRepairEdits(args: {
  draft: MigrationDraft;
  findings: ImpactFinding[];
  policy: Partial<PolicyConfig>;
  edits: RepairEditCandidate[];
  /** Paths already carried by the draft decision; these are not re-filtered. */
  existingPaths: Iterable<string>;
}): FilteredRepairEdits {
  const existing = new Set(args.existingPaths);
  const candidates = args.edits
    .filter((re) => !existing.has(re.filePath))
    .map((re) => ({
      path: re.filePath,
      original: re.original,
      updated: re.updated,
    }));
  if (!candidates.length) return { allowed: [], blocked: [] };
  const decision = evaluatePolicy(
    { ...args.draft, fileEdits: candidates },
    args.findings,
    { policy: args.policy, risk: args.draft.risk },
  );
  return { allowed: decision.allowedEdits, blocked: decision.blockedFiles };
}
