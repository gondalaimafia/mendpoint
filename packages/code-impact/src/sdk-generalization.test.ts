import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex } from "@mendpoint/codebase-index";
import type { ImpactableSurface } from "@mendpoint/shared";
import { analyzeRepo, discoverCandidates, sdkContextFromSurfaces } from "./index.js";

const tmpDirs: string[] = [];
function makeRepo(rel: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sdk-general-"));
  tmpDirs.push(dir);
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", dependencies: { twilio: "^4" } }),
    "utf8",
  );
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** A provider we have never baked into the scanner. */
function twilioSurfaces(): ImpactableSurface[] {
  return [
    {
      id: "t0",
      canonicalId: "twilio.POST./v1/messages.request_field_renamed.Body.body",
      kind: "request_field",
      op: "request_field_renamed",
      path: "/v1/messages",
      method: "post",
      field: "Body",
      fromField: "Body",
      toField: "body",
      severity: "breaking",
      migrationStrategy: "Rename Body → body",
      explanation: "Twilio renamed the message body field",
      searchTokens: ["/v1/messages", "messages", "post", "Body", "body"],
    },
  ];
}

const twilioSrc = [
  'import twilio from "twilio";',
  "export async function notify(to: string) {",
  '  return twilio.messages.create({ to, Body: "hi" });',
  "}",
].join("\n");

describe("provider-driven candidate discovery for an unseen provider", () => {
  it("finds SDK-call candidates after the change where the fixture-bound scanner found zero", () => {
    const dir = makeRepo("src/sms.ts", twilioSrc);
    const surfaces = twilioSurfaces();

    // Before: index built with no provider context — the fixture-bound path
    // produces no provider-surface SDK match for twilio.messages.create.
    const before = discoverCandidates(buildIndex(dir), surfaces);
    const beforeSdk = before.filter((c) => c.sources.includes("sdk_graph"));
    expect(beforeSdk.length).toBe(0);

    // After: context derived from the change under analysis drives detection.
    const ctx = sdkContextFromSurfaces(surfaces);
    const after = discoverCandidates(buildIndex(dir, { sdkContext: ctx }), surfaces);
    const afterSdk = after.filter((c) => c.sources.includes("sdk_graph"));
    expect(afterSdk.length).toBeGreaterThan(0);
    expect(afterSdk.some((c) => c.symbol.includes("messages.create"))).toBe(true);
  });

  it("analyzeRepo surfaces a high-confidence direct_call for the unseen provider", () => {
    const dir = makeRepo("src/sms.ts", twilioSrc);
    const surfaces = twilioSurfaces();
    const findings = analyzeRepo(dir, { entries: [], risk: "breaking", summary: "" }, { surfaces });
    const call = findings.find((f) => String(f.symbol).includes("messages.create"));
    expect(call).toBeDefined();
    expect(call!.impactType).toBe("direct_call");
    expect(call!.confidence).not.toBe("low");
  });

  it("distinguishes a general-heuristic usage from a provider-matched one", () => {
    // The consumer calls an unrelated helper chain that is not on the provider
    // surface but happens to share a token with it ("create").
    const dir = makeRepo(
      "src/mix.ts",
      [
        'import twilio from "twilio";',
        "export function run(audit: any) {",
        '  twilio.messages.create({ Body: "x" });',
        "  audit.records.create({});",
        "}",
      ].join("\n"),
    );
    const surfaces: ImpactableSurface[] = [
      {
        ...twilioSurfaces()[0]!,
        searchTokens: ["messages", "create", "Body", "body"],
      },
    ];
    const ctx = sdkContextFromSurfaces(surfaces);
    const candidates = discoverCandidates(buildIndex(dir, { sdkContext: ctx }), surfaces);

    const provider = candidates.find((c) => c.symbol.includes("twilio.messages.create"));
    const heuristic = candidates.find((c) => c.symbol.includes("audit.records.create"));
    expect(provider?.sources).toContain("sdk_graph");
    expect(provider?.initialConfidence).not.toBe("low");
    // The off-surface chain is only ever a low-confidence string_heuristic, never sdk_graph.
    if (heuristic) {
      expect(heuristic.sources).not.toContain("sdk_graph");
      expect(heuristic.initialConfidence).toBe("low");
    }
  });
});
