import { describe, expect, it } from "vitest";
import { createTicketingConnector } from "./ticketing.js";
import type { ConnectorFetch } from "./connector.js";

function scriptedFetch(
  responder: (url: string, init?: { method?: string; body?: string }) => { ok: boolean; status: number; json: unknown },
): ConnectorFetch {
  return async (url, init) => responder(url, init);
}

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  throw new Error("expected function to throw");
}

describe("ticketing connector — mock (default, no credential)", () => {
  it("creates and links a deterministic issue for both providers", async () => {
    for (const provider of ["jira", "linear"] as const) {
      const connector = createTicketingConnector({ provider, project: "MEND" });
      await connector.verifyConnection();
      const issue = await connector.createIssue({ title: "Acme v3 breaking change", body: "Warden opened PR #123" });
      expect(issue.provider).toBe(provider);
      expect(issue.key).toMatch(/^MEND-\d+$/);
      const link = await connector.linkIssue({ issueKey: issue.key, targetUrl: "https://github.com/acme/shop/pull/123" });
      expect(link.relation).toBe("relates_to");
      expect(link.targetUrl).toBe("https://github.com/acme/shop/pull/123");
    }
  });

  it("is unavailable until verified (fail-closed, not a silent no-op)", async () => {
    const connector = createTicketingConnector({ provider: "jira", project: "MEND" });
    await expect(connector.createIssue({ title: "x", body: "y" })).rejects.toMatchObject({
      code: "connector_unverified",
    });
  });
});

describe("ticketing connector — real (credential-gated)", () => {
  it("Jira cannot construct without email + token + site URL", () => {
    expect(thrownCode(() => createTicketingConnector({ provider: "jira", mode: "real", token: "t" }))).toBe(
      "jira_credential_required",
    );
  });

  it("Linear cannot construct without a token", () => {
    expect(thrownCode(() => createTicketingConnector({ provider: "linear", mode: "real" }))).toBe(
      "linear_credential_required",
    );
  });

  it("Jira real path creates an issue via the fetch seam", async () => {
    const fetchImpl = scriptedFetch((url) => {
      if (url.includes("/myself")) return { ok: true, status: 200, json: { accountId: "1" } };
      if (url.endsWith("/rest/api/3/issue")) return { ok: true, status: 201, json: { id: "10001", key: "MEND-42" } };
      return { ok: false, status: 404, json: null };
    });
    const connector = createTicketingConnector({
      provider: "jira",
      mode: "real",
      token: "t",
      email: "eng@acme.com",
      apiBaseUrl: "https://acme.atlassian.net",
      project: "MEND",
      fetch: fetchImpl,
    });
    await connector.verifyConnection();
    const issue = await connector.createIssue({ title: "Acme v3", body: "PR #123" });
    expect(issue.key).toBe("MEND-42");
    expect(issue.url).toBe("https://acme.atlassian.net/browse/MEND-42");
  });

  it("Linear real path creates an issue via GraphQL", async () => {
    const fetchImpl = scriptedFetch((url, init) => {
      const body = init?.body ?? "";
      if (body.includes("viewer")) return { ok: true, status: 200, json: { data: { viewer: { id: "u1" } } } };
      return {
        ok: true,
        status: 200,
        json: { data: { issueCreate: { issue: { id: "i1", identifier: "ENG-7", url: "https://linear.app/i/ENG-7", title: "Acme v3" } } } },
      };
    });
    const connector = createTicketingConnector({ provider: "linear", mode: "real", token: "lin_x", project: "team-1", fetch: fetchImpl });
    await connector.verifyConnection();
    const issue = await connector.createIssue({ title: "Acme v3", body: "PR #123" });
    expect(issue.key).toBe("ENG-7");
  });
});
