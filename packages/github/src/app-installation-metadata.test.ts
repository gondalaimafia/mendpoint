import { describe, expect, it, vi } from "vitest";

// Isolated Octokit mock so this file exercises the metadata read's request shape
// and account-id mapping without a network call, and without affecting the other
// app-runtime tests (which monkey-patch the delivery's octokit seam directly).
const request = vi.fn();
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    request = request;
  },
}));

import { defaultFetchInstallationMetadata } from "./app-runtime.js";

describe("defaultFetchInstallationMetadata", () => {
  it("reads the installation as the App and maps the account id", async () => {
    request.mockResolvedValueOnce({
      data: { account: { id: 151614362, login: "acme", type: "Organization" } },
    });
    const result = await defaultFetchInstallationMetadata(999, "jwt.jwt.jwt");
    expect(request).toHaveBeenCalledWith(
      "GET /app/installations/{installation_id}",
      { installation_id: 999 },
    );
    expect(result).toEqual({
      installationId: 999,
      accountId: 151614362,
      accountLogin: "acme",
      accountType: "Organization",
    });
  });

  it("returns a null account id when GitHub reports no account", async () => {
    request.mockResolvedValueOnce({ data: { account: null } });
    const result = await defaultFetchInstallationMetadata(999, "jwt.jwt.jwt");
    expect(result.accountId).toBeNull();
    expect(result.accountLogin).toBeNull();
  });
});
