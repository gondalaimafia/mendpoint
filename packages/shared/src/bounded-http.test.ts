import { describe, expect, it } from "vitest";
import { fetchBoundedText } from "./bounded-http.js";

describe("bounded HTTP text transport", () => {
  it("returns an exact response inside the configured limits", async () => {
    const result = await fetchBoundedText(
      "https://provider.example.com/result",
      {},
      {
        timeoutMs: 1_000,
        maxResponseBytes: 32,
        fetchImpl: async () => new Response("result", { status: 200 }),
      },
    );
    expect(result.response.status).toBe(200);
    expect(result.text).toBe("result");
  });

  it("rejects declared and streamed responses above the byte limit", async () => {
    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 1_000,
      maxResponseBytes: 4,
      fetchImpl: async () => new Response("x", {
        headers: { "content-length": "5" },
      }),
    })).rejects.toThrow("bounded_http_response_too_large");

    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 1_000,
      maxResponseBytes: 4,
      fetchImpl: async () => new Response("12345"),
    })).rejects.toThrow("bounded_http_response_too_large");
  });

  it("settles on timeout even when the injected transport never cooperates", async () => {
    const started = Date.now();
    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 10,
      maxResponseBytes: 32,
      fetchImpl: () => new Promise<Response>(() => undefined),
    })).rejects.toThrow("bounded_http_timeout");
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("settles when the provider returns headers but stalls the response body", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 10,
      maxResponseBytes: 32,
      fetchImpl: async () => new Response(stalled),
    })).rejects.toThrow("bounded_http_timeout");
  });

  it("composes caller cancellation and rejects invalid limits", async () => {
    const controller = new AbortController();
    controller.abort("lease_lost");
    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 1_000,
      maxResponseBytes: 32,
      signal: controller.signal,
      fetchImpl: () => new Promise<Response>(() => undefined),
    })).rejects.toThrow("bounded_http_aborted");

    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 0,
      maxResponseBytes: 32,
    })).rejects.toThrow("bounded_http_timeout_invalid");
    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 1_000,
      maxResponseBytes: 0,
    })).rejects.toThrow("bounded_http_response_limit_invalid");
  });

  it("preserves transport read failures and classifies invalid UTF-8 separately", async () => {
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("transport_read_failed"));
      },
    });
    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 1_000,
      maxResponseBytes: 32,
      fetchImpl: async () => new Response(failed),
    })).rejects.toThrow("transport_read_failed");

    await expect(fetchBoundedText("https://provider.example.com/result", {}, {
      timeoutMs: 1_000,
      maxResponseBytes: 32,
      fetchImpl: async () => new Response(Uint8Array.from([0xc3, 0x28])),
    })).rejects.toThrow("bounded_http_response_encoding_invalid");
  });
});
