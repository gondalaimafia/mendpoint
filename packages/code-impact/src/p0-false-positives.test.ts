import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ImpactableSurface } from "@mendpoint/shared";
import { analyzeImpact, detectVendoredFiles } from "./index.js";
import { buildIndex } from "@mendpoint/codebase-index";

const tmpDirs: string[] = [];
function makeRepo(files: Record<string, string>, rootName = "consumer"): string {
  const dir = mkdtempSync(join(tmpdir(), "p0fp-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: rootName }), "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function renameSurfaces(): ImpactableSurface[] {
  return [
    {
      id: "s0",
      canonicalId: "acmepay.POST./charges.request_field_renamed.source.payment_method",
      kind: "request_field",
      op: "request_field_renamed",
      path: "/charges",
      method: "post",
      field: "payment_method",
      fromField: "source",
      toField: "payment_method",
      severity: "breaking",
      migrationStrategy: "Rename source → payment_method",
      explanation: "renamed",
      searchTokens: ["/charges", "source", "payment_method", "charges"],
    },
  ];
}

describe("P0: vendored third-party SDK copy is not an edit target", () => {
  it("surfaces the vendored copy as a vendored reference, not a confident site", async () => {
    const dir = makeRepo({
      // A committed copy of the provider's own SDK: its own package manifest
      // declares a foreign package name, and first-party code imports *into* it
      // by a relative path.
      "vendor/acmepay-sdk/package.json": JSON.stringify({
        name: "acmepay-sdk",
        version: "3.1.0",
        main: "index.js",
      }),
      "vendor/acmepay-sdk/index.js":
        "export function createCharge(body) {\n  const { amount, currency, source } = body;\n  return { id: 'ch', amount, currency, source };\n}\n",
      "src/pay.js":
        'import { createCharge } from "../vendor/acmepay-sdk/index.js";\nexport function pay({ amount, currency, source }) {\n  return createCharge({ amount, currency, source });\n}\n',
    });

    const report = await analyzeImpact(dir, renameSurfaces(), {
      useLlm: false,
      minConfidence: "medium",
    });
    const sitePaths = report.sites.map((s) => s.filePath);
    const vendoredPaths = (report.vendoredReferences ?? []).map((v) => v.filePath);
    const lowPaths = report.lowConfidenceNotifications.map((s) => s.filePath);

    // First-party code is migrated.
    expect(sitePaths).toContain("src/pay.js");
    // The vendored copy is never an edit target...
    expect(sitePaths).not.toContain("vendor/acmepay-sdk/index.js");
    // ...but it is surfaced (update from upstream), not silently dropped...
    expect(vendoredPaths).toContain("vendor/acmepay-sdk/index.js");
    // ...and not smuggled into the low-confidence bucket either.
    expect(lowPaths).not.toContain("vendor/acmepay-sdk/index.js");
  });

  it("narrowing: a tracked vendor/ file that is NOT third-party stays analysable", async () => {
    // A committed `vendor/` tree with no foreign package manifest — first-party
    // source that merely lives under a directory named `vendor/`. It must not be
    // mistaken for a vendored dependency.
    const dir = makeRepo({
      "vendor/payments/client.js":
        'import fetch from "node-fetch";\nexport function createCharge({ source }) {\n  return fetch("/v1/charges", { body: JSON.stringify({ source }) });\n}\n',
      "src/app.js":
        'import { createCharge } from "../vendor/payments/client.js";\nexport const run = ({ source }) => createCharge({ source });\n',
    });

    const index = buildIndex(dir);
    expect([...detectVendoredFiles(index)]).toHaveLength(0);

    const report = await analyzeImpact(dir, renameSurfaces(), {
      useLlm: false,
      minConfidence: "medium",
    });
    const vendoredPaths = (report.vendoredReferences ?? []).map((v) => v.filePath);
    expect(vendoredPaths).not.toContain("vendor/payments/client.js");
    // It is ordinary source: analysed and flagged, not excluded.
    expect(report.sites.map((s) => s.filePath)).toContain("vendor/payments/client.js");
  });
});

describe("P0: a field name inside a log string is not a call site", () => {
  it("demotes a string/comment-only mention while keeping the real client site", async () => {
    const dir = makeRepo({
      // Client wrapper: real HTTP path anchors provenance; real code reference to
      // the field.
      "lib/paymentsClient.js":
        'import { transport } from "./transport.js";\nexport function createCharge(p) {\n  return transport.post("/v1/charges", { source: p.source });\n}\n',
      "lib/transport.js": "export const transport = { post: (u, b) => ({ u, b }) };\n",
      // Bootstrap entry point: transitively imports the client (so it is
      // provider-reachable) but only mentions the word "source" in a log string
      // and a comment — never as a field reference.
      "bin/server.js":
        'import { createCharge } from "../lib/paymentsClient.js";\n// The word "source" here is the config origin, not a payment field.\nexport function main(env) {\n  console.log("loaded configuration source for environment " + env);\n  return createCharge({ source: env.token });\n}\n',
    });

    const report = await analyzeImpact(dir, renameSurfaces(), {
      useLlm: false,
      minConfidence: "medium",
    });
    const sitePaths = report.sites.map((s) => s.filePath);
    const lowPaths = report.lowConfidenceNotifications.map((s) => s.filePath);

    // The real client site is flagged.
    expect(sitePaths).toContain("lib/paymentsClient.js");
    // The bootstrap file references `source` in real code (createCharge call),
    // so it is legitimately flagged — but a file whose ONLY mention is prose is
    // not. Verify the prose-only file below.
    const proseDir = makeRepo({
      "lib/paymentsClient.js":
        'import { transport } from "./transport.js";\nexport function createCharge(p) {\n  return transport.post("/v1/charges", { source: p.source });\n}\n',
      "lib/transport.js": "export const transport = { post: (u, b) => ({ u, b }) };\n",
      // Boots the app; the only "source" is inside a log string and a comment.
      "bin/boot.js":
        'import { createCharge } from "./paymentsClient.js";\n// diagnostic banner: the config "source", not a payment field\nexport function boot(env) {\n  console.log("loaded configuration source for environment " + env);\n  return createCharge({ token: env.token });\n}\n',
    });
    const proseReport = await analyzeImpact(proseDir, renameSurfaces(), {
      useLlm: false,
      minConfidence: "medium",
    });
    const proseSites = proseReport.sites.map((s) => s.filePath);
    const proseLow = proseReport.lowConfidenceNotifications.map((s) => s.filePath);
    expect(proseSites).toContain("lib/paymentsClient.js");
    expect(proseSites).not.toContain("bin/boot.js");
    // Not dropped — an honest low-confidence notification a reviewer can see.
    expect(proseLow).toContain("bin/boot.js");
    // Silence the unused-binding lint on lowPaths for the first report.
    expect(Array.isArray(lowPaths)).toBe(true);
  });
});

describe("P0: a comment-only reference in a reachable file is still flagged", () => {
  it("keeps the deep-indirection leaf whose only mention is a comment (gate off)", async () => {
    // A relative-import chain with no provider HTTP path and no provider package
    // import: provenance gating cannot be established, so token matches (incl.
    // comments) still count — recall must not degrade.
    const dir = makeRepo({
      "src/app/order.js":
        'import { createCharge } from "../shared/facade.js";\nexport function placeOrder({ source }) {\n  return createCharge({ source });\n}\n',
      "src/shared/facade.js":
        'import { charge } from "../vendor-sdk/acmepay.js";\nexport function createCharge({ source }) {\n  return charge({ source });\n}\n',
      // Leaf provider SDK layer: the field appears ONLY in comments here.
      "src/vendor-sdk/acmepay.js":
        "// Provider SDK. Accepts the raw provider body with `source`.\nexport function charge(body) {\n  // body: { amount, currency, source }\n  return { id: 'ch', ...body };\n}\n",
    });

    const report = await analyzeImpact(dir, renameSurfaces(), {
      useLlm: false,
      minConfidence: "medium",
    });
    const sitePaths = report.sites.map((s) => s.filePath);
    expect(sitePaths).toContain("src/app/order.js");
    expect(sitePaths).toContain("src/shared/facade.js");
    // The comment-only leaf is still flagged: no anchor means no gate, so the
    // token match is honoured.
    expect(sitePaths).toContain("src/vendor-sdk/acmepay.js");
  });
});
