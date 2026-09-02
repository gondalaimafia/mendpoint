import { describe, expect, it, vi } from "vitest";
import { createHttpsExternalKeyTransport } from "./external-kek-client.js";

const locator = {
  provider: "customer-kms",
  keyId: "tenant-key",
  version: "1",
} as const;

describe("HTTPS external key transport", () => {
  it("sends only the existing provider contract over HTTPS", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      Response.json({ accepted: true }));
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test/tenant-keys/",
      authorization: "Bearer credential-value",
      timeoutMs: 100,
      maxResponseBytes: 1_024,
      fetchImpl: fetchImpl as typeof fetch,
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

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([input, init]) => ({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    }))).toEqual([
      {
        url: "https://vault.example.test/tenant-keys/v1/keys/attest",
        authorization: "Bearer credential-value",
        body: { provider: "customer-kms", keyId: "tenant-key", version: "1", tenantId: "tenant-a" },
      },
      {
        url: "https://vault.example.test/tenant-keys/v1/keys/wrap",
        authorization: "Bearer credential-value",
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
    expect(() => createHttpsExternalKeyTransport({ endpoint })).toThrow(code);
  });

  it.each([
    ["provider denial", async () => new Response("private provider body", { status: 403 })],
    ["malformed response", async () => new Response("private malformed body", { status: 200 })],
    ["oversized response", async () => new Response(JSON.stringify({ secret: "x".repeat(2_000) }), { status: 200 })],
  ])("redacts credentials and provider bodies on %s", async (_name, fetchImpl) => {
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      authorization: "Bearer credential-value",
      maxResponseBytes: 128,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await transport.attestKey(locator, "tenant-a").catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("external_kek_request_failed"));
    expect(String(error)).not.toContain("credential-value");
    expect(String(error)).not.toContain("private");
  });

  it("fails closed on timeout without exposing the provider failure", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("credential-value provider timeout")));
      }));
    const transport = createHttpsExternalKeyTransport({
      endpoint: "https://vault.example.test",
      authorization: "Bearer credential-value",
      timeoutMs: 5,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await transport.attestKey(locator, "tenant-a").catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("external_kek_request_failed"));
    expect(String(error)).not.toContain("credential-value");
  });
});
