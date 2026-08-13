import { describe, expect, it } from "vitest";
import { resolveConnectorMode, connectorModeEnvVar, ConnectorError } from "./connector.js";

describe("connector core", () => {
  it("selects real only for the exact string 'real'", () => {
    expect(resolveConnectorMode("real")).toBe("real");
    expect(resolveConnectorMode("mock")).toBe("mock");
    expect(resolveConnectorMode("true")).toBe("mock");
    expect(resolveConnectorMode(undefined)).toBe("mock");
    expect(resolveConnectorMode("")).toBe("mock");
  });

  it("maps each family to its mode env var", () => {
    expect(connectorModeEnvVar("ci")).toBe("CI_CONNECTOR_MODE");
    expect(connectorModeEnvVar("ticketing")).toBe("TICKETING_CONNECTOR_MODE");
    expect(connectorModeEnvVar("docs")).toBe("DOCS_CONNECTOR_MODE");
  });

  it("ConnectorError carries a stable code, kind, and provider", () => {
    const error = new ConnectorError({ code: "x_credential_required", kind: "ci", provider: "github_actions" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConnectorError");
    expect(error.code).toBe("x_credential_required");
    expect(error.kind).toBe("ci");
    expect(error.provider).toBe("github_actions");
  });
});
