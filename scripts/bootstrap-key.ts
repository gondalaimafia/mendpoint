/**
 * Create the first production API key directly in the configured SQLite DB.
 *
 * Run inside the deployment boundary:
 *   npm run auth:bootstrap
 */
import {
  countActiveApiKeys,
  createApiKey,
  createApiKeyFromToken,
  createDb,
  findApiKeyByToken,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";

const db = createDb();
const active = countActiveApiKeys(db);
const force = process.argv.includes("--force");
const configuredToken = process.env.MENDPOINT_BOOTSTRAP_API_KEY?.trim();
const tenantId = process.env.MENDPOINT_BOOTSTRAP_TENANT ?? "tenant_default";
const name = process.env.MENDPOINT_BOOTSTRAP_KEY_NAME ?? "bootstrap-owner";

if (configuredToken) {
  if (!/^me_[A-Za-z0-9_-]{32,}$/.test(configuredToken)) {
    console.error(
      "MENDPOINT_BOOTSTRAP_API_KEY must use the me_ prefix and at least 32 URL-safe secret characters.",
    );
    process.exit(1);
  }
  const existing = findApiKeyByToken(db, configuredToken);
  if (existing) {
    if (existing.tenant_id !== tenantId) {
      console.error("Configured bootstrap key belongs to a different tenant.");
      process.exit(1);
    }
    console.log("Mendpoint bootstrap API key already configured.");
    console.log(`tenant=${tenantId}`);
    process.exit(0);
  }
  if (active > 0) {
    console.error(
      "Active API keys exist, but none match MENDPOINT_BOOTSTRAP_API_KEY. Refusing to replace them.",
    );
    process.exit(1);
  }
  createApiKeyFromToken(db, {
    id: newId(),
    name,
    tenantId,
    token: configuredToken,
    scopes: ["*"],
    createdAt: nowIso(),
  });
  console.log("Mendpoint bootstrap API key configured.");
  console.log(`tenant=${tenantId}`);
  process.exit(0);
}

if (active > 0 && !force) {
  console.error(
    "Active API keys already exist. Refusing to create another bootstrap key without --force.",
  );
  process.exit(1);
}

const created = createApiKey(db, {
  id: newId(),
  name,
  tenantId,
  scopes: ["*"],
  createdAt: nowIso(),
});

console.log("Mendpoint bootstrap API key created.");
console.log(`tenant=${created.tenantId}`);
console.log(`token=${created.token}`);
console.log("Store this token securely. It will not be shown again.");
