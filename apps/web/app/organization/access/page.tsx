import { apiBase, apiGet } from "../../../lib/api";
import { selfServeAdminEnabled } from "../../../lib/proxy-auth";
import {
  AccessAdminView,
  type AuditView,
  type MemberScope,
  type SecurityPosture,
} from "./access-view";

export const dynamic = "force-dynamic";

export default async function OrganizationAccessPage() {
  // Default preview safe: the whole surface is dormant unless the self-serve admin
  // flag is on, mirroring the API route factory that 404s when the flag is off.
  if (!selfServeAdminEnabled()) {
    return (
      <div>
        <h1>Organization access</h1>
        <p className="lead">
          Self-serve access administration is not enabled for this deployment.
        </p>
      </div>
    );
  }

  const [postureResult, scopesResult, auditResult] = await Promise.allSettled([
    apiGet<{ data: SecurityPosture }>("/self-serve/admin/posture"),
    apiGet<{ data: MemberScope[] }>("/self-serve/admin/scopes"),
    apiGet<AuditView>("/self-serve/admin/audit"),
  ]);

  const posture = postureResult.status === "fulfilled" ? postureResult.value.data : null;
  const scopes = scopesResult.status === "fulfilled" ? scopesResult.value.data : null;
  const audit = auditResult.status === "fulfilled" ? auditResult.value : null;

  return (
    <div>
      <h1>Organization access</h1>
      <p className="lead">
        Manage organization, team, repository, and environment-level access with least-privilege
        controls, a hash-chained audit trail, and a security posture read from your tenant&rsquo;s real
        settings. Owner and admin only; every change is audited.
      </p>
      <AccessAdminView
        data={{ posture, scopes, audit }}
        exportCsvHref={`${apiBase()}/self-serve/admin/audit/export?format=csv`}
        exportJsonHref={`${apiBase()}/self-serve/admin/audit/export?format=json`}
      />
    </div>
  );
}
