import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public GitHub webhook bridge", () => {
  it("preserves only signed GitHub delivery headers and the raw body", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-github-event")).toBe("ping");
      expect(new Headers(init?.headers).get("x-github-delivery")).toBe("delivery-1");
      expect(new Headers(init?.headers).get("x-hub-signature-256")).toBe("sha256=signed");
      expect(Buffer.from(init?.body as ArrayBuffer).toString("utf8")).toBe('{"zen":"safe"}');
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest("https://mendpoint.example/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": "sha256=signed",
        authorization: "must-not-forward",
      },
      body: '{"zen":"safe"}',
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an oversized declared payload", async () => {
    const request = new NextRequest("https://mendpoint.example/webhooks/github", {
      method: "POST",
      headers: { "content-length": String(1024 * 1024 + 1) },
      body: "{}",
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
  });

  it("cancels an undeclared streamed payload at the byte limit", async () => {
    let cancelled = false;
    let index = 0;
    const chunks = [new Uint8Array(1024 * 1024), new Uint8Array([1])];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new NextRequest("https://mendpoint.example/webhooks/github", {
      method: "POST",
      body,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("cancels an undeclared oversized upstream response", async () => {
    let cancelled = false;
    let index = 0;
    const chunks = [new Uint8Array(1024 * 1024), new Uint8Array([1])];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      body: new ReadableStream({
        pull(controller) {
          const chunk = chunks[index++];
          if (chunk) controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
      headers: new Headers(),
      ok: true,
      status: 200,
    }) as Response));
    const response = await POST(new NextRequest(
      "https://mendpoint.example/webhooks/github",
      { method: "POST", body: "{}" },
    ));
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
  });
});
