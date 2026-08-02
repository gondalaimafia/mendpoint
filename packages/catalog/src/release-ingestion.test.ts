import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ingestReleaseDocument,
  listReleaseArtifacts,
  openReleaseIngestionStore,
  recordReleaseReviewerOverride,
  type ReleaseIngestionStore,
} from "./release-ingestion.js";

const NOW = "2026-08-02T12:00:00.000Z";
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/releases/${name}`, import.meta.url), "utf8");
const stores: ReleaseIngestionStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* restart tests close one handle early */ }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store(path = ":memory:"): ReleaseIngestionStore {
  const opened = openReleaseIngestionStore(path);
  stores.push(opened);
  return opened;
}

function input(adapter: "rss" | "atom" | "github_releases" | "provider_page" | "sdk_registry", body: string) {
  return {
    tenantId: "tenant-a",
    providerSlug: "stripe",
    adapter,
    sourceUrl: adapter === "sdk_registry"
      ? "https://registry.npmjs.org/stripe"
      : "https://docs.stripe.com/changelog/feed",
    body,
    observedAt: NOW,
    now: NOW,
  } as const;
}

describe("release ingestion", () => {
  it("normalizes RSS and Atom fixtures with complete source evidence", () => {
    const ledger = store();
    const rss = ingestReleaseDocument(ledger, input("rss", fixture("stripe-rss.xml")));
    const atom = ingestReleaseDocument(ledger, {
      ...input("atom", fixture("openai-atom.xml")),
      providerSlug: "openai",
      sourceUrl: "https://platform.openai.com/docs/changelog.atom",
    });

    expect(rss.inserted).toBe(1);
    expect(rss.artifacts[0]).toMatchObject({
      tenantId: "tenant-a",
      adapter: "rss",
      collectionUrl: "https://docs.stripe.com/changelog/feed",
      sourceUrl: "https://docs.stripe.com/changelog/charges-2026-08-01",
      sourceItemId: "charges-2026-08-01",
      excerptLocation: "rss.channel.item[0].description",
      confidence: 0.9,
      reviewerOverride: null,
    });
    expect(rss.artifacts[0]?.sourceBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rss.artifacts[0]?.changeHints.replacements).toContainEqual({ from: "amount_cents", to: "amount" });
    expect(atom.artifacts[0]?.sourceItemId).toBe("urn:openai:release:responses-2026-08-01");
    expect(atom.artifacts[0]?.changeHints.replacements).toContainEqual({ from: "max_tokens", to: "max_output_tokens" });
  });

  it("normalizes GitHub releases and a constrained provider page fixture", () => {
    const ledger = store();
    const github = ingestReleaseDocument(ledger, input("github_releases", fixture("github-releases.json")));
    const page = ingestReleaseDocument(ledger, input("provider_page", fixture("provider-page.html")));

    expect(github.artifacts[0]).toMatchObject({
      version: "v3.2.0",
      sourceUrl: "https://github.com/acme/payments/releases/tag/v3.2.0",
      excerptLocation: "github.release[0].body",
    });
    expect(page.artifacts[0]).toMatchObject({
      sourceItemId: "charges-v2",
      sourceUrl: "https://docs.stripe.com/changelog/charges-v2",
      excerptLocation: "provider_page.article[0]",
    });
  });

  it("records SDK version, export, client, runtime, and emitted change evidence", () => {
    const ledger = store();
    const result = ingestReleaseDocument(ledger, input("sdk_registry", fixture("stripe-npm-registry.json")));
    const sdk = result.artifacts[0]?.sdk;

    expect(sdk).toMatchObject({
      ecosystem: "npm",
      packageName: "stripe",
      version: "16.0.0",
      previousVersion: "15.0.0",
      runtimeCompatibility: { previousNode: ">=16", currentNode: ">=18", changed: true },
    });
    expect(sdk?.exportDiff.removed).toEqual(["./legacy"]);
    expect(sdk?.exportDiff.added).toEqual(["./webhooks"]);
    expect(sdk?.clientDiff).toEqual({
      source: "package_exports_proxy",
      ...sdk!.exportDiff,
    });
    expect(sdk?.emittedChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "export_removed", breaking: true, subject: "./legacy" }),
      expect.objectContaining({ kind: "runtime_changed", breaking: true, subject: "node" }),
    ]));
  });

  it("is idempotent, tenant scoped, append only, and durable across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-ingestion-"));
    directories.push(directory);
    const path = join(directory, "release.sqlite");
    const first = store(path);
    const document = input("rss", fixture("stripe-rss.xml"));
    expect(ingestReleaseDocument(first, document).inserted).toBe(1);
    expect(ingestReleaseDocument(first, document).inserted).toBe(0);
    expect(ingestReleaseDocument(first, { ...document, tenantId: "tenant-b" }).inserted).toBe(1);
    const artifact = listReleaseArtifacts(first, "tenant-a")[0]!;
    recordReleaseReviewerOverride(first, {
      tenantId: "tenant-a",
      artifactId: artifact.id,
      expectedRevision: 0,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.98,
      excerpt: "Verified provider wording.",
      excerptLocation: "review note, line 1",
      reason: "Compared with provider migration guide",
      reviewedAt: NOW,
    });
    expect(() => recordReleaseReviewerOverride(first, {
      tenantId: "tenant-b",
      artifactId: artifact.id,
      expectedRevision: 1,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.9,
      excerpt: "Wrong tenant",
      excerptLocation: "review note, line 1",
      reason: "Must fail",
      reviewedAt: NOW,
    })).toThrow("release_artifact_not_found");
    expect(() => recordReleaseReviewerOverride(first, {
      tenantId: "tenant-a",
      artifactId: artifact.id,
      expectedRevision: 0,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.9,
      excerpt: "Stale revision",
      excerptLocation: "review note, line 1",
      reason: "Must fail",
      reviewedAt: NOW,
    })).toThrow("release_override_revision_conflict");
    expect(() => first.raw.prepare("UPDATE release_ingestion_artifacts SET title = 'changed'").run())
      .toThrow(/release_ingestion_artifacts_append_only/);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = store(path);
    expect(listReleaseArtifacts(reopened, "tenant-a")[0]?.reviewerOverride).toMatchObject({
      revision: 1,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.98,
    });
    expect(listReleaseArtifacts(reopened, "tenant-b")).toHaveLength(1);
    expect(listReleaseArtifacts(reopened, "tenant-c")).toHaveLength(0);
  });

  it.each([
    ["malformed RSS", "rss", "<rss><channel><item></rss>", /release_xml_malformed/],
    ["ambiguous XML", "rss", "<rss><feed><item></item><entry></entry></feed></rss>", /release_xml_adapter_ambiguous/],
    ["malformed registry", "sdk_registry", "{", /release_json_malformed/],
  ] as const)("fails closed for %s", (_label, adapter, body, error) => {
    const ledger = store();
    expect(() => ingestReleaseDocument(ledger, input(adapter, body))).toThrow(error);
    expect(listReleaseArtifacts(ledger, "tenant-a")).toHaveLength(0);
  });

  it("rejects oversized, stale, unsafe, and ambiguous SDK documents before writing", () => {
    const ledger = store();
    expect(() => ingestReleaseDocument(ledger, input("rss", "x".repeat(1_048_577))))
      .toThrow("release_document_too_large");
    expect(() => ingestReleaseDocument(ledger, {
      ...input("rss", fixture("stripe-rss.xml")),
      observedAt: "2026-07-30T12:00:00.000Z",
    })).toThrow("release_document_stale");
    expect(() => ingestReleaseDocument(ledger, {
      ...input("rss", fixture("stripe-rss.xml")),
      sourceUrl: "http://localhost/feed",
    })).toThrow("release_source_url_unsafe");
    const ambiguous = JSON.parse(fixture("stripe-npm-registry.json"));
    ambiguous["dist-tags"].latest = "99.0.0";
    expect(() => ingestReleaseDocument(ledger, input("sdk_registry", JSON.stringify(ambiguous))))
      .toThrow("sdk_latest_version_missing");
    expect(listReleaseArtifacts(ledger, "tenant-a")).toHaveLength(0);
  });
});
