import { afterEach, describe, expect, it, vi } from "vitest";
import { createSigV4S3ArtifactTransport } from "./transformer-s3-transport.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("SigV4 S3 artifact transport", () => {
  it("fails closed on non TLS or incomplete S3 configuration", () => {
    expect(() => createSigV4S3ArtifactTransport({ endpoint: "http://objects.example.test/", region: "", accessKeyId: "", secretAccessKey: "", timeoutMs: 0 })).toThrow("s3_sigv4_config_invalid");
  });

  it("signs exact encoded object paths and enforces atomic creation", async () => {
    vi.setSystemTime(new Date("2026-08-12T12:34:56.000Z"));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    }));
    const transport = createSigV4S3ArtifactTransport({ endpoint: "https://objects.example.test/", region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "session", timeoutMs: 1000 });
    await transport.putObject({ bucket: "bucket-a", key: "tenant a/file+!().json", body: new TextEncoder().encode("payload"), ifNoneMatch: "*" });
    expect(calls[0]?.url).toBe("https://objects.example.test/bucket-a/tenant%20a/file%2B%21%28%29.json");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe("*");
    expect(headers["x-amz-date"]).toBe("20260812T123456Z");
    expect(headers["x-amz-security-token"]).toBe("session");
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260812/us-east-1/s3/aws4_request, SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=d50e23104d38d7fe3dc699c40516ff7d6b3f095761de761fc3fa519b06a87525");
  });

  it("enforces a hard timeout when fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const transport = createSigV4S3ArtifactTransport({ endpoint: "https://objects.example.test/", region: "us-east-1", accessKeyId: "key", secretAccessKey: "secret", timeoutMs: 25 });
    const pending = transport.getObject({ bucket: "bucket-a", key: "tenant/file" });
    const rejected = expect(pending).rejects.toThrow("s3_sigv4_timeout");
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });
});
