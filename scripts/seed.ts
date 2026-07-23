import { readFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  findMonorepoRoot,
  getProviderBySlug,
  insertProvider,
  insertApiVersion,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  insertPolicy,
  listVersionsForProvider,
  recordAudit,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";

const root = findMonorepoRoot(join(dirname(fileURLToPath(import.meta.url)), ".."));
const dbPath = resolve(root, "data/mendpoint.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const force = process.argv.includes("--force");
if (force && existsSync(dbPath)) {
  try {
    unlinkSync(dbPath);
  } catch {
    console.warn("Could not delete existing DB (is the API running?). Continuing without reset.");
  }
}

const db = createDb(dbPath);
const existing = getProviderBySlug(db, "acme-payments");
if (existing && listVersionsForProvider(db, existing.id).length >= 2 && !force) {
  console.log("Seed already present at", dbPath, "(use --force to reset when API is stopped)");
} else {
  const providerId = existing?.id ?? newId();
  const consumerId = newId();

  const acmeDir = join(root, "fixtures/providers/acme-payments");
  const shopDir = join(root, "fixtures/consumers/shop-app");

  if (!existing) {
    insertProvider(db, {
      id: providerId,
      slug: "acme-payments",
      name: "Acme Payments",
      website: "https://acme-payments.example",
      createdAt: nowIso(),
    });
  }

  if (listVersionsForProvider(db, providerId).length < 2) {
    insertApiVersion(db, {
      id: newId(),
      providerId,
      versionLabel: "1.0.0",
      openapiJson: readFileSync(join(acmeDir, "openapi-v1.json"), "utf8"),
      changelogMd: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });

    insertApiVersion(db, {
      id: newId(),
      providerId,
      versionLabel: "2.0.0",
      openapiJson: readFileSync(join(acmeDir, "openapi-v2.json"), "utf8"),
      changelogMd: readFileSync(join(acmeDir, "changelog.md"), "utf8"),
      publishedAt: "2026-07-01T00:00:00.000Z",
    });
  }

  insertConsumer(db, {
    id: consumerId,
    name: "Shop App",
    githubOwner: "example-org",
    githubRepo: "shop-app",
    installationId: null,
    createdAt: nowIso(),
  });

  insertConsumerRepo(db, {
    id: newId(),
    consumerId,
    localPath: shopDir,
    defaultBranch: "main",
    createdAt: nowIso(),
  });

  insertMonitoredApi(db, {
    id: newId(),
    consumerId,
    providerId,
    detectionSource: "manual",
  });

  insertPolicy(db, {
    id: newId(),
    consumerId,
    key: "auto_merge_low_risk",
    valueJson: JSON.stringify(false),
  });
  insertPolicy(db, {
    id: newId(),
    consumerId,
    key: "never_touch_paths",
    valueJson: JSON.stringify([
      ".env",
      ".env.production",
      "secrets/",
      "prod/",
      "package-lock.json",
    ]),
  });
  insertPolicy(db, {
    id: newId(),
    consumerId,
    key: "notifications_only",
    valueJson: JSON.stringify(false),
  });


  recordAudit(db, {
    actor: "seed",
    action: "db.seeded",
    resourceType: "system",
    metadata: { providerId, consumerId },
  });

  console.log("Seeded database at", dbPath);
  console.log("  provider: acme-payments (1.0.0 → 2.0.0)");
  console.log("  consumer: Shop App →", shopDir);
}
