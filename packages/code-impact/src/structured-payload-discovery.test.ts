import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex } from "@mendpoint/codebase-index";
import type { ImpactableSurface } from "@mendpoint/shared";
import { computeProviderReachability, discoverCandidates, sdkContextFromSurfaces } from "./index.js";

const tmpDirs: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fettler-structured-payload-"));
  tmpDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(dir, relativePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function surfaces(): ImpactableSurface[] {
  const base = {
    canonicalId: "meridian.POST./v1/charges.request_field_renamed.source.payment_method",
    kind: "request_field" as const,
    op: "request_field_renamed" as const,
    path: "/v1/charges",
    method: "post",
    fromField: "source",
    toField: "payment_method",
    severity: "breaking" as const,
    migrationStrategy: "Rename source to payment_method",
    explanation: "Provider wire field renamed",
    searchTokens: ["/v1/charges", "charges", "source", "payment_method"],
  };
  return [
    { ...base, id: "request-source" },
    { ...base, id: "response-source", kind: "response_field", op: "response_field_removed" },
  ];
}

describe("structured payload discovery", () => {
  it("finds exact renamed keys in bounded JSON fixtures without promoting unrelated JSON", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ name: "consumer" }),
      "src/payments.ts": [
        'import meridian from "meridian";',
        'export const endpoint = "/v1/charges";',
        "export const charge = (source: string) => meridian.charges.create({ source });",
      ].join("\n"),
      "tests/fixtures/charge.json": JSON.stringify({ id: "ch_1", source: "tok_1" }, null, 2),
      "tests/fixtures/nested-response.json": JSON.stringify({ data: [{ source: "tok_2" }] }, null, 2),
      "tests/fixtures/malformed.json": '{ "source": ',
      "config/source.json": JSON.stringify({ source: "operator" }, null, 2),
      "spec/openapi.json": JSON.stringify({ openapi: "3.1.0", source: "schema" }, null, 2),
    });
    const changeSurfaces = surfaces();
    const index = buildIndex(repo, { sdkContext: sdkContextFromSurfaces(changeSurfaces) });
    const candidates = discoverCandidates(
      index,
      changeSurfaces,
      computeProviderReachability(index, changeSurfaces),
    );
    const promotable = candidates
      .filter((candidate) => candidate.initialConfidence !== "low")
      .map((candidate) => candidate.filePath);

    expect(promotable).toContain("tests/fixtures/charge.json");
    expect(promotable).toContain("tests/fixtures/nested-response.json");
    expect(promotable).not.toContain("tests/fixtures/malformed.json");
    expect(promotable).not.toContain("config/source.json");
    expect(promotable).not.toContain("spec/openapi.json");
  });

  it("admits fixtures on structural evidence in directory names absent from the corpus", () => {
    // None of these directory names (golden/, stubs/, wire-samples/) appear in
    // the synthetic corpus, so a directory-name allowlist would reject them all.
    // Each is admitted here only because the index shows something referencing it.
    const repo = makeRepo({
      "package.json": JSON.stringify({ name: "consumer" }),
      "src/payments.ts": [
        'import meridian from "meridian";',
        'export const endpoint = "/v1/charges";',
        "export const charge = (source: string) => meridian.charges.create({ source });",
      ].join("\n"),
      // (a) code sibling in the same directory -> proximity admission.
      "golden/loader.ts": 'export const load = () => require("./charge.json");',
      "golden/charge.json": JSON.stringify({ source: "tok_g" }, null, 2),
      // (b) a source file imports the payload directly -> import-edge admission.
      "src/consumer.ts": 'import refund from "../stubs/refund.json";\nexport const r = refund;',
      "stubs/refund.json": JSON.stringify({ source: "tok_s" }, null, 2),
      // (c) code in the enclosing package directory -> package-proximity admission.
      "src/wire/handler.ts": "export const handle = (x: string) => x;",
      "src/wire/wire-samples/entry.json": JSON.stringify({ source: "tok_w" }, null, 2),
    });
    const changeSurfaces = surfaces();
    const index = buildIndex(repo, { sdkContext: sdkContextFromSurfaces(changeSurfaces) });
    const candidates = discoverCandidates(
      index,
      changeSurfaces,
      computeProviderReachability(index, changeSurfaces),
    );
    const promotable = candidates
      .filter((candidate) => candidate.initialConfidence !== "low")
      .map((candidate) => candidate.filePath);

    expect(promotable).toContain("golden/charge.json");
    expect(promotable).toContain("stubs/refund.json");
    expect(promotable).toContain("src/wire/wire-samples/entry.json");
  });

  it("does not admit an unreferenced JSON that merely sits in resources/ or examples/", () => {
    // Java/Spring keep PRODUCTION config under resources/; a name-based rule
    // sweeps it in. With nothing referencing it and no code beside it, it must
    // stay out even though it carries the changed wire key.
    const repo = makeRepo({
      "package.json": JSON.stringify({ name: "consumer" }),
      "src/main/java/com/acme/App.java":
        "package com.acme;\npublic class App { public static void main(String[] a) {} }\n",
      "src/main/resources/application.json": JSON.stringify({ source: "prod-config" }, null, 2),
      "examples/config.json": JSON.stringify({ source: "example" }, null, 2),
    });
    const changeSurfaces = surfaces();
    const index = buildIndex(repo, { sdkContext: sdkContextFromSurfaces(changeSurfaces) });
    const candidates = discoverCandidates(
      index,
      changeSurfaces,
      computeProviderReachability(index, changeSurfaces),
    );
    const promotable = candidates
      .filter((candidate) => candidate.initialConfidence !== "low")
      .map((candidate) => candidate.filePath);

    expect(promotable).not.toContain("src/main/resources/application.json");
    expect(promotable).not.toContain("examples/config.json");
  });

  it("reads each indexed file at most once across multiple surfaces", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ name: "consumer" }),
      "src/payments.ts": [
        'import meridian from "meridian";',
        'export const endpoint = "/v1/charges";',
        "export const charge = (source: string) => meridian.charges.create({ source });",
      ].join("\n"),
      "src/service.ts": "export const payload = { source: 'tok_1' };",
      "tests/fixtures/charge.json": JSON.stringify({ source: "tok_1" }),
    });
    const changeSurfaces = surfaces();
    const index = buildIndex(repo, { sdkContext: sdkContextFromSurfaces(changeSurfaces) });
    const reads = new Map<string, number>();
    discoverCandidates(
      index,
      changeSurfaces,
      computeProviderReachability(index, changeSurfaces),
      {
        readFile: (absolutePath) => {
          reads.set(absolutePath, (reads.get(absolutePath) ?? 0) + 1);
          return readFileSync(absolutePath, "utf8");
        },
      },
    );

    expect(reads.size).toBeGreaterThan(0);
    expect(Math.max(...reads.values())).toBe(1);
  });
});
