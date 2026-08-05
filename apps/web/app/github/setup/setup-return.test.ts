import { describe, expect, it } from "vitest";
import { githubSetupRetryDelay, parseGitHubSetupReturn } from "./setup-return";

const state = "a".repeat(43);

describe("GitHub setup return", () => {
  it("accepts the canonical GitHub return and the stripped history receipt", () => {
    const parsed = parseGitHubSetupReturn(
      `?installation_id=12345&setup_action=install&state=${state}`,
    );
    expect(parsed).toEqual({
      state,
      installationId: "12345",
      setupAction: "install",
    });
    expect(
      parseGitHubSetupReturn("", { mendpointGitHubSetup: parsed }),
    ).toEqual(parsed);
  });

  it.each([
    `?installation_id=0&setup_action=install&state=${state}`,
    `?installation_id=12x&setup_action=install&state=${state}`,
    `?installation_id=123&setup_action=delete&state=${state}`,
    "?installation_id=123&setup_action=install&state=short",
  ])("rejects malformed return values", (search) => {
    expect(parseGitHubSetupReturn(search)).toBeNull();
  });

  it("bounds webhook retry delays", () => {
    expect([0, 1, 2, 3, 4, 5].map(githubSetupRetryDelay)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      8_000,
      null,
    ]);
  });
});
