import { describe, expect, it, vi } from "vitest";
import { createHttpsExternalKeyTransport } from "./external-kek-client.js";
import type { ExternalKeyHttpsRequester } from "./external-kek-client.js";

const locator = {
  provider: "customer-kms",
  keyId: "tenant-key",
  version: "1",
} as const;

const publicDestination = {
  authority: "vault.example.test",
  mode: "public" as const,
};
const resolvePublicAddress = async () => ["93.184.216.34"];

function jsonRequester(value: unknown = { accepted: true }) {
  return vi.fn<ExternalKeyHttpsRequester>(async () => ({
    statusCode: 200,
    contentType: "application/json",
    text: JSON.stringify(value),
  }));
}

describe("HTTPS external key transport", () => {
  it("sends only the existing provider contract over HTTPS", async () => {
    const requestImpl = jsonRequester();
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test/tenant-keys/",
      destination: publicDestination,
      resolveAddresses: resolvePublicAddress,
      authorization: "Bearer credential-value",
      timeoutMs: 100,
      maxResponseBytes: 1_024,
      requestImpl,
    });

    await expect(transport.attestKey(locator, "tenant-a")).resolves.toEqual({ accepted: true });
    await expect(transport.wrapDataKey(
      { ...locator, customerManaged: true },
      "tenant-a",
      Buffer.alloc(32, 7),
    )).resolves.toEqual({ accepted: true });
    await expect(transport.unwrapDataKey(
      { ...locator, customerManaged: true },
      "tenant-a",
      "d3JhcHBlZA==",
    )).resolves.toEqual({ accepted: true });

    expect(requestImpl).toHaveBeenCalledTimes(3);
    expect(requestImpl.mock.calls.map(([request]) => ({
      url: String(request.url),
      authorization: request.headers.authorization,
      resolvedAddresses: request.resolvedAddresses,
      body: JSON.parse(request.body),
    }))).toEqual([
      {
        url: "https://vault.example.test/tenant-keys/v1/keys/attest",
        authorization: "Bearer credential-value",
        resolvedAddresses: ["93.184.216.34"],
        body: { provider: "customer-kms", keyId: "tenant-key", version: "1", tenantId: "tenant-a" },
      },
      {
        url: "https://vault.example.test/tenant-keys/v1/keys/wrap",
        authorization: "Bearer credential-value",
        resolvedAddresses: ["93.184.216.34"],
        body: {
          provider: "customer-kms",
          keyId: "tenant-key",
          version: "1",
          customerManaged: true,
          tenantId: "tenant-a",
          dataKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
      {
        url: "https://vault.example.test/tenant-keys/v1/keys/unwrap",
        authorization: "Bearer credential-value",
        resolvedAddresses: ["93.184.216.34"],
        body: {
          provider: "customer-kms",
          keyId: "tenant-key",
          version: "1",
          customerManaged: true,
          tenantId: "tenant-a",
          wrappedDataKey: "d3JhcHBlZA==",
        },
      },
    ]);
  });

  it.each([
    ["http://vault.example.test", "external_kek_transport_configuration_invalid"],
    ["https://user:password@vault.example.test", "external_kek_transport_configuration_invalid"],
    ["https://vault.example.test?tenant=a", "external_kek_transport_configuration_invalid"],
  ])("rejects an unsafe endpoint %s", (endpoint, code) => {
    expect(() => createHttpsExternalKeyTransport({
      endpoint,
      destination: publicDestination,
      resolveAddresses: resolvePublicAddress,
    })).toThrow(code);
  });

  it("requires an exact destination authority instead of trusting the scheme", () => {
    expect(() => createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
    } as never)).toThrow("external_kek_transport_configuration_invalid");
    expect(() => createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      destination: { authority: "other.example.test", mode: "public" },
      resolveAddresses: resolvePublicAddress,
    })).toThrow("external_kek_transport_configuration_invalid");
  });

  it("never follows redirects", async () => {
    const requestImpl = vi.fn<ExternalKeyHttpsRequester>(async () => ({
      statusCode: 302,
      contentType: "application/json",
      text: JSON.stringify({ location: "https://metadata.invalid" }),
    }));
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      destination: publicDestination,
      resolveAddresses: resolvePublicAddress,
      requestImpl,
    });

    await expect(transport.attestKey(locator, "tenant-a"))
      .rejects.toThrow("external_kek_request_failed");
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["IPv4 unspecified", "0.0.0.0"],
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 private 10", "10.0.0.1"],
    ["IPv4 private 172", "172.16.0.1"],
    ["IPv4 private 192", "192.168.0.1"],
    ["IPv4 metadata and link local", "169.254.169.254"],
    ["IPv4 multicast", "224.0.0.1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv6 private", "fc00::1"],
    ["IPv6 link local", "fe80::a9fe:a9fe"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv4 mapped IPv6", "::ffff:127.0.0.1"],
  ])("rejects %s destinations before network access", async (_name, address) => {
    const requestImpl = jsonRequester();
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      destination: publicDestination,
      resolveAddresses: async () => [address],
      requestImpl,
    });

    await expect(transport.attestKey(locator, "tenant-a"))
      .rejects.toThrow("external_kek_request_failed");
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it("validates every DNS answer on every request to reject rebinding", async () => {
    const requestImpl = jsonRequester();
    const resolveAddresses = vi.fn()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["93.184.216.34", "10.0.0.7"]);
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      destination: publicDestination,
      resolveAddresses,
      requestImpl,
    });

    await expect(transport.attestKey(locator, "tenant-a")).resolves.toEqual({ accepted: true });
    await expect(transport.attestKey(locator, "tenant-a"))
      .rejects.toThrow("external_kek_request_failed");
    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });

  it("permits an exact private destination only with explicit operator authorization", async () => {
    const requestImpl = jsonRequester();
    const authorized = createHttpsExternalKeyTransport({
      endpoint: "https://vault.internal.test:8443",
      destination: {
        authority: "vault.internal.test:8443",
        mode: "operator-authorized-private",
        allowedAddresses: ["10.42.0.5"],
      },
      resolveAddresses: async () => ["10.42.0.5"],
      requestImpl,
    });
    await expect(authorized.attestKey(locator, "tenant-a")).resolves.toEqual({ accepted: true });

    const rebound = createHttpsExternalKeyTransport({
      endpoint: "https://vault.internal.test:8443",
      destination: {
        authority: "vault.internal.test:8443",
        mode: "operator-authorized-private",
        allowedAddresses: ["10.42.0.5"],
      },
      resolveAddresses: async () => ["10.42.0.6"],
      requestImpl,
    });
    await expect(rebound.attestKey(locator, "tenant-a"))
      .rejects.toThrow("external_kek_request_failed");
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unspecified", "0.0.0.0"],
    ["loopback", "127.0.0.1"],
    ["metadata", "169.254.169.254"],
    ["multicast", "224.0.0.1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv6 link local", "fe80::1"],
    ["IPv6 multicast", "ff02::1"],
  ])("does not let private authorization override %s destination denial", (_name, address) => {
    expect(() => createHttpsExternalKeyTransport({
      endpoint: "https://vault.internal.test",
      destination: {
        authority: "vault.internal.test",
        mode: "operator-authorized-private",
        allowedAddresses: [address],
      },
      resolveAddresses: async () => [address],
    })).toThrow("external_kek_transport_configuration_invalid");
  });

  it.each([
    ["provider denial", async () => ({ statusCode: 403, contentType: "text/plain", text: "private provider body" })],
    ["malformed response", async () => ({ statusCode: 200, contentType: "application/json", text: "private malformed body" })],
    ["oversized response", async () => ({ statusCode: 200, contentType: "application/json", text: JSON.stringify({ secret: "x".repeat(2_000) }) })],
  ])("redacts credentials and provider bodies on %s", async (_name, requestImpl) => {
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      destination: publicDestination,
      resolveAddresses: resolvePublicAddress,
      authorization: "Bearer credential-value",
      maxResponseBytes: 128,
      requestImpl,
    });

    const error = await transport.attestKey(locator, "tenant-a").catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("external_kek_request_failed"));
    expect(String(error)).not.toContain("credential-value");
    expect(String(error)).not.toContain("private");
  });

  it("fails closed on timeout without exposing the provider failure", async () => {
    const requestImpl = vi.fn<ExternalKeyHttpsRequester>(async (request) =>
      new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("credential-value provider timeout")));
      }));
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      destination: publicDestination,
      resolveAddresses: resolvePublicAddress,
      authorization: "Bearer credential-value",
      timeoutMs: 5,
      requestImpl,
    });

    const error = await transport.attestKey(locator, "tenant-a").catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("external_kek_request_failed"));
    expect(String(error)).not.toContain("credential-value");
  });
});
