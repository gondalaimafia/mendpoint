import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  contentHash,
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
});
