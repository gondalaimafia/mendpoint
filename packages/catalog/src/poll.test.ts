import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createSecureContext } from "node:tls";
import {
  contentHash,
  DEFAULT_FEED_MAX_BYTES,
  extractVersionLabel,
  fetchOpenApiDocument,
  listCatalogFeeds,
  pinnedRemoteRequest,
  resolveFeedUrl,
} from "./poll.js";

function existingTlsFixture(): { cert: string; key: string } {
  const source = readFileSync(
    join(process.cwd(), "..", "..", "apps", "web", "app", "api", "saml", "saml-fixtures.ts"),
    "utf8",
  );
  const extract = (name: string) => {
    const match = source.match(new RegExp("export const " + name + " = `([\\s\\S]*?)`;"));
    if (!match?.[1]) throw new Error(`missing TLS fixture ${name}`);
    return match[1];
  };
  return { cert: extract("IDP_CERT_PEM"), key: extract("IDP_PRIVATE_KEY_PEM") };
}

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
          trustedTestOnlyPinnedFetchImpl: async () => {
            throw new Error("blocked destination was fetched");
          },
        },
      );
      expect(response.ok, address).toBe(false);
      expect(response.error, address).toContain("blocked address");
    }
  });

  it("rejects the complete DNS answer set when any record is unsafe", async () => {
    for (const addresses of [
      ["203.0.113.10", "127.0.0.1"],
      ["203.0.113.10", "fe80::1%eth0"],
      ["203.0.113.10", "not-an-address"],
      ["203.0.113.10", "::ffff:203.0.113.10"],
    ]) {
      let fetched = false;
      const response = await fetchOpenApiDocument("https://feed.example/spec.json", {
        production: true,
        resolveHostname: async () => addresses,
        trustedTestOnlyPinnedFetchImpl: async () => {
          fetched = true;
          return new Response("unsafe");
        },
      });
      expect(response.error, addresses.join(",")).toContain("blocked address");
      expect(fetched, addresses.join(",")).toBe(false);
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
        trustedTestOnlyPinnedFetchImpl: async (input) => {
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

  it("connects through the address approved by the single DNS decision", async () => {
    let resolutions = 0;
    const connected: string[] = [];
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        resolveHostname: async () => {
          resolutions++;
          return resolutions === 1 ? ["203.0.113.10"] : ["127.0.0.1"];
        },
        trustedTestOnlyPinnedFetchImpl: async (input, approvedAddress) => {
          connected.push(`${new URL(input).hostname}=${approvedAddress}`);
          return new Response(JSON.stringify({
            openapi: "3.1.0",
            info: { title: "Pinned", version: "1" },
            paths: {},
          }));
        },
      },
    );

    expect(response.ok).toBe(true);
    expect(resolutions).toBe(1);
    expect(connected).toEqual(["feed.example=203.0.113.10"]);
  });

  it("uses the pinned native socket while preserving the original Host header", async () => {
    let observedHost: string | undefined;
    const server = createServer((request, response) => {
      observedHost = request.headers.host;
      response.end("pinned-body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const response = await pinnedRemoteRequest(
        new URL(`http://original-host.invalid:${address.port}/feed`),
        "127.0.0.1",
      );
      expect(await response.text()).toBe("pinned-body");
      expect(observedHost).toBe(`original-host.invalid:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("uses a fresh pinned native socket for sequential requests", async () => {
    const sockets = new Set<object>();
    const server = createServer((request, response) => {
      sockets.add(request.socket);
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const url = new URL(`http://original-host.invalid:${address.port}/feed`);
      expect(await (await pinnedRemoteRequest(url, "127.0.0.1")).text()).toBe("ok");
      expect(await (await pinnedRemoteRequest(url, "127.0.0.1")).text()).toBe("ok");
      expect(sockets.size).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("handles native null-body statuses without leaking the response stream", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const response = await pinnedRemoteRequest(
        new URL(`http://original-host.invalid:${address.port}/feed`),
        "127.0.0.1",
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("preserves HTTPS SNI and validates the original hostname certificate", async () => {
    const fixture = existingTlsFixture();
    const directory = mkdtempSync(join(tmpdir(), "poll-tls-"));
    const certificatePath = join(directory, "trusted-test-ca.pem");
    writeFileSync(certificatePath, fixture.cert, "utf8");
    let observedServername: string | undefined;
    const server = createHttpsServer({
      key: fixture.key,
      cert: fixture.cert,
      SNICallback(servername, callback) {
        observedServername = servername;
        callback(null, createSecureContext({ key: fixture.key, cert: fixture.cert }));
      },
    }, (_request, response) => response.end("must-not-be-trusted-for-foreign-host"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const moduleUrl = pathToFileURL(join(process.cwd(), "src", "poll.ts")).href;
      const script = `
        const { pinnedRemoteRequest } = await import(${JSON.stringify(moduleUrl)});
        try {
          await pinnedRemoteRequest(new URL(${JSON.stringify(`https://original-host.invalid:${address.port}/feed`)}), "127.0.0.1");
          process.exitCode = 2;
        } catch (cause) {
          if (cause?.code !== "ERR_TLS_CERT_ALTNAME_INVALID") {
            console.error(cause?.code ?? cause?.message ?? String(cause));
            process.exitCode = 3;
          }
        }
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let errorOutput = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(errorOutput).toBe("");
      expect(exitCode).toBe(0);
      expect(observedServername).toBe("original-host.invalid");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("cancels unread redirect bodies for missing locations and redirect exhaustion", async () => {
    let canceled = 0;
    const redirectBody = () => new ReadableStream({ cancel: () => { canceled++; } });
    const missing = await fetchOpenApiDocument("https://feed.example/spec.json", {
      production: true,
      resolveHostname: async () => ["203.0.113.10"],
      trustedTestOnlyPinnedFetchImpl: async () => new Response(redirectBody(), { status: 302 }),
    });
    expect(missing.error).toContain("missing location");
    expect(canceled).toBe(1);

    const exhausted = await fetchOpenApiDocument("https://feed.example/spec.json", {
      production: true,
      resolveHostname: async () => ["203.0.113.10"],
      trustedTestOnlyPinnedFetchImpl: async () => new Response(redirectBody(), {
        status: 307,
        headers: { Location: "/again" },
      }),
    });
    expect(exhausted.error).toBe("too many feed redirects");
    expect(canceled).toBe(7);
  });

  it("does not reinterpret non-redirect 3xx statuses", async () => {
    let calls = 0;
    const result = await fetchOpenApiDocument("https://feed.example/spec.json", {
      production: true,
      resolveHostname: async () => ["203.0.113.10"],
      trustedTestOnlyPinnedFetchImpl: async () => {
        calls++;
        return new Response("not a redirect", { status: 306 });
      },
    });
    expect(result.error).toBe("HTTP 306");
    expect(calls).toBe(1);
  });

  it("times out while DNS approval is still pending", async () => {
    const result = await fetchOpenApiDocument("https://feed.example/spec.json", {
      production: true,
      timeoutMs: 5,
      resolveHostname: async () => new Promise<string[]>(() => undefined),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("feed request timed out");
  });

  it("shares one overall timeout across multiple delayed redirects", async () => {
    const timeoutMs = 130;
    let calls = 0;
    const startedAt = performance.now();
    const result = await fetchOpenApiDocument("https://feed.example/spec.json", {
      production: true,
      timeoutMs,
      resolveHostname: async () => ["203.0.113.10"],
      trustedTestOnlyPinnedFetchImpl: async (input, _address, init) => {
        calls++;
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal;
          let settled = false;
          const finish = (complete: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            complete();
          };
          const onAbort = () => finish(() => reject(signal?.reason));
          const timer = setTimeout(() => finish(resolve), 55);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
        return calls < 3
          ? new Response(null, { status: 302, headers: { Location: new URL(`/hop-${calls}`, input).href } })
          : new Response(JSON.stringify({ openapi: "3.1.0", info: {}, paths: {} }));
      },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("feed request timed out");
    expect(calls).toBe(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 30);
    expect(elapsedMs).toBeLessThan(timeoutMs + 90);
  });

  it.each(["gzip", "br"])("requests identity encoding and rejects %s responses", async (encoding) => {
    let acceptEncoding: string | null = null;
    const result = await fetchOpenApiDocument("https://feed.example/spec.json", {
      production: true,
      resolveHostname: async () => ["203.0.113.10"],
      trustedTestOnlyPinnedFetchImpl: async (_url, _address, init) => {
        acceptEncoding = new Headers(init?.headers).get("accept-encoding");
        return new Response("encoded", { headers: { "Content-Encoding": encoding } });
      },
    });
    expect(acceptEncoding).toBe("identity");
    expect(result.error).toBe("feed response content encoding is unsupported");
  });

  it("caps streamed remote responses", async () => {
    const response = await fetchOpenApiDocument(
      "https://feed.example/spec.json",
      {
        production: true,
        maxBytes: 32,
        resolveHostname: async () => ["203.0.113.10"],
        trustedTestOnlyPinnedFetchImpl: async () =>
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
        trustedTestOnlyPinnedFetchImpl: async () =>
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
        trustedTestOnlyPinnedFetchImpl: async () =>
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
        trustedTestOnlyPinnedFetchImpl: async () =>
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
        trustedTestOnlyPinnedFetchImpl: async (_input, _approvedAddress, init) =>
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
        trustedTestOnlyPinnedFetchImpl: async () =>
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
