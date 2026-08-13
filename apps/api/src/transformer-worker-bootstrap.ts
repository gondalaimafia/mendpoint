import { createHash } from "node:crypto";
import { createApiKeyFromToken, findApiKeyByToken, listApiKeys, revokeApiKey, type AppDb } from "@mendpoint/db";

const TOKEN = /^me_[A-Za-z0-9_-]{32,}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SCOPES = Object.freeze(["role:agent", "transformer:worker"]);
const MANAGED_ID_PREFIX = "transformer-worker-";
const MANAGED_NAME = "Transformer production worker";

export function ensureTransformerWorkerCredential(db: AppDb, input: Readonly<{
  tenantId: string;
  token: string;
  createdAt: string;
}>): "created" | "existing" {
  if (!ID.test(input.tenantId) || !TOKEN.test(input.token) || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("transformer_worker_credential_invalid");
  }
  const createdAt = new Date(Date.parse(input.createdAt)).toISOString();
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = findApiKeyByToken(db, input.token);
    if (existing) {
      const scopes = parseScopes(existing.scopes_json).sort();
      if (existing.tenant_id !== input.tenantId || existing.name !== MANAGED_NAME || !existing.id.startsWith(MANAGED_ID_PREFIX) || JSON.stringify(scopes) !== JSON.stringify([...SCOPES].sort())) {
        throw new Error("transformer_worker_credential_conflict");
      }
    }
    for (const key of listApiKeys(db, input.tenantId)) {
      if (key.revoked_at === null && key.name === MANAGED_NAME && key.id.startsWith(MANAGED_ID_PREFIX) && key.id !== existing?.id) {
        revokeApiKey(db, key.id, createdAt, input.tenantId);
      }
    }
    if (!existing) {
      createApiKeyFromToken(db, {
        id: `${MANAGED_ID_PREFIX}${createHash("sha256").update(input.token).digest("hex").slice(0, 24)}`,
        name: MANAGED_NAME,
        tenantId: input.tenantId,
        token: input.token,
        scopes: [...SCOPES],
        createdAt,
      });
    }
    if (owns) db.raw.exec("COMMIT");
    return existing ? "existing" : "created";
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function parseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) return [];
    return parsed;
  } catch { return []; }
}
