import {
  GraphQLSchemaError,
  diffGraphQLSchemas,
  normalizeGraphQLSchema,
  type GraphQLSchemaDiff,
} from "@mendpoint/change-intel";
import {
  getGraphQLSchemaSourceContent,
  getGraphQLSchemaVersion,
  getGraphQLSchemaVersionByLabel,
  insertGraphQLSchemaVersion,
  listGraphQLSchemaVersions,
  type AppDb,
  type GraphQLSchemaVersionRecord,
} from "@mendpoint/db";
import { newId } from "@mendpoint/shared";
import { can, type Principal } from "@mendpoint/platform";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";

const MAX_REQUEST_BYTES = 2_050_000;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,199}$/;
const REQUEST_KEYS = new Set(["baselineVersionId", "format", "schema", "versionLabel"]);

type InputFormat = "sdl" | "introspection";
type IngestBody = Readonly<{
  versionLabel: string;
  format: InputFormat;
  schema: string | Record<string, unknown>;
  baselineVersionId?: string;
}>;

export type GraphQLSchemaIngestionRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  now?: () => string;
}>;

export function graphqlSchemaIngestionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MENDPOINT_GRAPHQL_INGESTION_ENABLED === "1";
}

function tenant(c: Context<ApiEnv>): { tenantId: string; principal: Principal; trustPrincipalId: string } | undefined {
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  if (!principal?.tenantId.trim() || !trustPrincipalId?.trim()) return undefined;
  return { tenantId: principal.tenantId, principal, trustPrincipalId };
}

function publicRecord(record: GraphQLSchemaVersionRecord, replayed = false) {
  return {
    id: record.id,
    sourceKey: record.sourceKey,
    versionLabel: record.versionLabel,
    sourceFormat: record.sourceFormat,
    sourceSha256: record.sourceSha256,
    sourceArtifactId: record.sourceArtifactId,
    schemaArtifactId: record.schemaArtifactId,
    evidenceId: record.evidenceId,
    baselineVersionId: record.baselineVersionId,
    classification: record.diff.classification,
    changes: record.diff.changes,
    oracle: record.diff.oracle,
    schema: record.schema,
    createdAt: record.createdAt,
    replayed,
  };
}

function error(c: Context<ApiEnv>, caught: unknown) {
  const code = caught instanceof Error ? caught.message : "graphql_ingestion_failed";
  if (code === "graphql_schema_baseline_not_found") return c.json({ error: code }, 404);
  if (code === "graphql_schema_version_label_conflict") return c.json({ error: code }, 409);
  if (code === "graphql_request_too_large" || (caught instanceof GraphQLSchemaError && caught.code === "INPUT_TOO_LARGE")) return c.json({ error: "graphql_request_too_large" }, 413);
  if (caught instanceof GraphQLSchemaError) return c.json({ error: caught.code, message: caught.message }, 400);
  if (code.startsWith("graphql_")) return c.json({ error: code }, 400);
  throw caught;
}

