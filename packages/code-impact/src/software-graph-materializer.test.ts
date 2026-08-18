import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex } from "@mendpoint/codebase-index";
import {
  getSoftwareGraphHead,
  openGraphLearnMemory,
  publishSoftwareGraphVersion,
  queryFettlerEndpointImpact,
} from "@mendpoint/graph-learn";
import { analyzeImpactWithSoftwareGraph, sdkContextFromSurfaces } from "./index.js";
import { materializeFettlerSoftwareGraph } from "./software-graph-materializer.js";
import type { ImpactableSurface } from "@mendpoint/shared";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function makeRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "fettler-software-graph-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", dependencies: { twilio: "4.0.0" } }));
  writeFileSync(join(dir, "src", "client.ts"), [
    'import twilio from "twilio";',
    "export async function sendMessage(to: string) {",
    '  return twilio.messages.create({ to, Body: "hello" });',
    "}",
  ].join("\n"));
  writeFileSync(join(dir, "src", "notifications.ts"), [
    'import { sendMessage } from "./client";',
    "export async function notifyUser(to: string) {",
    "  return sendMessage(to);",
    "}",
  ].join("\n"));
  writeFileSync(join(dir, "test", "notifications.test.ts"), [
    'import { notifyUser } from "../src/notifications";',
    "export async function testNotifyUser() {",
    '  return notifyUser("+15555550123");',
    "}",
  ].join("\n"));
  return dir;
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
  searchTokens: ["/v1/messages", "messages", "create", "Body", "body"],
};

describe("Fettler software graph materializer", () => {
  it("publishes an indirect provider endpoint to consumer test chain from a real code index", () => {
    const repoRoot = makeRepository();
    const index = buildIndex(repoRoot, { sdkContext: sdkContextFromSurfaces([surface]) });
    const publication = materializeFettlerSoftwareGraph({
      index,
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-a",
      repositoryRevision: "a".repeat(40),
      providerId: "twilio",
      providerSnapshotId: "twilio-openapi-2026-08-17",
      providerRevision: "2026-08-17",
      providerSdkPackage: "twilio",
      providerSdkVersion: "4.0.0",
      providerEndpointSurfaceCount: 1,
      endpoint: {
        canonicalKey: "POST /v1/messages",
        method: "POST",
        path: "/v1/messages",
        sdkMethodPaths: [],
        evidenceRefs: ["artifact:twilio-openapi:2026-08-17"],
      },
      observedAt: "2026-08-17T12:00:00.000Z",
      maxCallerHops: 4,
    });
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication);
    const impact = queryFettlerEndpointImpact(db, {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      graphVersionId: version.versionId,
      endpointKey: "POST /v1/messages",
      maxHops: 6,
      maxEntities: 50,
      maxRelationships: 100,
    });

    expect(impact.impact).toBe("impact");
    expect(impact.entities.some((entity) => entity.kind === "provider_sdk_method")).toBe(true);
    expect(impact.entities.some((entity) => entity.label === "sendMessage")).toBe(true);
    expect(impact.entities.some((entity) => entity.label === "notifyUser")).toBe(true);
    expect(impact.entities.some((entity) => entity.kind === "test" && entity.label === "testNotifyUser")).toBe(true);
    expect(impact.relationships.map((edge) => edge.kind).sort()).toEqual([
      "tests",
      "uses_endpoint",
      "uses_sdk_method",
      "wraps",
    ].sort());
    expect(impact.paths[0]).toHaveLength(5);
    expect(impact.coverage.basis).toBe("complete");
  });

  it("returns the existing impact report and a compact exact-version Fettler context together", async () => {
    const repoRoot = makeRepository();
    const db = openGraphLearnMemory();
    const result = await analyzeImpactWithSoftwareGraph(repoRoot, [surface], {
      graphDb: db,
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-a",
      providerId: "twilio",
      providerSnapshotId: "twilio-openapi-2026-08-17",
      providerRevision: "2026-08-17",
      providerSdkPackage: "twilio",
      providerSdkVersion: "4.0.0",
      observedAt: "2026-08-17T12:00:00.000Z",
      maxCallerHops: 4,
      maxContextBytes: 8_192,
    });

    expect(result.impactReport.sites.some((site) => site.symbol.includes("messages.create"))).toBe(true);
    expect(result.graphVersion.versionId).toBe(
      getSoftwareGraphHead(db, "tenant-a", "repo-a", "twilio")?.versionId,
    );
    expect(result.graphImpact.impact).toBe("impact");
    expect(result.context.content).toContain(result.graphVersion.versionId);
    expect(result.context.byteLength).toBeLessThanOrEqual(8_192);
  });

  it("reports partial provider coverage when one version contains additional endpoint surfaces", async () => {
    const repoRoot = makeRepository();
    const db = openGraphLearnMemory();
    const result = await analyzeImpactWithSoftwareGraph(repoRoot, [
      surface,
      { ...surface, id: "surface-calls", path: "/v1/calls" },
    ], {
      graphDb: db,
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-a",
      providerId: "twilio",
      providerSnapshotId: "twilio-openapi-2026-08-17",
      providerRevision: "2026-08-17",
      providerSdkPackage: "twilio",
      providerSdkVersion: "4.0.0",
      observedAt: "2026-08-17T12:00:00.000Z",
      maxCallerHops: 4,
      maxContextBytes: 8_192,
    });

    expect(result.graphImpact.coverage).toMatchObject({
      basis: "partial",
      reasons: expect.arrayContaining(["provider_specification:partial"]),
    });
  });

  it("publishes explicit reasons when a repository language is unsupported", async () => {
    const repoRoot = makeRepository();
    writeFileSync(join(repoRoot, "src", "legacy.rb"), "def legacy; end\n");
    const db = openGraphLearnMemory();

    const result = await analyzeImpactWithSoftwareGraph(repoRoot, [surface], {
      graphDb: db,
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      repositorySnapshotId: "snapshot-a",
      providerId: "twilio",
      providerSnapshotId: "twilio-openapi-2026-08-17",
      providerRevision: "2026-08-17",
      providerSdkPackage: "twilio",
      providerSdkVersion: "4.0.0",
      observedAt: "2026-08-17T12:00:00.000Z",
      maxCallerHops: 4,
      maxContextBytes: 8_192,
    });

    expect(result.graphImpact.coverage).toMatchObject({
      basis: "partial",
      reasons: expect.arrayContaining([
        "language_parsing:partial",
        "call_resolution:partial",
        "test_resolution:partial",
      ]),
    });
  });
});
