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
});
