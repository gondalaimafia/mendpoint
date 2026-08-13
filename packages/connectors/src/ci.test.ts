import { describe, expect, it } from "vitest";
import { createCiConnector, type BuildStatus } from "./ci.js";
import type { ConnectorFetch } from "./connector.js";

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  throw new Error("expected function to throw");
}

function scriptedFetch(
  responder: (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    ok: boolean;
    status: number;
    json: unknown;
  },
): { fetchImpl: ConnectorFetch; calls: Array<{ url: string; method: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl: ConnectorFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

describe("CI connector — mock (default, no credential)", () => {
  it("verifies and reads a deterministic build status for both providers", async () => {
    for (const provider of ["github_actions", "gitlab_ci"] as const) {
      const connector = createCiConnector({ provider });
      expect(connector.kind).toBe("ci");
      expect(connector.mode).toBe("mock");
      const health = await connector.verifyConnection();
      expect(health.ok).toBe(true);
      expect(connector.ready).toBe(true);
      const status = await connector.readBuildStatus({ repo: "acme/shop", ref: "main" });
      expect(status.provider).toBe(provider);
      expect(["passed", "failed", "running", "unknown"]).toContain(status.state);
      // Deterministic
      const again = await connector.readBuildStatus({ repo: "acme/shop", ref: "main" });
      expect(again.state).toBe(status.state);
    }
  });

  it("is unavailable (fail-closed) until verified — no silent no-op", async () => {
    const connector = createCiConnector({ provider: "github_actions" });
    expect(connector.ready).toBe(false);
    await expect(connector.readBuildStatus({ repo: "acme/shop", ref: "main" })).rejects.toMatchObject({
      code: "connector_unverified",
    });
  });
});

describe("CI connector — real (credential-gated)", () => {
  it("cannot be constructed without a token (fail-closed at construction)", () => {
    expect(thrownCode(() => createCiConnector({ provider: "github_actions", mode: "real" }))).toBe(
      "github_actions_credential_required",
    );
    expect(thrownCode(() => createCiConnector({ provider: "gitlab_ci", mode: "real" }))).toBe(
      "gitlab_ci_credential_required",
    );
  });

  it("github_actions real path authenticates and reads check-runs via the fetch seam", async () => {
    const { fetchImpl, calls } = scriptedFetch((url) => {
      if (url.includes("/rate_limit")) return { ok: true, status: 200, json: {} };
      if (url.includes("/check-runs")) {
        return {
          ok: true,
          status: 200,
          json: { check_runs: [{ name: "build", conclusion: "success", status: "completed", html_url: "https://gh/run/1" }] },
        };
      }
      return { ok: false, status: 404, json: null };
    });
    const connector = createCiConnector({ provider: "github_actions", mode: "real", token: "ghp_x", fetch: fetchImpl });
    const health = await connector.verifyConnection();
    expect(health.ok).toBe(true);
    const status: BuildStatus = await connector.readBuildStatus({ repo: "acme/shop", ref: "abc123" });
    expect(status.state).toBe("passed");
    expect(calls[0]!.headers.Authorization).toBe("Bearer ghp_x");
  });

  it("gitlab_ci real path maps pipeline status and never leaks the token in errors", async () => {
    const { fetchImpl } = scriptedFetch((url) => {
      if (url.includes("/version")) return { ok: true, status: 200, json: { version: "16.0" } };
      if (url.includes("/pipelines")) return { ok: true, status: 200, json: [{ status: "failed", web_url: "https://gl/p/9" }] };
      return { ok: false, status: 404, json: null };
    });
    const connector = createCiConnector({ provider: "gitlab_ci", mode: "real", token: "glpat-secret", fetch: fetchImpl });
    await connector.verifyConnection();
    const status = await connector.readBuildStatus({ repo: "acme/shop", ref: "main" });
    expect(status.state).toBe("failed");
    expect(status.checks[0]!.name).toBe("pipeline");
  });

  it("fails closed on an auth error — verify returns ok:false and capability stays blocked", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ ok: false, status: 401, json: null }));
    const connector = createCiConnector({ provider: "github_actions", mode: "real", token: "bad", fetch: fetchImpl });
    const health = await connector.verifyConnection();
    expect(health.ok).toBe(false);
    expect(health.errorCode).toBe("github_actions_probe_http_401");
    expect(connector.ready).toBe(false);
    await expect(connector.readBuildStatus({ repo: "acme/shop", ref: "main" })).rejects.toMatchObject({
      code: "connector_unverified",
    });
  });
});
