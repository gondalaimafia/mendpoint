import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const verifierPath = resolve(
  import.meta.dirname,
  "verify-fly-app-token-scope.mjs",
);

interface ScopeVerifier {
  verifyFlyAppTokenScope(input: Readonly<{
    rawCredential: string | undefined;
    debugJson: string | undefined;
    expectedAppId: string | undefined;
  }>): void;
}

async function verifier(): Promise<ScopeVerifier> {
  return import(pathToFileURL(verifierPath).href) as Promise<ScopeVerifier>;
}

function permissionToken(
  apps: Readonly<Record<string, string>> = { "123": "rw" },
  caveats: readonly unknown[] = [],
): Record<string, unknown> {
  return {
    location: "https://api.fly.io/v1",
    caveats: [
      { type: "Apps", body: { apps } },
      ...caveats,
    ],
  };
}

const pureCredential = "FlyV1 fm2_YQ==";

describe("Fly app token scope verifier", () => {
  it("accepts one pure macaroon with the provider-real exact app caveat", async () => {
    const { verifyFlyAppTokenScope } = await verifier();
    expect(() => verifyFlyAppTokenScope({
      rawCredential: pureCredential,
      debugJson: JSON.stringify([permissionToken()]),
      expectedAppId: "123",
    })).not.toThrow();
  });

  it.each([
    "fm2_YQ==",
    "flyv1 fm2_YQ==",
    "BEARER fm2_YQ==",
    "Bearer FlyV1 fm2_YQ==",
    "flyv1 bearer FLYV1 fm2_YQ==",
  ])("accepts the valid case-insensitive recursive Fly credential grammar: %s", async (rawCredential) => {
    const { verifyFlyAppTokenScope } = await verifier();
    expect(() => verifyFlyAppTokenScope({
      rawCredential,
      debugJson: JSON.stringify([permissionToken()]),
      expectedAppId: "123",
    })).not.toThrow();
  });

  it.each([
    ["personal token", "fo1_personal"],
    ["Bearer personal token", "Bearer fo1_personal"],
    ["mixed personal and macaroon", `${pureCredential},fo1_personal`],
    ["multiple macaroons", `${pureCredential},fm2_Yg==`],
    ["unknown token type", "FlyV1 future_token"],
    ["unknown scheme", "Basic fm2_YQ=="],
    ["URL-safe payload", "FlyV1 fm2_YQ-_"],
    ["missing payload", "Bearer FlyV1"],
    ["comma-bundled macaroons", "Bearer fm2_YQ==,fm2_Yg=="],
  ])("rejects a %s before decoding", async (_name, rawCredential) => {
    const { verifyFlyAppTokenScope } = await verifier();
    expect(() => verifyFlyAppTokenScope({
      rawCredential,
      debugJson: JSON.stringify([permissionToken()]),
      expectedAppId: "123",
    })).toThrow("customer_backup_fly_credential_not_pure_macaroon");
  });

  it.each([
    ["wildcard app", permissionToken({ "0": "rw" })],
    ["wrong app", permissionToken({ "999": "rw" })],
    ["multiple apps", permissionToken({ "123": "rw", "999": "rw" })],
    ["empty mask", permissionToken({ "123": "" })],
    ["wrong permission location", { ...permissionToken(), location: "https://api.fly.io/aaa/v1" }],
    ["wrapped app scope", {
      location: "https://api.fly.io/v1",
      caveats: [{
        type: "IfPresent",
        body: {
          ifs: [{ type: "Apps", body: { apps: { "123": "rw" } } }],
          else: [],
        },
      }],
    }],
  ])("rejects %s", async (_name, token) => {
    const { verifyFlyAppTokenScope } = await verifier();
    expect(() => verifyFlyAppTokenScope({
      rawCredential: pureCredential,
      debugJson: JSON.stringify([token]),
      expectedAppId: "123",
    })).toThrow("customer_backup_token_not_app_scoped");
  });

  it("accepts official machine-exec Commands narrowing inside IfPresent", async () => {
    const { verifyFlyAppTokenScope } = await verifier();
    const machineExec = permissionToken({ "123": "rw" }, [{
      type: "IfPresent",
      body: {
        ifs: [{
          type: "Commands",
          body: [{ args: ["fly", "ssh", "console"], exact: true }],
        }],
        else: [],
      },
    }]);
    expect(() => verifyFlyAppTokenScope({
      rawCredential: "Bearer FlyV1 fm2_YQ==",
      debugJson: JSON.stringify([machineExec]),
      expectedAppId: "123",
    })).not.toThrow();
  });

  it("rejects a nested Apps caveat even when an exact top-level Apps caveat exists", async () => {
    const { verifyFlyAppTokenScope } = await verifier();
    const ambiguous = permissionToken({ "123": "rw" }, [{
      type: "IfPresent",
      body: {
        ifs: [{ type: "Apps", body: { apps: { "123": "rw" } } }],
        else: [],
      },
    }]);
    expect(() => verifyFlyAppTokenScope({
      rawCredential: pureCredential,
      debugJson: JSON.stringify([ambiguous]),
      expectedAppId: "123",
    })).toThrow("customer_backup_token_not_app_scoped");
  });

  it("rejects multiple decoded permission tokens even when both name the exact app", async () => {
    const { verifyFlyAppTokenScope } = await verifier();
    expect(() => verifyFlyAppTokenScope({
      rawCredential: pureCredential,
      debugJson: JSON.stringify([permissionToken(), permissionToken()]),
      expectedAppId: "123",
    })).toThrow("customer_backup_token_not_app_scoped");
  });

  it("never prints the raw credential or decoded caveats on refusal", () => {
    const debugJson = JSON.stringify([permissionToken()]);
    const rawCredential = `${pureCredential},fo1_private-value`;
    const result = spawnSync(process.execPath, [verifierPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FLY_API_TOKEN: rawCredential,
        MENDPOINT_FLY_TOKEN_DEBUG_JSON: debugJson,
        MENDPOINT_EXPECTED_FLY_APP_ID: "123",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("customer_backup_fly_credential_not_pure_macaroon\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(rawCredential);
    expect(`${result.stdout}${result.stderr}`).not.toContain(debugJson);
  });

  it("can prove a pure raw credential before token debugging", () => {
    const valid = spawnSync(process.execPath, [verifierPath, "--credential-only"], {
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: pureCredential },
    });
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toBe("");
    expect(valid.stderr).toBe("");

    const mixed = `${pureCredential},fo1_private-value`;
    const refused = spawnSync(process.execPath, [verifierPath, "--credential-only"], {
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: mixed },
    });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe("customer_backup_fly_credential_not_pure_macaroon\n");
    expect(refused.stderr).not.toContain(mixed);
  });
});
