import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG, catalogEntry, explainConnectorError } from "./catalog.js";

describe("connector catalog", () => {
  it("covers all three families with their providers", () => {
    const byKind = (kind: string) => CONNECTOR_CATALOG.filter((e) => e.kind === kind).map((e) => e.provider);
    expect(byKind("ci").sort()).toEqual(["github_actions", "gitlab_ci"]);
    expect(byKind("ticketing").sort()).toEqual(["jira", "linear"]);
    expect(byKind("docs").sort()).toEqual(["confluence", "markdown_repo", "notion"]);
  });

  it("marks Jira's required real-mode fields", () => {
    const jira = catalogEntry("ticketing", "jira");
    expect(jira?.fields.find((f) => f.key === "token")?.required).toBe(true);
    expect(jira?.fields.find((f) => f.key === "token")?.secret).toBe(true);
    expect(jira?.fields.find((f) => f.key === "apiBaseUrl")?.required).toBe(true);
  });

  it("gives actionable diagnostics for connector error codes", () => {
    expect(explainConnectorError("jira_credential_required")).toMatch(/credential/i);
    expect(explainConnectorError("connector_unverified")).toMatch(/verify/i);
    expect(explainConnectorError("github_actions_probe_http_401")).toMatch(/scope|expired/i);
    expect(explainConnectorError("tenant_mismatch")).toMatch(/workspace/i);
    // Unknown code still returns a non-empty, non-silent message.
    expect(explainConnectorError("totally_unknown").length).toBeGreaterThan(0);
  });
});
