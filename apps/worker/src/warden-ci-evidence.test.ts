import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWardenCiEvidenceStore } from "./warden-ci-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Warden CI immutable evidence store", () => {
  it("publishes and reopens exact tenant-scoped bytes idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-ci-evidence-"));
    roots.push(root);
    const store = createWardenCiEvidenceStore(root);
    const bytes = Buffer.from("failure evidence");
    const first = await store.publish("tenant-a", bytes);
    expect(await store.publish("tenant-a", bytes)).toEqual(first);
    expect(Buffer.from(await store.read("tenant-a", first.artifactId, first.digest)).toString("utf8"))
      .toBe("failure evidence");
  });

  it("rejects cross-tenant reads and path-like tenant identifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-ci-evidence-"));
    roots.push(root);
    const store = createWardenCiEvidenceStore(root);
    const first = await store.publish("tenant-a", Buffer.from("failure evidence"));
    await expect(store.read("tenant-b", first.artifactId, first.digest)).rejects.toThrow("warden_ci_evidence_missing");
    await expect(store.publish("../outside", Buffer.from("x"))).rejects.toThrow("warden_ci_evidence_scope_invalid");
  });
});
