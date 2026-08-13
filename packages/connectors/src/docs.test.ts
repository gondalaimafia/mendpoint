import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDocsConnector } from "./docs.js";
import type { ConnectorFetch } from "./connector.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function knowledgeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-connector-docs-"));
  dirs.push(dir);
  writeFileSync(join(dir, "api-style-guide.md"), "# API style guide\nVersion via /vN/.\n");
  writeFileSync(join(dir, "migration-playbook.md"), "# Migration playbook\nLock BSG first.\n");
  return dir;
}

function scriptedFetch(
  responder: (url: string) => { ok: boolean; status: number; json: unknown },
): ConnectorFetch {
  return async (url) => responder(url);
}

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  throw new Error("expected function to throw");
}

describe("docs connector — markdown_repo (mock, reuses fixtures/knowledge shape)", () => {
  it("verifies and returns planner-ready KnowledgeDocs", async () => {
    const connector = createDocsConnector({ provider: "markdown_repo", ref: knowledgeDir() });
    const health = await connector.verifyConnection();
    expect(health.ok).toBe(true);
    const sources = await connector.listDocSources();
    expect(sources.length).toBe(2);
    const docs = await connector.fetchDocs();
    expect(docs.map((d) => d.id)).toContain("api-style-guide-file");
    expect(docs[0]!.body).toContain("API style guide");
  });

  it("fails closed when the directory has no markdown docs", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mendpoint-connector-empty-"));
    dirs.push(empty);
    const connector = createDocsConnector({ provider: "markdown_repo", ref: empty });
    const health = await connector.verifyConnection();
    expect(health.ok).toBe(false);
    expect(health.errorCode).toBe("markdown_repo_empty");
    await expect(connector.fetchDocs()).rejects.toMatchObject({ code: "connector_unverified" });
  });
});

describe("docs connector — real (credential-gated)", () => {
  it("confluence cannot construct without token, email, and space ref", () => {
    expect(thrownCode(() => createDocsConnector({ provider: "confluence", mode: "real" }))).toBe(
      "confluence_credential_required",
    );
    // token + ref present but email missing still fails closed.
    expect(
      thrownCode(() => createDocsConnector({ provider: "confluence", mode: "real", token: "t", ref: "SPACE" })),
    ).toBe("confluence_credential_required");
  });

  it("notion cannot construct without token and page ref", () => {
    expect(thrownCode(() => createDocsConnector({ provider: "notion", mode: "real", token: "t" }))).toBe(
      "notion_source_ref_required",
    );
  });

  it("confluence real path fetches space content via the fetch seam", async () => {
    const fetchImpl = scriptedFetch((url) => {
      if (url.includes("/space/")) return { ok: true, status: 200, json: { key: "ENG" } };
      if (url.includes("/content"))
        return {
          ok: true,
          status: 200,
          json: { results: [{ id: "p1", title: "Runbook", body: { storage: { value: "deploy steps" } } }] },
        };
      return { ok: false, status: 404, json: null };
    });
    const connector = createDocsConnector({
      provider: "confluence",
      mode: "real",
      token: "t",
      email: "eng@acme.com",
      ref: "ENG",
      fetch: fetchImpl,
    });
    const health = await connector.verifyConnection();
    expect(health.ok).toBe(true);
    const docs = await connector.fetchDocs();
    expect(docs[0]!.title).toBe("Runbook");
    expect(docs[0]!.tags).toContain("confluence");
  });
});
