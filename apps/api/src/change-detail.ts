/**
 * Tenant-private body for GET /changes/:id. Catalog isolation (getChange +
 * provider visibility) stays in the route so auth-off catalog reads keep their
 * existing 404 order; this helper runs only after a non-empty tenant is bound.
 */
import {
  changeToApi,
  findingToApi,
  listFindingsForChange,
  listPrsForChange,
  loadChangeImpactCoverage,
  prToApi,
  type ApiChange,
  type AppDb,
} from "@mendpoint/db";

export function changeDetailBody(db: AppDb, tenantId: string, change: ApiChange) {
  const findings = listFindingsForChange(db, change.id, tenantId).map(findingToApi);
  const prs = listPrsForChange(db, change.id, tenantId).map(prToApi);
  return {
    ...changeToApi(change),
    diff: JSON.parse(change.diff_json),
    findings,
    prs,
    impactCoverage: loadChangeImpactCoverage(db, tenantId, change.id, {
      findingCount: findings.length,
      prs,
    }),
  };
}
