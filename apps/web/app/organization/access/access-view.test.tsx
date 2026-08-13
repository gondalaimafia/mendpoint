import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccessAdminView,
  type AccessAdminData,
} from "./access-view";

function baseData(overrides: Partial<AccessAdminData> = {}): AccessAdminData {
  return {
    posture: {
      tenantId: "tenant-a",
      computedAt: "2026-08-12T12:00:00.000Z",
      controls: [
        {
          id: "tenant_isolation",
          label: "Tenant isolation",
          status: "enforced",
          detail: "Cross-tenant access fails closed.",
          source: "@mendpoint/platform assertTenant",
        },
        {
          id: "least_privilege_scopes",
          label: "Least-privilege scopes",
          status: "not_configured",
          detail: "No member scopes defined.",
          source: "@mendpoint/db tenant_member_scopes",
        },
        {
          id: "microvm_isolation",
          label: "Per-run microVM isolation",
          status: "configured",
          detail: "Fly Machines microVMs configured.",
          source: "env MENDPOINT_SANDBOX_FLY_APP",
        },
      ],
    },
    scopes: [
      {
        issuer: "https://id.example.com",
        subject: "member-1",
        scopeType: "repository",
        scopeValue: "acme/api",
        createdAt: "2026-08-12T12:00:00.000Z",
        createdBy: "trust-admin-a",
      },
    ],
    audit: {
      data: [
        {
          id: "evt-1",
          createdAt: "2026-08-12T12:00:00.000Z",
          eventSequence: 1,
          actor: "human:admin-a",
          action: "member_scope.grant",
          resourceType: "member_scope",
          resourceId: "member_scope:abc",
          requestId: "request-admin-a",
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
      chain: { ok: true, checked: 1 },
    },
    ...overrides,
  };
}

function render(data: AccessAdminData): string {
  return renderToStaticMarkup(
    <AccessAdminView
      data={data}
      exportCsvHref="http://api/self-serve/admin/audit/export?format=csv"
      exportJsonHref="http://api/self-serve/admin/audit/export?format=json"
    />,
  );
}

describe("AccessAdminView", () => {
  it("renders posture controls with their real status and source", () => {
    const html = render(baseData());
    expect(html).toContain("Tenant isolation");
    expect(html).toContain("enforced");
    expect(html).toContain("not configured");
    expect(html).toContain("configured");
    expect(html).toContain("Source: env MENDPOINT_SANDBOX_FLY_APP");
  });

  it("renders member scopes and the audit trail with chain status and exports", () => {
    const html = render(baseData());
    expect(html).toContain("acme/api");
    expect(html).toContain("member_scope.grant");
    expect(html).toContain("chain verified (1)");
    expect(html).toContain("audit/export?format=csv");
    expect(html).toContain("Showing 1 of 1 events");
  });

  it("shows honest empty states when there is no data", () => {
    const html = render(baseData({ scopes: [], audit: null, posture: null }));
    expect(html).toContain("No member scopes defined");
    expect(html).toContain("No audit events recorded");
    expect(html).toContain("Posture unavailable");
  });

  it("flags a broken audit chain", () => {
    const data = baseData();
    const html = render({
      ...data,
      audit: { ...data.audit!, chain: { ok: false, checked: 2, error: "audit_chain_hash:evt-2" } },
    });
    expect(html).toContain("chain broken");
  });
});
