/**
 * Operator-facing reporting for the open-draft body refresh (#730 follow-up).
 * Kept in its own side-effect-free module so the exact printed output can be
 * tested, apart from the command's DB and transport wiring.
 */
import type { RefreshOpenDraftBodiesResult, RefreshTenantResult } from "@mendpoint/pipeline";

/**
 * A tenant is worth printing when it has ANYTHING to report: affected drafts, or
 * any non-empty outcome list. A revoked installation or a 403 reading a PR fails
 * BEFORE the draft is counted as `affected` (#730), so gating on `affected` alone
 * hid exactly those failed URLs — the case this refresh reports on.
 */
export function tenantHasReport(t: RefreshTenantResult): boolean {
  return (
    t.affected > 0 ||
    t.failed.length > 0 ||
    t.blocked.length > 0 ||
    t.skippedForeignHead.length > 0 ||
    t.skippedHumanEdited.length > 0 ||
    t.skippedClosed.length > 0 ||
    t.skippedNoArtifact.length > 0
  );
}

export type RefreshLogger = (line: string) => void;

/**
 * Print the per-tenant and summary report through `log` (default `console.log`)
 * and return the total number of failed drafts. Pure over its logger so the
 * operator output is testable; the command owns the exit code separately.
 */
export function reportRefresh(
  result: RefreshOpenDraftBodiesResult,
  opts: Readonly<{ dryRun: boolean }>,
  log: RefreshLogger = (line) => console.log(line),
): number {
  const reportList = (label: string, urls: ReadonlyArray<string>): void => {
    if (urls.length === 0) return;
    log(`    ${label} (${urls.length}): ${urls.filter(Boolean).join(", ")}`);
  };

  log(
    opts.dryRun
      ? "[refresh:pr-body-identity] DRY RUN (reads only, no writes)"
      : "[refresh:pr-body-identity] APPLY",
  );
  for (const t of result.tenants) {
    if (!tenantHasReport(t)) continue;
    log(`  tenant=${t.tenantSlug} (${t.tenantId}) affected=${t.affected} updated=${t.updated}`);
    reportList("needs a human (foreign head)", t.skippedForeignHead);
    reportList("human-edited (left untouched)", t.skippedHumanEdited);
    reportList("closed/merged", t.skippedClosed);
    reportList("no write-ahead artifact", t.skippedNoArtifact);
    reportList("blocked by guard (still leaked)", t.blocked);
    reportList("failed", t.failed);
  }
  log(
    opts.dryRun
      ? `[refresh:pr-body-identity] total affected open drafts: ${result.totalAffected}`
      : `[refresh:pr-body-identity] total updated: ${result.totalUpdated} of ${result.totalAffected} affected`,
  );

  return result.tenants.reduce((sum, t) => sum + t.failed.length, 0);
}