async function body(c: Context<ApiEnv>): Promise<{ parsed: IngestBody; sourceContent: string }> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error("graphql_request_too_large");
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) throw new Error("graphql_request_too_large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("graphql_request_json_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("graphql_request_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) throw new Error("graphql_request_keys_invalid");
  if (!VERSION_LABEL.test(String(input.versionLabel ?? ""))) throw new Error("graphql_version_label_invalid");
  if (input.format !== "sdl" && input.format !== "introspection") throw new Error("graphql_format_invalid");
  if (input.baselineVersionId !== undefined && (typeof input.baselineVersionId !== "string" || !input.baselineVersionId.trim())) throw new Error("graphql_baseline_version_id_invalid");
  if (input.format === "sdl" && (typeof input.schema !== "string" || !input.schema.trim())) throw new Error("graphql_schema_format_mismatch");
  if (input.format === "introspection" && (!input.schema || typeof input.schema !== "object" || Array.isArray(input.schema))) throw new Error("graphql_schema_format_mismatch");
  const parsed = input as unknown as IngestBody;
  return { parsed, sourceContent: parsed.format === "sdl" ? parsed.schema as string : JSON.stringify(parsed.schema) };
}

function sourceInput(format: InputFormat, content: string): string | Record<string, unknown> {
  if (format === "sdl") return content;
  try { return JSON.parse(content) as Record<string, unknown>; } catch { throw new Error("graphql_schema_version_corrupt"); }
}

function initialDiff(digest: string): GraphQLSchemaVersionRecord["diff"] {
  return { classification: "non_breaking", changes: [], oracle: { breaking: [], dangerous: [] }, oldDigest: null, newDigest: digest };
}

function storedDiff(diff: GraphQLSchemaDiff): GraphQLSchemaVersionRecord["diff"] {
  return { classification: diff.classification, changes: diff.changes, oracle: diff.oracle, oldDigest: diff.oldSchema.digest, newDigest: diff.newSchema.digest };
}

export function createGraphQLSchemaIngestionRoutes(options: GraphQLSchemaIngestionRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }
  const now = options.now ?? (() => new Date().toISOString());

  routes.post("/:sourceKey/versions", async (c) => {
    const identity = tenant(c);
    if (!identity) return c.json({ error: "authenticated_principal_required" }, 401);
    if (!can(identity.principal, "graph:write")) return c.json({ error: "forbidden" }, 403);
    const sourceKey = c.req.param("sourceKey");
    if (!SOURCE_KEY.test(sourceKey)) return c.json({ error: "graphql_source_key_invalid" }, 400);
    try {
      const request = await body(c);
      const normalized = normalizeGraphQLSchema(sourceInput(request.parsed.format, request.sourceContent));
      const existing = getGraphQLSchemaVersionByLabel(options.db, identity.tenantId, sourceKey, request.parsed.versionLabel);
      if (existing) {
        if (request.parsed.baselineVersionId) {
          const requestedBaseline = getGraphQLSchemaVersion(options.db, identity.tenantId, sourceKey, request.parsed.baselineVersionId);
          if (!requestedBaseline) throw new Error("graphql_schema_baseline_not_found");
          if (existing.baselineVersionId !== requestedBaseline.id) throw new Error("graphql_schema_version_label_conflict");
        }
        const exact = getGraphQLSchemaSourceContent(options.db, identity.tenantId, existing.sourceArtifactId);
        if (exact === request.sourceContent && existing.sourceFormat === request.parsed.format && existing.schema.digest === normalized.digest) return c.json(publicRecord(existing, true), 200);
        throw new Error("graphql_schema_version_label_conflict");
      }
      const versions = listGraphQLSchemaVersions(options.db, identity.tenantId, sourceKey, 200);
      const baseline = request.parsed.baselineVersionId
        ? getGraphQLSchemaVersion(options.db, identity.tenantId, sourceKey, request.parsed.baselineVersionId)
        : versions[0];
      if (request.parsed.baselineVersionId && !baseline) throw new Error("graphql_schema_baseline_not_found");
      const diff = baseline
        ? diffGraphQLSchemas(
            sourceInput(baseline.sourceFormat, getGraphQLSchemaSourceContent(options.db, identity.tenantId, baseline.sourceArtifactId) ?? ""),
            sourceInput(request.parsed.format, request.sourceContent),
          )
        : undefined;
      const suffix = newId();
      const inserted = insertGraphQLSchemaVersion(options.db, {
        id: `graphql-version-${suffix}`,
        evidenceId: `graphql-evidence-${suffix}`,
        sourceArtifactId: `graphql-source-${suffix}`,
        schemaArtifactId: `graphql-schema-${suffix}`,
        tenantId: identity.tenantId,
        sourceKey,
        versionLabel: request.parsed.versionLabel,
        sourceFormat: request.parsed.format,
        sourceContent: request.sourceContent,
        schema: normalized,
        baselineVersionId: baseline?.id ?? null,
        diff: diff ? storedDiff(diff) : initialDiff(normalized.digest),
        producerPrincipalId: identity.trustPrincipalId,
        createdAt: now(),
      });
      c.header("Location", `/graphql/schemas/${sourceKey}/versions/${inserted.record.id}`);
      c.header("Cache-Control", "no-store");
      return c.json(publicRecord(inserted.record, !inserted.inserted), inserted.inserted ? 201 : 200);
    } catch (caught) {
      return error(c, caught);
    }
  });

  routes.get("/:sourceKey/versions", (c) => {
    const identity = tenant(c);
    if (!identity) return c.json({ error: "authenticated_principal_required" }, 401);
    if (!can(identity.principal, "graph:read")) return c.json({ error: "forbidden" }, 403);
    const sourceKey = c.req.param("sourceKey");
    if (!SOURCE_KEY.test(sourceKey)) return c.json({ error: "graphql_source_key_invalid" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json({ versions: listGraphQLSchemaVersions(options.db, identity.tenantId, sourceKey).map((record) => publicRecord(record)) });
  });

  routes.get("/:sourceKey/versions/:versionId", (c) => {
    const identity = tenant(c);
    if (!identity) return c.json({ error: "authenticated_principal_required" }, 401);
    if (!can(identity.principal, "graph:read")) return c.json({ error: "forbidden" }, 403);
    const record = getGraphQLSchemaVersion(options.db, identity.tenantId, c.req.param("sourceKey"), c.req.param("versionId"));
    if (!record) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(publicRecord(record));
  });

  return routes;
}
