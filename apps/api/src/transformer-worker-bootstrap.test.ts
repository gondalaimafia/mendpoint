import { afterEach, describe, expect, it } from "vitest";
import { createApiKeyFromToken, createDb, findApiKeyByToken, type AppDb } from "@mendpoint/db";
import { can, permissionForRoute } from "@mendpoint/platform";
import { scopeAllows } from "./auth.js";
import { ensureTransformerWorkerCredential } from "./transformer-worker-bootstrap.js";

const dbs: AppDb[] = [];
const roots: string[] = [];
afterEach(() => { while (dbs.length) dbs.pop()?.raw.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("Transformer worker credential bootstrap", () => {
  it("creates one scoped credential and adopts its exact replay", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-worker-key-")); roots.push(root);
    const db = createDb(join(root, "app.sqlite")); dbs.push(db);
    const input = { tenantId: "tenant-a", token: `me_${"a".repeat(40)}`, createdAt: "2026-08-13T12:00:00.000Z" };
    expect(ensureTransformerWorkerCredential(db, input)).toBe("created");
    expect(ensureTransformerWorkerCredential(db, input)).toBe("existing");
    const stored = findApiKeyByToken(db, input.token)!;
    expect(JSON.parse(stored.scopes_json)).toEqual(["role:agent", "transformer:worker"]);
    expect(stored.tenant_id).toBe("tenant-a");
  });

  it("rejects a replay that crosses tenant authority", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-worker-key-")); roots.push(root);
    const db = createDb(join(root, "app.sqlite")); dbs.push(db);
    const input = { tenantId: "tenant-a", token: `me_${"b".repeat(40)}`, createdAt: "2026-08-13T12:00:00.000Z" };
    ensureTransformerWorkerCredential(db, input);
    expect(() => ensureTransformerWorkerCredential(db, { ...input, tenantId: "tenant-b" })).toThrow("transformer_worker_credential_conflict");
  });

  it("rotates the managed credential, revokes the old token, and preserves unrelated keys", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-worker-key-")); roots.push(root);
    const db = createDb(join(root, "app.sqlite")); dbs.push(db);
    const first = `me_${"c".repeat(40)}`;
    const second = `me_${"d".repeat(40)}`;
    const unrelated = `me_${"e".repeat(40)}`;
    createApiKeyFromToken(db, { id: "user-key", name: "User key", tenantId: "tenant-a", token: unrelated, scopes: ["graph:read"], createdAt: "2026-08-13T11:00:00.000Z" });
    ensureTransformerWorkerCredential(db, { tenantId: "tenant-a", token: first, createdAt: "2026-08-13T12:00:00.000Z" });
    ensureTransformerWorkerCredential(db, { tenantId: "tenant-a", token: second, createdAt: "2026-08-13T13:00:00.000Z" });
    expect(findApiKeyByToken(db, first)).toBeUndefined();
    expect(findApiKeyByToken(db, second)).toBeDefined();
    expect(findApiKeyByToken(db, unrelated)).toBeDefined();
  });

  it("maps the real coordinator path to the exact bootstrapped worker authority", () => {
    const permission = permissionForRoute("POST", "/v1/transformer/attempt-coordinator/readyz");
    expect(permission).toBe("transformer:worker");
    expect(can({ id: "api-key:worker", tenantId: "tenant-a", role: "agent" }, permission!)).toBe(true);
    expect(scopeAllows(["role:agent", "transformer:worker"], permission!)).toBe(true);
    expect(scopeAllows(["role:agent", "plan:execute"], permission!)).toBe(false);
  });
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
