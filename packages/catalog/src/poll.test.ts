import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  contentHash,
  DEFAULT_FEED_MAX_BYTES,
  extractVersionLabel,
  fetchOpenApiDocument,
  listCatalogFeeds,
  resolveFeedUrl,
} from "./poll.js";

describe("poll", () => {
  it("lists catalog feeds including acme local fixture", () => {
    const feeds = listCatalogFeeds();
    expect(feeds.some((f) => f.slug === "acme-payments")).toBe(true);
    const acme = feeds.find((f) => f.slug === "acme-payments")!;
    expect(acme.openapiUrl.startsWith("file:")).toBe(true);
  });

  it("content-hashes stably", () => {
    expect(contentHash('{"a":1}')).toBe(contentHash('{"a":1}'));
    expect(contentHash('{"a":1}')).not.toBe(contentHash('{"a":2}'));
  });

  it("extracts version from OpenAPI info", () => {
    expect(extractVersionLabel({ info: { version: "2.1.0" } }, "abc")).toBe("2.1.0");
    expect(extractVersionLabel({}, "deadbeef12")).toMatch(/^polled-/);
  });

  it("fetches file: OpenAPI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-"));
    const path = join(dir, "spec.json");
    writeFileSync(
      path,
      JSON.stringify({ openapi: "3.0.0", info: { title: "T", version: "9.9.9" }, paths: {} }),
    );
    const res = await fetchOpenApiDocument(`file:${path}`);
    expect(res.ok).toBe(true);
    expect(res.versionLabel).toBe("9.9.9");
    expect(res.contentHash).toHaveLength(16);
  });

  it("rejects valid JSON that is not an OpenAPI document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-shape-"));
    const path = join(dir, "not-openapi.json");
    writeFileSync(path, JSON.stringify({ info: { version: "1" }, paths: {} }), "utf8");
    const res = await fetchOpenApiDocument(`file:${path}`);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("openapi or swagger");
  });

  it("rejects unsupported OpenAPI schema versions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-version-"));
    const path = join(dir, "unsupported.json");
    writeFileSync(
      path,
      JSON.stringify({ openapi: "4.0.0", info: { title: "Future", version: "1" }, paths: {} }),
      "utf8",
    );
    const result = await fetchOpenApiDocument(`file:${path}`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unsupported");
  });

  it("resolves relative file: against monorepo root", () => {
    const r = resolveFeedUrl("file:fixtures/x.json", "C:\\repo");
    expect(r.replace(/\\/g, "/")).toContain("repo");
    expect(r.replace(/\\/g, "/")).toContain("fixtures/x.json");
  });

  it("does not resolve a POSIX absolute file path under the monorepo", () => {
    const r = resolveFeedUrl("file:/tmp/spec.json", "C:\\repo");
    expect(r.replace(/\\/g, "/")).not.toContain("repo/tmp/spec.json");
    expect(r.replace(/\\/g, "/")).toMatch(/\/tmp\/spec\.json$/);
  });

  it("disables file and non-HTTPS feeds in production", async () => {
    const file = await fetchOpenApiDocument("file:fixtures/spec.json", {
      production: true,
    });
    expect(file.ok).toBe(false);
    expect(file.error).toContain("disabled in production");

    const http = await fetchOpenApiDocument("http://example.com/spec.json", {
      production: true,
    });
    expect(http.ok).toBe(false);
    expect(http.error).toContain("must use https");
  });

  it("blocks loopback, private, link-local, and metadata destinations after DNS", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.4",
      "169.254.169.254",
      "::1",
      "fd00:ec2::254",
    ]) {
      const response = await fetchOpenApiDocument(
        "https://feed.example/spec.json",
        {
          production: true,
          resolveHostname: async () => [address],
          fetchImpl: async () => {
            throw new Error("blocked destination was fetched");
          },
        },
      );
      expect(response.ok, address).toBe(false);
      expect(response.error, address).toContain("blocked address");
    }
  });

  it("revalidates redirect destinations before fetching them", async () => {
    const fetched: string[] = [];
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        resolveHostname: async (hostname) =>
          hostname === "feed.example" ? ["203.0.113.10"] : ["169.254.169.254"],
        fetchImpl: async (input) => {
          fetched.push(String(input));
          return new Response(null, {
            status: 302,
            headers: { Location: "https://metadata.example/latest" },
          });
        },
      },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toContain("blocked address");
    expect(fetched).toHaveLength(1);
  });

  it("caps streamed remote responses", async () => {
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        maxBytes: 32,
        resolveHostname: async () => ["203.0.113.10"],
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("x".repeat(64)));
                controller.close();
              },
            }),
          ),
      },
    );
    expect(response.ok).toBe(false);
    // Actionable message: names the provider, the limit, and the observed size.
    expect(response.error).toContain("feed.example");
    expect(response.error).toContain("exceeds the 32-byte limit");
    expect(response.error).toContain("64");
  });

  it("names the provider, size, and limit when the declared length is over the cap", async () => {
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        maxBytes: 32,
        provider: "Stripe",
        resolveHostname: async () => ["203.0.113.10"],
        fetchImpl: async () =>
          new Response("x".repeat(64), {
            status: 200,
            headers: { "Content-Length": "64" },
          }),
      },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toBe(
      "OpenAPI feed for Stripe is 64 bytes, over the 32-byte limit",
    );
  });

  it("accepts a spec at Stripe's real published size under the default cap", async () => {
    // Real Stripe spec3.json is 8,171,593 bytes (~7.79 MiB): under the new 32 MiB
    // default but well over the old 5 MiB cap that used to reject it.
    const filler = "x".repeat(8_171_593);
    const body = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Stripe", version: "2024-06-20", note: filler },
      paths: {},
    });
    const size = Buffer.byteLength(body, "utf8");
    expect(size).toBeGreaterThan(5 * 1024 * 1024); // over the retired 5 MiB cap
    expect(size).toBeLessThan(DEFAULT_FEED_MAX_BYTES); // under the new default
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        provider: "Stripe",
        resolveHostname: async () => ["203.0.113.10"],
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    );
    expect(response.ok).toBe(true);
    expect(response.versionLabel).toBe("2024-06-20");
  });

  it("still refuses a clearly abusive body far beyond the default cap", async () => {
    const abusive = 40 * 1024 * 1024; // 40 MiB, over the 32 MiB default
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        provider: "Hostile",
        resolveHostname: async () => ["203.0.113.10"],
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(abusive));
                controller.close();
              },
            }),
          ),
      },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toContain("Hostile");
    expect(response.error).toContain(
      `exceeds the ${DEFAULT_FEED_MAX_BYTES}-byte limit`,
    );
  });

  it("aborts remote reads that exceed the timeout", async () => {
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        timeoutMs: 5,
        resolveHostname: async () => ["203.0.113.10"],
        fetchImpl: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toContain("aborted");
  });

  it("accepts a bounded public HTTPS OpenAPI response", async () => {
    const body = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Remote", version: "1.2.3" },
      paths: {},
    });
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        resolveHostname: async () => ["203.0.113.10"],
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    );
    expect(response.ok).toBe(true);
    expect(response.versionLabel).toBe("1.2.3");
  });
});
