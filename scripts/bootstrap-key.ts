/**
 * Create the first production API key directly in the configured SQLite DB.
 *
 * Run inside the deployment boundary:
 *   npm run auth:bootstrap
 */
import {
  countActiveApiKeys,
  createApiKey,
  createDb,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";

const db = createDb();
const active = countActiveApiKeys(db);
const force = process.argv.includes("--force");

if (active > 0 && !force) {
  console.error(
    "Active API keys already exist. Refusing to create another bootstrap key without --force.",
  );
  process.exit(1);
}

const tenantId = process.env.MENDPOINT_BOOTSTRAP_TENANT ?? "tenant_default";
const name = process.env.MENDPOINT_BOOTSTRAP_KEY_NAME ?? "bootstrap-owner";
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
