import { afterEach, describe, expect, it, vi } from "vitest";

// wizard.tsx is a client component; stub next/navigation so importing it (for the
// exported helper) does not require a real router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { fetchInstallUrlData } from "./wizard";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("install wizard — a rejected install-url fetch is never treated as success", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on a non-ok response even though the JSON error body parses", async () => {
    // 401 web_session_required / 503 proxy_api_key_not_configured / 504
    // upstream_timeout all return a parseable JSON error body, so `.json()`
    // succeeds and the caller's catch never fires without a res.ok guard. The
    // wizard must NOT advance to "Open GitHub to install" on these.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "web_session_required" }, 401),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInstallUrlData("/api")).rejects.toThrow("web_session_required");
    expect(fetchMock).toHaveBeenCalledWith("/api/github/app/install-url");
  });

  it("returns the install payload on a successful response", async () => {
    const payload = {
      url: "https://github.com/apps/mendpoint/installations/new",
      mock: false,
      state: "state_abc",
    };
    const fetchMock = vi.fn(async () => jsonResponse(payload, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInstallUrlData("/api")).resolves.toEqual(payload);
  });
});
