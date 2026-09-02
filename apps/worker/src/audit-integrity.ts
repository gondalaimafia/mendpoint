/**
 * Periodic tamper-evident audit-chain verification.
 *
 * The audit log (`audit_events`) is hash-chained per tenant: each row commits to
 * the previous row's hash, so any mutation, deletion, or reordering breaks the
 * chain. `verifyAuditIntegrity` recomputes the chain for one tenant; nothing in
 * the running system ever calls it, so a broken chain would go unnoticed.
 *
 * This walks every tenant and, on the first broken chain, emits a CRITICAL alert
 * and logs loudly. A broken audit chain is a security event, not a warning to
 * swallow — but a maintenance sweep must not crash the worker, so detection is
 * surfaced through the alert channel rather than by throwing.
 */
import {
  listTenants,
  verifyAuditGovernanceIntegrity,
  verifyAuditIntegrity,
  type AppDb,
} from "@mendpoint/db";
import { emitAlert } from "@mendpoint/platform";

export type AuditIntegrityBreak = {
  tenantId: string;
  error: string;
  checked: number;
  /**
   * Which chains were actually recomputed for this tenant. Both are always
   * verified: "not looked at" must never be reported as a clean chain.
   */
  sourceChainOk: boolean;
  governanceChainOk: boolean;
};

export type AuditIntegritySummary = {
  ok: boolean;
  tenantsChecked: number;
  broken: AuditIntegrityBreak[];
};

/**
 * Verify the hash-chained audit log for every tenant. Returns a summary and,
 * for each broken chain, emits a critical alert (source `audit-integrity`) and
 * logs to stderr. Never throws for a broken chain — that is reported, not raised.
 */
export function checkAuditIntegrityForAllTenants(db: AppDb): AuditIntegritySummary {
  const tenants = listTenants(db);
  const broken: AuditIntegrityBreak[] = [];
  for (const tenant of tenants) {
    // Both chains are verified unconditionally. Skipping the governance sweep
    // when the source chain is already broken would report the governance
    // chain as intact on the strength of never having read it.
    const result = verifyAuditIntegrity(db, tenant.id);
    const governance = verifyAuditGovernanceIntegrity(db, tenant.id);
    if (!result.ok || !governance.ok) {
      broken.push({
        tenantId: tenant.id,
        error: result.error ?? governance.error ?? "audit_chain_unknown",
        checked: result.checked + governance.checked,
        sourceChainOk: result.ok,
        governanceChainOk: governance.ok,
      });
    }
  }
  for (const failure of broken) {
    emitAlert({
      severity: "critical",
      source: "audit-integrity",
      message: `Audit chain broken for tenant ${failure.tenantId}: ${failure.error} ` +
        `(source=${failure.sourceChainOk ? "verified" : "broken"} ` +
        `governance=${failure.governanceChainOk ? "verified" : "broken"})`,
      tenantId: failure.tenantId,
      data: failure,
    });
    console.error(
      `audit_integrity_broken tenant=${failure.tenantId} error=${failure.error} ` +
        `checked=${failure.checked} source_chain_ok=${failure.sourceChainOk} ` +
        `governance_chain_ok=${failure.governanceChainOk}`,
    );
  }
  return { ok: broken.length === 0, tenantsChecked: tenants.length, broken };
}
