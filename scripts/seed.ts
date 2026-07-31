import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  findMonorepoRoot,
  getConsumerRepo,
  getProviderBySlug,
  insertApiVersion,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  insertPolicy,
  listMonitoredForConsumer,
  listPoliciesForConsumer,
  listVersionsForProvider,
  recordAudit,
  resolveDbPath,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";

export type SeedOptions = {
  dbPath?: string;
  root?: string;
  tenantId?: string;
  consumerRepoPath?: string;
};

export type SeedResult = {
  dbPath: string;
  providerId: string;
  consumerId: string;
  changed: boolean;
};

type ConsumerSeedRow = {
  id: string;
  name: string;
  github_owner: string;
  github_repo: string;
  tenant_id: string | null;
};

type VersionSeedRow = {
  id: string;
  version_label: string;
  openapi_json: string;
  changelog_md: string | null;
  published_at: string;
};

function currentScriptRoot(): string {
  return findMonorepoRoot(join(dirname(fileURLToPath(import.meta.url)), ".."));
}

export function seedDatabase(opts: SeedOptions = {}): SeedResult {
  const root = opts.root ? resolve(opts.root) : currentScriptRoot();
  const configuredDb = opts.dbPath ?? process.env.DATABASE_URL;
  if (configuredDb && !configuredDb.startsWith("file:") && configuredDb.includes("://")) {
    throw new Error("Seed database must be a SQLite file path or file: path");
  }
  const dbPath = resolveDbPath(opts.dbPath);
  const tenantId = opts.tenantId ?? "tenant_default";
  const db = createDb(dbPath);
  let changed = false;

  const acmeDir = join(root, "fixtures/providers/acme-payments");
  const shopDir = resolve(
    opts.consumerRepoPath ??
      process.env.MENDPOINT_SEED_REPO_PATH ??
      join(root, "fixtures/consumers/shop-app"),
  );
  let provider = getProviderBySlug(db, "acme-payments");
  if (!provider) {
    const providerId = newId();
    db.raw
      .prepare(
        `INSERT INTO providers (id, slug, name, website, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        providerId,
        "acme-payments",
        "Acme Payments",
        "https://acme-payments.example",
        nowIso(),
      );
    provider = getProviderBySlug(db, "acme-payments");
    changed = true;
  }
  if (!provider) throw new Error("Could not seed Acme Payments provider");

  const wantedVersions = [
    {
      label: "1.0.0",
      openapi: readFileSync(join(acmeDir, "openapi-v1.json"), "utf8"),
      changelog: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      label: "2.0.0",
      openapi: readFileSync(join(acmeDir, "openapi-v2.json"), "utf8"),
      changelog: readFileSync(join(acmeDir, "changelog.md"), "utf8"),
      publishedAt: "2026-07-01T00:00:00.000Z",
    },
  ];
  const versions = new Map(
    listVersionsForProvider(db, provider.id).map((version) => [
      version.version_label,
      version as VersionSeedRow,
    ]),
  );
  for (const wanted of wantedVersions) {
    const existing = versions.get(wanted.label);
    if (!existing) {
      insertApiVersion(db, {
        id: newId(),
        providerId: provider.id,
        versionLabel: wanted.label,
        openapiJson: wanted.openapi,
        changelogMd: wanted.changelog,
        publishedAt: wanted.publishedAt,
      });
      changed = true;
      continue;
    }
    if (
      existing.openapi_json !== wanted.openapi ||
      existing.changelog_md !== wanted.changelog ||
      existing.published_at !== wanted.publishedAt
    ) {
      db.raw
        .prepare(
          `UPDATE api_versions
           SET openapi_json = ?, changelog_md = ?, published_at = ?
           WHERE id = ?`,
        )
        .run(wanted.openapi, wanted.changelog, wanted.publishedAt, existing.id);
      changed = true;
    }
  }

  let consumer = db.raw
    .prepare(
      `SELECT id, name, github_owner, github_repo, tenant_id
       FROM consumers
       WHERE github_owner = ? AND github_repo = ? AND tenant_id = ?
       ORDER BY created_at LIMIT 1`,
    )
    .get("example-org", "shop-app", tenantId) as ConsumerSeedRow | undefined;
  if (!consumer) {
    const consumerId = newId();
    insertConsumer(db, {
      id: consumerId,
      name: "Shop App",
      githubOwner: "example-org",
      githubRepo: "shop-app",
      tenantId,
      installationId: null,
      createdAt: nowIso(),
    });
    consumer = db.raw
      .prepare(
        `SELECT id, name, github_owner, github_repo, tenant_id
         FROM consumers WHERE id = ?`,
      )
      .get(consumerId) as ConsumerSeedRow;
    changed = true;
  } else if (consumer.name !== "Shop App") {
    db.raw.prepare(`UPDATE consumers SET name = ? WHERE id = ?`).run("Shop App", consumer.id);
    changed = true;
  }

  const repo = getConsumerRepo(db, consumer.id, tenantId);
  if (!repo) {
    insertConsumerRepo(db, {
      id: newId(),
      consumerId: consumer.id,
      localPath: shopDir,
      defaultBranch: "main",
      createdAt: nowIso(),
    });
    changed = true;
  } else if (repo.local_path !== shopDir || repo.default_branch !== "main") {
    db.raw
      .prepare(
        `UPDATE consumer_repos SET local_path = ?, default_branch = ? WHERE id = ?`,
      )
      .run(shopDir, "main", repo.id);
    changed = true;
  }

  const monitored = listMonitoredForConsumer(db, consumer.id).some(
    (entry) => entry.provider_id === provider.id,
  );
  if (!monitored) {
    insertMonitoredApi(db, {
      id: newId(),
      consumerId: consumer.id,
      providerId: provider.id,
      detectionSource: "manual",
    });
    changed = true;
  }

  const wantedPolicies: Record<string, unknown> = {
    auto_merge_low_risk: false,
    never_touch_paths: [
      ".env",
      ".env.production",
      "secrets/",
      "prod/",
      "package-lock.json",
    ],
    notifications_only: false,
  };
  const policies = new Map(
    listPoliciesForConsumer(db, consumer.id).map((row) => [row.key, row]),
  );
  for (const [key, value] of Object.entries(wantedPolicies)) {
    const valueJson = JSON.stringify(value);
    const existing = policies.get(key);
    if (!existing) {
      insertPolicy(db, {
        id: newId(),
        consumerId: consumer.id,
        key,
        valueJson,
      });
      changed = true;
    } else if (existing.value_json !== valueJson) {
      db.raw.prepare(`UPDATE policies SET value_json = ? WHERE id = ?`).run(
        valueJson,
        existing.id,
      );
      changed = true;
    }
  }

  if (changed) {
    recordAudit(db, {
      tenantId,
      actor: "seed",
      action: "db.seeded",
      resourceType: "system",
      metadata: { providerId: provider.id, consumerId: consumer.id },
    });
  }
  db.raw.close();
  return {
    dbPath,
    providerId: provider.id,
    consumerId: consumer.id,
    changed,
  };
}

function cliDbPath(argv: string[]): string | undefined {
  if (argv.includes("--force")) {
    throw new Error(
      "--force reset was removed. Use --db with a disposable database path.",
    );
  }
  const index = argv.indexOf("--db");
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--db requires an explicit SQLite database path");
  }
  return value;
}

function isMain(): boolean {
  return Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const result = seedDatabase({ dbPath: cliDbPath(process.argv.slice(2)) });
  console.log(
    result.changed
      ? `Seeded database at ${result.dbPath}`
      : `Seed already reconciled at ${result.dbPath}`,
  );
  console.log("  provider: acme-payments (1.0.0 to 2.0.0)");
  console.log("  consumer: Shop App");
}
