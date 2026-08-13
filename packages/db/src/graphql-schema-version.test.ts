import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertPrincipal, type AppDb } from "./index.js";
import {
  getGraphQLSchemaVersion,
  getGraphQLSchemaVersionByLabel,
  insertGraphQLSchemaVersion,
  listGraphQLSchemaVersions,
} from "./graphql-schema-version.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function path() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-graphql-db-"));
  dirs.push(dir);
  return join(dir, "app.sqlite");
}

function open(file = path()) {
  const db = createDb(file);
  insertPrincipal(db, { id: "principal-graphql", tenantId: "tenant-a", kind: "service", subject: "graphql-test", displayName: "GraphQL Test", createdAt: "2026-08-12T12:00:00.000Z" });
  dbs.push(db);
  return db;
}

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: "graphql-version-1",
    evidenceId: "graphql-evidence-1",
    sourceArtifactId: "graphql-source-artifact-1",
    schemaArtifactId: "graphql-schema-artifact-1",
    tenantId: "tenant-a",
    sourceKey: "payments-api",
    versionLabel: "2026-08-12.1",
    sourceFormat: "sdl" as const,
    sourceContent: "type Query { charge: ID! }",
    schema: {
      sourceFormat: "sdl" as const,
      canonicalSdl: "type Query {\n  charge: ID!\n}",
      definitions: [],
      digest: `sha256:${"a".repeat(64)}`,
    },
    baselineVersionId: null,
    diff: {
      classification: "non_breaking" as const,
      changes: [],
      oracle: { breaking: [], dangerous: [] },
      oldDigest: null,
      newDigest: `sha256:${"a".repeat(64)}`,
    },
    producerPrincipalId: "principal-graphql",
    createdAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("durable GraphQL schema versions", () => {
  it("persists immutable source, normalized schema, and evidence across restart", () => {
    const file = path();
    const first = open(file);
    const inserted = insertGraphQLSchemaVersion(first, version());
    expect(inserted.inserted).toBe(true);
    expect(inserted.record).toMatchObject({
      id: "graphql-version-1",
      tenantId: "tenant-a",
      sourceKey: "payments-api",
      sourceArtifactId: "graphql-source-artifact-1",
      schemaArtifactId: "graphql-schema-artifact-1",
      evidenceId: "graphql-evidence-1",
    });
    first.raw.close();
    dbs.pop();

    const restarted = open(file);
    expect(getGraphQLSchemaVersion(restarted, "tenant-a", "payments-api", "graphql-version-1")).toEqual(inserted.record);
    const source = restarted.raw.prepare("SELECT * FROM artifact_manifests WHERE id = ?").get("graphql-source-artifact-1") as { content_text: string };
    expect(source.content_text).toBe("type Query { charge: ID! }");
    const evidence = restarted.raw.prepare("SELECT * FROM evidence_records WHERE id = ?").get("graphql-evidence-1") as { subject_id: string; artifact_id: string; input_artifact_id: string };
    expect(evidence).toMatchObject({ subject_id: "payments-api", artifact_id: "graphql-schema-artifact-1", input_artifact_id: "graphql-source-artifact-1" });
  });

  it("replays exact labels, rejects changed content, and isolates every lookup by tenant", () => {
    const db = open();
    const first = insertGraphQLSchemaVersion(db, version());
    expect(insertGraphQLSchemaVersion(db, version({ id: "ignored", evidenceId: "ignored-evidence", sourceArtifactId: "ignored-source", schemaArtifactId: "ignored-schema" }))).toEqual({ record: first.record, inserted: false });
    expect(() => insertGraphQLSchemaVersion(db, version({ sourceContent: "type Query { changed: ID! }" }))).toThrow("graphql_schema_version_label_conflict");
    expect(() => insertGraphQLSchemaVersion(db, version({ baselineVersionId: "graphql-version-other", diff: { ...version().diff, oldDigest: `sha256:${"b".repeat(64)}` } }))).toThrow("graphql_schema_version_label_conflict");
    expect(getGraphQLSchemaVersion(db, "tenant-b", "payments-api", first.record.id)).toBeUndefined();
    expect(getGraphQLSchemaVersionByLabel(db, "tenant-b", "payments-api", first.record.versionLabel)).toBeUndefined();
    expect(listGraphQLSchemaVersions(db, "tenant-b", "payments-api")).toEqual([]);
  });

  it("orders versions deterministically and preserves selected baseline and migration evidence", () => {
    const db = open();
    insertGraphQLSchemaVersion(db, version());
    const second = insertGraphQLSchemaVersion(db, version({
      id: "graphql-version-2",
      evidenceId: "graphql-evidence-2",
      sourceArtifactId: "graphql-source-artifact-2",
      schemaArtifactId: "graphql-schema-artifact-2",
      versionLabel: "2026-08-12.2",
      sourceContent: "type Query { charge: String }",
      schema: { ...version().schema, canonicalSdl: "type Query {\n  charge: String\n}", digest: `sha256:${"b".repeat(64)}` },
      baselineVersionId: "graphql-version-1",
      diff: {
        classification: "breaking",
        changes: [{ kind: "field_type_changed", coordinate: "Query.charge", classification: "breaking", migrationHint: "Update callers.", oldLocation: { source: "sdl", line: 1, column: 14 }, newLocation: { source: "sdl", line: 1, column: 14 } }],
        oracle: { breaking: ["FIELD_CHANGED_KIND"], dangerous: [] },
        oldDigest: `sha256:${"a".repeat(64)}`,
        newDigest: `sha256:${"b".repeat(64)}`,
      },
      createdAt: "2026-08-12T12:01:00.000Z",
    }));
    expect(second.record.diff.changes[0]).toMatchObject({ migrationHint: "Update callers." });
    expect(listGraphQLSchemaVersions(db, "tenant-a", "payments-api").map((row) => row.id)).toEqual(["graphql-version-2", "graphql-version-1"]);
    expect(getGraphQLSchemaVersionByLabel(db, "tenant-a", "payments-api", "2026-08-12.2")?.baselineVersionId).toBe("graphql-version-1");
  });

  it("retrieves exact old versions and preserves label uniqueness beyond the list window", () => {
    const db = open();
    insertGraphQLSchemaVersion(db, version());
    for (let index = 2; index <= 202; index += 1) {
      insertGraphQLSchemaVersion(db, version({
        id: `graphql-version-${index}`,
        evidenceId: `graphql-evidence-${index}`,
        sourceArtifactId: `graphql-source-artifact-${index}`,
        schemaArtifactId: `graphql-schema-artifact-${index}`,
        versionLabel: `2026-08-12.${index}`,
      }));
    }

    expect(getGraphQLSchemaVersion(db, "tenant-a", "payments-api", "graphql-version-1")?.versionLabel).toBe("2026-08-12.1");
    expect(getGraphQLSchemaVersionByLabel(db, "tenant-a", "payments-api", "2026-08-12.1")?.id).toBe("graphql-version-1");
    expect(() => insertGraphQLSchemaVersion(db, version({ sourceContent: "type Query { changed: ID! }" }))).toThrow("graphql_schema_version_label_conflict");
  });
});
