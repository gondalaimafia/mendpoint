import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPlatformSandboxRoutes } from "./platform-sandbox.js";

const JSON_HEADERS = { "content-type": "application/json" };

function request(body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  const app = createPlatformSandboxRoutes();
  return app.request("/", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("platform sandbox request boundary", () => {
  it("creates a bounded manifest and always removes the temporary workspace", async () => {
    const response = await request({
      files: { "src/index.ts": "export const value = 1;\n" },
      serviceBaseUrl: "https://service.example.com/v1",
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      root: string;
      serviceBaseUrl: string;
      disposed: boolean;
      runtimes: unknown[];
    };
    expect(body).toMatchObject({
      serviceBaseUrl: "https://service.example.com/v1",
      disposed: true,
    });
    expect(body.runtimes.length).toBeGreaterThan(0);
    expect(existsSync(body.root)).toBe(false);
  });

  it("requires JSON and a strict object schema", async () => {
    expect((await request({}, { "content-type": "text/plain" })).status).toBe(415);
    expect((await request("{")).status).toBe(422);
    expect((await request([])).status).toBe(422);
    expect((await request({ unexpected: true })).status).toBe(422);
    expect((await request({ files: [] })).status).toBe(422);
    expect((await request({ files: { "a.ts": 1 } })).status).toBe(422);
  });

  it("rejects declared and actual bodies above the byte limit", async () => {
    const declared = await request({}, {
      ...JSON_HEADERS,
      "content-length": String(1_048_577),
    });
    expect(declared.status).toBe(413);

    const actual = await request({ files: { "large.txt": "x".repeat(1_048_576) } });
    expect(actual.status).toBe(413);
  });

  it("bounds the file set, individual files, and aggregate bytes", async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`file-${index}.txt`, "x"]),
    );
    expect((await request({ files: tooMany })).status).toBe(422);
    expect(
      (await request({ files: { "large.txt": "x".repeat(262_145) } })).status,
    ).toBe(413);

    const aggregate = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `file-${index}.txt`,
        "x".repeat(220_000),
      ]),
    );
    expect((await request({ files: aggregate })).status).toBe(413);
  });

  it("rejects nonportable paths and unsafe service URLs", async () => {
    for (const path of ["../escape", "src\\escape.ts", "/absolute", "C:/absolute", "a//b", "./a"]) {
      expect((await request({ files: { [path]: "x" } })).status).toBe(422);
    }
    for (const serviceBaseUrl of [
      "file:///etc/passwd",
      "https://user:password@example.com",
      "not a url",
    ]) {
      expect((await request({ serviceBaseUrl })).status).toBe(422);
    }
  });

  it("preserves special object keys without prototype mutation", async () => {
    const response = await request('{"files":{"__proto__":"safe"}}');
    expect(response.status).toBe(200);
  });
});
