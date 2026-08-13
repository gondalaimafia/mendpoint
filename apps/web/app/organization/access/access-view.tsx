import React from "react";
import { Badge, type BadgeTone } from "../../components/ds/index.js";

export type PostureControl = {
  id: string;
  label: string;
  status: "enforced" | "configured" | "not_configured";
  detail: string;
  source: string;
};

export type SecurityPosture = {
  tenantId: string;
  controls: PostureControl[];
  computedAt: string;
};

export type MemberScope = {
  issuer: string;
  subject: string;
  scopeType: "repository" | "environment";
  scopeValue: string;
  createdAt: string;
  createdBy: string;
};

export type AuditRow = {
  id: string;
  createdAt: string;
  eventSequence: number;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
};

export type AuditView = {
  data: AuditRow[];
  total: number;
  limit: number;
  offset: number;
  chain: { ok: boolean; checked: number; error?: string };
};

export type AccessAdminData = {
  posture: SecurityPosture | null;
  scopes: MemberScope[] | null;
  audit: AuditView | null;
};

function statusTone(status: PostureControl["status"]): BadgeTone {
  if (status === "enforced") return "emerald";
  if (status === "configured") return "accent";
  return "neutral";
}

function statusLabel(status: PostureControl["status"]): string {
  if (status === "enforced") return "enforced";
  if (status === "configured") return "configured";
  return "not configured";
}

function PosturePanel({ posture }: { posture: SecurityPosture | null }) {
  return (
    <section className="surface" aria-label="Security posture">
      <div className="section-head">
        <div>
          <p className="eyebrow">Security posture</p>
          <h2>Controls in effect for this tenant</h2>
        </div>
      </div>
      {!posture ? (
        <div className="empty-state compact">
          <p className="muted">Posture unavailable: the API did not return a posture summary.</p>
        </div>
      ) : (
        <div className="metric-grid">
          {posture.controls.map((control) => (
            <div className="metric-card" key={control.id}>
              <span className="metric-label">{control.label}</span>
              <strong>
                <Badge tone={statusTone(control.status)}>{statusLabel(control.status)}</Badge>
              </strong>
              <span className="metric-detail">{control.detail}</span>
              <span className="metric-detail muted">Source: {control.source}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ScopesPanel({ scopes }: { scopes: MemberScope[] | null }) {
  return (
    <section className="surface" aria-label="Member access scopes">
      <div className="section-head">
        <div>
          <p className="eyebrow">Least-privilege scopes</p>
          <h2>Repository and environment access</h2>
        </div>
      </div>
      {!scopes || scopes.length === 0 ? (
        <div className="empty-state compact">
          <p className="muted">
            No member scopes defined. Members inherit their role&rsquo;s full tenant reach until a scope narrows it.
          </p>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Type</th>
              <th>Scope</th>
              <th>Granted</th>
            </tr>
          </thead>
          <tbody>
            {scopes.map((scope) => (
              <tr key={`${scope.subject}-${scope.scopeType}-${scope.scopeValue}`}>
                <td>{scope.subject}</td>
                <td>
                  <Badge tone={scope.scopeType === "repository" ? "accent" : "neutral"}>
                    {scope.scopeType}
                  </Badge>
                </td>
                <td>{scope.scopeValue}</td>
                <td>{scope.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AuditPanel({ audit, exportCsvHref, exportJsonHref }: {
  audit: AuditView | null;
  exportCsvHref: string;
  exportJsonHref: string;
}) {
  return (
    <section className="surface" aria-label="Audit trail">
      <div className="section-head">
        <div>
          <p className="eyebrow">Audit trail</p>
          <h2>Who did what, when, on which resource</h2>
        </div>
        {audit && (
          <Badge tone={audit.chain.ok ? "emerald" : "danger"}>
            {audit.chain.ok ? `chain verified (${audit.chain.checked})` : "chain broken"}
          </Badge>
        )}
      </div>
      <p className="command-actions" aria-label="Audit exports">
        <a className="btn" href={exportCsvHref}>
          Export CSV
        </a>
        <a className="btn" href={exportJsonHref}>
          Export JSON
        </a>
      </p>
      {!audit || audit.data.length === 0 ? (
        <div className="empty-state compact">
          <p className="muted">No audit events recorded for this tenant yet.</p>
        </div>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((event) => (
                <tr key={event.id}>
                  <td>{event.createdAt}</td>
                  <td>{event.actor}</td>
                  <td>{event.action}</td>
                  <td>
                    {event.resourceType}
                    {event.resourceId ? ` · ${event.resourceId}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Showing {audit.data.length} of {audit.total} events. Filter by actor, action, resource, or date
            with the <code>actor</code>, <code>action</code>, <code>resourceType</code>, <code>since</code>, and
            <code> until</code> query parameters.
          </p>
        </>
      )}
    </section>
  );
}

export function AccessAdminView({
  data,
  exportCsvHref,
  exportJsonHref,
}: {
  data: AccessAdminData;
  exportCsvHref: string;
  exportJsonHref: string;
}) {
  return (
    <>
      <PosturePanel posture={data.posture} />
      <ScopesPanel scopes={data.scopes} />
      <AuditPanel audit={data.audit} exportCsvHref={exportCsvHref} exportJsonHref={exportJsonHref} />
    </>
  );
}
