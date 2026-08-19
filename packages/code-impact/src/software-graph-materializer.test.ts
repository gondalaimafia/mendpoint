import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function makeRepositoryFromFiles(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "fettler-software-graph-adversarial-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", dependencies: { twilio: "4.0.0" } }),
  );
  for (const [path, content] of Object.entries(files)) {
    const destination = join(dir, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return dir;
}

function materialize(repoRoot: string, index = buildIndex(repoRoot, {
  sdkContext: sdkContextFromSurfaces([surface]),
})) {
  return materializeFettlerSoftwareGraph({
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
  it("publishes a function that is both a direct SDK user and an indirect caller without canonical-key collision", () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/client.ts": [
        'import twilio from "twilio";',
        "export async function sendMessage(to: string) {",
        '  return twilio.messages.create({ to, Body: "hello" });',
        "}",
      ].join("\n"),
      "src/notifications.ts": [
        'import twilio from "twilio";',
        'import { sendMessage } from "./client";',
        "export async function notifyUser(to: string) {",
        "  await sendMessage(to);",
        '  return twilio.messages.create({ to, Body: "again" });',
        "}",
      ].join("\n"),
    });

    const publication = materialize(repoRoot);
    const db = openGraphLearnMemory();
    expect(() => publishSoftwareGraphVersion(db, publication)).not.toThrow();
    const notify = publication.entities.filter((entity) => entity.label === "notifyUser");
    expect(notify.map((entity) => entity.kind).sort()).toEqual([
      "function",
      "internal_sdk_method",
    ]);
    expect(new Set(notify.map((entity) => entity.canonicalKey)).size).toBe(2);
    db.raw.close();
  });

  it("models a test helper calling another test helper as a call rather than an invalid tests edge", () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/client.ts": [
        'import twilio from "twilio";',
        "export async function sendMessage(to: string) {",
        '  return twilio.messages.create({ to, Body: "hello" });',
        "}",
      ].join("\n"),
      "test/helpers.ts": [
        'import { sendMessage } from "../src/client";',
        "export async function sendFixture() { return sendMessage(\"+15555550123\"); }",
      ].join("\n"),
      "test/messages.test.ts": [
        'import { sendFixture } from "./helpers";',
        "export async function testSend() { return sendFixture(); }",
      ].join("\n"),
    });

    const publication = materialize(repoRoot);
    const db = openGraphLearnMemory();
    expect(() => publishSoftwareGraphVersion(db, publication)).not.toThrow();
    expect(publication.relationships.some((edge) => edge.kind === "calls")).toBe(true);
    db.raw.close();
  });

  it("reports unattributed module-scope SDK usages as incomplete call resolution", () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/client.ts": [
        'import twilio from "twilio";',
        'export const welcome = twilio.messages.create({ to: "+15555550123", Body: "hello" });',
      ].join("\n"),
    });

    const publication = materialize(repoRoot);
    const callResolution = publication.coverage.find((stage) => stage.stage === "call_resolution");
    expect(callResolution).toMatchObject({
      basis: "partial",
      reasons: expect.arrayContaining(["sdk_usage_not_attributed_to_function"]),
    });
    expect(callResolution?.omitted).toBeGreaterThanOrEqual(1);
  });

  it("never treats absent incremental diagnostics or skipped discovery directories as complete coverage", () => {
    const repoRoot = makeRepository();
    const complete = buildIndex(repoRoot, { sdkContext: sdkContextFromSurfaces([surface]) });
    const index = {
      ...complete,
      callGraph: { ...complete.callGraph, diagnostics: undefined },
      skippedDirectories: [{ path: "generated", reason: "policy_skip" }],
    };

    const publication = materialize(repoRoot, index);
    expect(publication.coverage.find((stage) => stage.stage === "repository_discovery")).toMatchObject({
      basis: "partial",
      omitted: 1,
    });
    for (const stage of ["language_parsing", "call_resolution", "test_resolution"] as const) {
      expect(publication.coverage.find((candidate) => candidate.stage === stage)).toMatchObject({
        basis: "not_analyzed",
        analyzed: 0,
        reasons: expect.arrayContaining(["call_graph_diagnostics_unavailable"]),
      });
    }
  });

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

  it("keeps the analysed endpoint's provider coverage complete when the diff also touches sibling endpoints", async () => {
    const repoRoot = makeRepository();
    const index = buildIndex(repoRoot, { sdkContext: sdkContextFromSurfaces([surface]) });
    // The graph materializes exactly the ONE endpoint it was asked about, and the
    // impact query targets that endpoint by key. A sibling endpoint changed in the
    // same diff (providerEndpointSurfaceCount > 1) is a separate query's concern,
    // not a gap in THIS endpoint's provider-specification coverage.
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
      providerEndpointSurfaceCount: 3,
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
    const providerStage = publication.coverage.find(
      (stage) => stage.stage === "provider_specification",
    );
    expect(providerStage).toMatchObject({ basis: "complete", omitted: 0 });
    expect(providerStage?.reasons).toBeUndefined();

    // End to end, the sibling surfaces do not push the query for the analysed
    // endpoint to partial via a provider_specification gap.
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
    expect(result.graphImpact.coverage.reasons).not.toContain("provider_specification:partial");
    db.raw.close();
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

  it("treats a .git working tree as complete discovery scope and still publishes", () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/app.ts": [
        "export function unrelated(x: number) {",
        "  return x + 1;",
        "}",
      ].join("\n"),
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/config": "[core]\n\trepositoryformatversion = 0\n",
    });
    const index = buildIndex(repoRoot, { sdkContext: sdkContextFromSurfaces([surface]) });
    // The walker records the deliberate `.git` prune as scope...
    expect(index.skippedDirectories.some((entry) => entry.reason === "ignored_name:.git")).toBe(true);

    const publication = materialize(repoRoot, index);
    const discovery = publication.coverage.find((stage) => stage.stage === "repository_discovery");
    // ...and that prune is correct scope, not a coverage gap, so discovery is
    // complete (previously every git working tree was permanently `partial`).
    expect(discovery).toMatchObject({ basis: "complete", omitted: 0 });
    expect(discovery?.reasons).toBeUndefined();

    const db = openGraphLearnMemory();
    expect(() => publishSoftwareGraphVersion(db, publication)).not.toThrow();
    db.raw.close();
  });

  it("keeps a genuinely omitted directory as a partial gap, distinct from a deliberate prune", () => {
    const repoRoot = makeRepository();
    const base = buildIndex(repoRoot, { sdkContext: sdkContextFromSurfaces([surface]) });
    const index = {
      ...base,
      skippedDirectories: [
        { path: ".git", reason: "ignored_name:.git" }, // deliberate: scope, not a gap
        { path: "generated", reason: "unreadable_directory" }, // genuine: could not read
      ],
    };

    const publication = materialize(repoRoot, index);
    const discovery = publication.coverage.find((stage) => stage.stage === "repository_discovery");
    // Only the genuine gap survives into the coverage determination and reasons.
    expect(discovery).toMatchObject({ basis: "partial", omitted: 1 });
    expect(discovery?.reasons).toEqual(["skipped_directory:unreadable_directory"]);
  });

  it("folds two matched SDK call sites in one function into a single entity carrying both lines", () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/client.ts": [
        'import twilio from "twilio";',
        "export async function syncMessages(to: string) {",
        "  const existing = await twilio.messages.list({ to });",
        '  await twilio.messages.create({ to, Body: "hello" });',
        "  return existing;",
        "}",
      ].join("\n"),
    });

    const publication = materialize(repoRoot);
    const db = openGraphLearnMemory();
    // On origin/main this threw software_graph_materializer_entity_collision.
    expect(() => publishSoftwareGraphVersion(db, publication)).not.toThrow();
    const internal = publication.entities.filter(
      (entity) => entity.kind === "internal_sdk_method" && entity.label === "syncMessages",
    );
    expect(internal).toHaveLength(1);
    const lines = internal[0]!.evidenceRefs
      .filter((ref) => ref.includes("src/client.ts"))
      .map((ref) => Number(ref.slice(ref.lastIndexOf(":") + 1)))
      .sort((a, b) => a - b);
    expect(lines).toEqual([3, 4]);
    db.raw.close();
  });

  it("publishes a retry-loop shape that calls the same SDK method in try and catch", () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/client.ts": [
        'import twilio from "twilio";',
        "export async function sendWithRetry(to: string) {",
        "  try {",
        '    return await twilio.messages.create({ to, Body: "a" });',
        "  } catch {",
        '    return await twilio.messages.create({ to, Body: "b" });',
        "  }",
        "}",
      ].join("\n"),
    });

    const publication = materialize(repoRoot);
    const db = openGraphLearnMemory();
    expect(() => publishSoftwareGraphVersion(db, publication)).not.toThrow();
    const internal = publication.entities.filter(
      (entity) => entity.kind === "internal_sdk_method" && entity.label === "sendWithRetry",
    );
    expect(internal).toHaveLength(1);
    const lines = internal[0]!.evidenceRefs
      .filter((ref) => ref.includes("src/client.ts"))
      .map((ref) => Number(ref.slice(ref.lastIndexOf(":") + 1)))
      .sort((a, b) => a - b);
    expect(lines).toEqual([4, 6]);
    db.raw.close();
  });

  it("labels an explicit SDK-path match deterministic_exact and a last-segment fallback static_analysis_medium", () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/client.ts": [
        'import twilio from "twilio";',
        "export async function sendMessage(to: string) {",
        '  return twilio.messages.create({ to, Body: "hi" });',
        "}",
      ].join("\n"),
    });
    const index = buildIndex(repoRoot, { sdkContext: sdkContextFromSurfaces([surface]) });

    const materializeWith = (sdkMethodPaths: string[]) =>
      materializeFettlerSoftwareGraph({
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
          sdkMethodPaths,
          evidenceRefs: ["artifact:twilio-openapi:2026-08-17"],
        },
        observedAt: "2026-08-17T12:00:00.000Z",
        maxCallerHops: 4,
      });

    const bindingBasis = (publication: ReturnType<typeof materializeWith>) => {
      const providerSdk = publication.entities.find((entity) => entity.kind === "provider_sdk_method");
      const usesEndpoint = publication.relationships.find((edge) => edge.kind === "uses_endpoint");
      return { entity: providerSdk?.confidenceBasis, relationship: usesEndpoint?.confidenceBasis };
    };

    // Explicit method path supplied -> deterministic binding.
    expect(bindingBasis(materializeWith(["messages.create"]))).toEqual({
      entity: "deterministic_exact",
      relationship: "deterministic_exact",
    });
    // No method path -> only the last-path-segment heuristic runs (the production
    // reality): it must NOT be dressed up as deterministic_exact.
    expect(bindingBasis(materializeWith([]))).toEqual({
      entity: "static_analysis_medium",
      relationship: "static_analysis_medium",
    });
  });

  it("reaches complete coverage (a passed evidence verdict) for a healthy analysis of a git working tree", async () => {
    const repoRoot = makeRepositoryFromFiles({
      "src/client.ts": [
        'import twilio from "twilio";',
        "export async function sendMessage(to: string) {",
        '  return twilio.messages.create({ to, Body: "hello" });',
        "}",
      ].join("\n"),
      ".git/HEAD": "ref: refs/heads/main\n",
    });
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
    expect(result.graphImpact.impact).toBe("impact");
    // The pipeline writes verdict = coverage.basis === "complete" ? "passed" :
    // "failed". A git working tree previously forced this to partial (=> failed)
    // for every healthy analysis; it is now complete.
    expect(result.graphImpact.coverage.basis).toBe("complete");
    db.raw.close();
  });
});
