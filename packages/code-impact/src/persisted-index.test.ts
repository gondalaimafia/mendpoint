import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openGraphLearnMemory } from "@mendpoint/graph-learn";
import type { ImpactableSurface } from "@mendpoint/shared";
import { analyzeImpact, analyzeImpactWithSoftwareGraph } from "./index.js";

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-persisted-impact-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "consumer",
    dependencies: { twilio: "4.0.0" },
  }));
  writeFileSync(join(root, "src", "client.ts"), [
    'import twilio from "twilio";',
    "export async function sendMessage(to: string) {",
    '  return twilio.messages.create({ to, Body: "hello" });',
    "}",
  ].join("\n"));
  return root;
}

const surface: ImpactableSurface = {
  id: "surface-message",
  canonicalId: "twilio.POST./v1/messages.request_field_renamed.Body.body",
  kind: "request_field",
  op: "request_field_renamed",
  path: "/v1/messages",
  method: "post",
  field: "Body",
  fromField: "Body",
  toField: "body",
  severity: "breaking",
  migrationStrategy: "Rename Body to body",
  explanation: "Twilio renamed the message body field",
  searchTokens: ["/v1/messages", "messages.create", "Body", "body"],
};

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("persisted index production entrypoints", () => {
  it("reuses exact and incremental authority with output equivalent to a fresh build", async () => {
    const repoRoot = repository();
    const authority = { tenantId: "tenant-a", repositoryId: "repo-a" };
    const classifications: string[] = [];
    const options = {
      persistIndex: true,
      indexAuthority: authority,
      onIndexMaterialized: (evidence: { classification: string }) =>
        classifications.push(evidence.classification),
    };

    const rebuilt = await analyzeImpact(repoRoot, [surface], options);
    const exact = await analyzeImpact(repoRoot, [surface], options);
    writeFileSync(join(repoRoot, "src", "client.ts"), [
      'import twilio from "twilio";',
      "export async function sendMessage(to: string) {",
      '  return twilio.messages.create({ to, Body: "updated" });',
      "}",
    ].join("\n"));
    const incremental = await analyzeImpact(repoRoot, [surface], options);
    const fresh = await analyzeImpact(repoRoot, [surface], { persistIndex: false });

    expect(classifications).toEqual(["rebuilt", "exact", "incremental"]);
    expect(exact).toEqual(rebuilt);
    expect(incremental).toEqual(fresh);
  });

  it("makes the software-graph entrypoint reuse the same authority-bound index", async () => {
    const repoRoot = repository();
    const authority = { tenantId: "tenant-a", repositoryId: "repo-a" };
    await analyzeImpact(repoRoot, [surface], { persistIndex: true, indexAuthority: authority });
    const graphDb = openGraphLearnMemory();
    try {
      const result = await analyzeImpactWithSoftwareGraph(repoRoot, [surface], {
        graphDb,
        ...authority,
        providerId: "twilio",
        providerSnapshotId: "twilio-openapi-2026-08-27",
        providerRevision: "2026-08-27",
        providerSdkPackage: "twilio",
        providerSdkVersion: "4.0.0",
        observedAt: "2026-08-27T00:00:00.000Z",
        maxCallerHops: 4,
        maxContextBytes: 32_768,
        impact: { persistIndex: true },
      });
      expect(result.indexReuse).toMatchObject({
        classification: "exact",
        tenantId: "tenant-a",
        repositoryId: "repo-a",
      });
      expect(result.impactReport.sites.length).toBeGreaterThan(0);
    } finally {
      graphDb.raw.close();
    }
  });
});
