import { describe, expect, it } from "vitest";
import {
  CHANGE_TAXONOMY_KINDS,
  createUnifiedSourceArtifact,
  getMonitorHealth,
  listUnifiedSourceArtifacts,
  normalizeOpenApiSourceInput,
  openUnifiedChangeEvidenceStore,
  recordMonitorObservation,
  registerMonitorSchedule,
  taxonomySignalsFromOpenApi,
} from "./unified-change-evidence.js";

const now = "2026-08-02T12:00:00.000Z";

function source(sourceKind: "feed" | "release" | "sdk_registry" | "poll" | "provider_announcement" | "customer_incident") {
  return {
    tenantId: "tenant-a",
    sourceKind,
    sourceUri: `https://provider.example/${sourceKind}`,
    providerSlug: "provider",
    contentType: "application/json",
    content: { sourceKind, value: 1 },
    observedAt: now,
    capturedAt: now,
    capturedBy: "worker:catalog",
  } as const;
}

describe("unified change source evidence", () => {
  it("stores every automated and human source in one immutable tenant envelope", () => {
    const store = openUnifiedChangeEvidenceStore();
    try {
      const openapi = normalizeOpenApiSourceInput({
        tenantId: "tenant-a",
        sourceUri: "urn:mendpoint:source:upload:42",
        providerSlug: "provider",
        content: JSON.stringify({ openapi: "3.1.0", paths: { "/v1/items": { get: { responses: { "200": { description: "ok" } } } } } }),
        observedAt: now,
        capturedAt: now,
        capturedBy: "principal:reviewer",
      });
      const inputs = [openapi, source("poll"), source("feed"), source("release"), source("sdk_registry"), source("provider_announcement"), source("customer_incident")];
      for (const input of inputs) createUnifiedSourceArtifact(store, input);
      expect(listUnifiedSourceArtifacts(store, "tenant-a").map((item) => item.sourceKind).sort()).toEqual([
        "customer_incident", "feed", "openapi_upload", "poll", "provider_announcement", "release", "sdk_registry",
      ]);
      expect(listUnifiedSourceArtifacts(store, "tenant-b")).toEqual([]);

      const first = createUnifiedSourceArtifact(store, source("release"));
      const duplicate = createUnifiedSourceArtifact(store, { ...source("release"), id: "ignored-on-idempotent-replay" });
      expect(duplicate.id).toBe(first.id);
      expect(() => store.raw.prepare("UPDATE unified_change_source_artifacts SET content = 'changed'").run()).toThrow("append_only");
      expect(() => createUnifiedSourceArtifact(store, { ...source("release"), taxonomySignals: [{ kind: "behavioral", subject: "retry", before: 1, after: 2, breaking: true, evidenceLocation: "release.body" }] })).toThrow("change_artifact_identity_conflict");
    } finally { store.close(); }
  });

  it("emits every documented taxonomy kind from a deterministic OpenAPI comparison", () => {
    const prior = {
      openapi: "3.1.0",
      servers: [{ url: "https://old.example" }],
      security: [{ bearer: [] }],
      paths: {
        "/v1/items": {
          get: {
            deprecated: false,
            security: [{ bearer: [] }],
            "x-mendpoint-behavior": { pagination: "offset" },
            parameters: [{ in: "header", name: "X-Old", schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: { required: ["mode"], properties: {
              mode: { type: "string", format: "uuid", enum: ["a", "b"], minLength: 1 },
              removed: { type: "integer" },
            } } } } },
            responses: { "200": { headers: { "X-Rate": { schema: { type: "integer" } } }, content: { "application/json": { schema: { properties: { id: { type: "string" } } } } } } },
          },
        },
      },
    };
    const current = {
      openapi: "3.1.0",
      servers: [{ url: "https://new.example" }],
      security: [{ oauth: ["read"] }],
      paths: {
        "/v1/items": {
          get: {
            deprecated: true,
            security: [{ oauth: ["read"] }],
            "x-mendpoint-behavior": { pagination: "cursor" },
            parameters: [{ in: "header", name: "X-New", schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: { properties: {
              mode: { type: "number", format: "float", enum: ["c"], maximum: 10 },
              added: { type: "string" },
            } } } } },
            responses: { "201": { headers: { "X-Next": { schema: { type: "string" } } }, content: { "application/json": { schema: { properties: { id: { type: "number" } } } } } } },
          },
        },
        "/v1/new": { post: { responses: { "204": { description: "done" } } } },
      },
    };
    const signals = taxonomySignalsFromOpenApi(prior, current);
    expect([...new Set(signals.map((item) => item.kind))].sort()).toEqual([...CHANGE_TAXONOMY_KINDS].sort());
    expect(signals.every((item) => item.evidenceLocation && typeof item.breaking === "boolean")).toBe(true);
    expect(signals.find((item) => item.kind === "endpoint" && item.subject === "POST /v1/new")?.breaking).toBe(false);
    expect(signals.find((item) => item.kind === "field" && item.subject.endsWith(":removed"))?.breaking).toBe(true);
  });

  it("persists monitor observations and derives stale and degraded operator health", () => {
    const store = openUnifiedChangeEvidenceStore();
    try {
      const schedule = registerMonitorSchedule(store, {
        id: "stripe-feed", tenantId: "tenant-a", sourceUri: "https://provider.example/releases.xml",
        sourceKind: "feed", intervalSeconds: 300, maxStalenessSeconds: 900, enabled: true, createdAt: now,
      });
      expect(getMonitorHealth(store, "tenant-a", schedule.id, now)).toMatchObject({ state: "never_observed", operatorActionRequired: true });
      const artifact = createUnifiedSourceArtifact(store, source("feed"));
      recordMonitorObservation(store, { tenantId: "tenant-a", scheduleId: schedule.id, status: "success", observedAt: "2026-08-02T12:01:00.000Z", artifactId: artifact.id });
      expect(getMonitorHealth(store, "tenant-a", schedule.id, "2026-08-02T12:10:00.000Z")).toMatchObject({ state: "healthy", operatorActionRequired: false });
      recordMonitorObservation(store, { tenantId: "tenant-a", scheduleId: schedule.id, status: "error", observedAt: "2026-08-02T12:11:00.000Z", errorCode: "http_503" });
      expect(getMonitorHealth(store, "tenant-a", schedule.id, "2026-08-02T12:12:00.000Z")).toMatchObject({ state: "degraded", operatorActionRequired: true });
      expect(getMonitorHealth(store, "tenant-a", schedule.id, "2026-08-02T12:27:00.001Z")).toMatchObject({ state: "stale", operatorActionRequired: true });
      expect(() => recordMonitorObservation(store, { tenantId: "tenant-a", scheduleId: schedule.id, status: "success", observedAt: "2026-08-02T12:11:00.000Z", artifactId: artifact.id })).toThrow("monitor_observation_time_not_monotonic");
      expect(() => store.raw.prepare("DELETE FROM change_source_monitor_observations").run()).toThrow("append_only");
    } finally { store.close(); }
  });

  it("rejects unsafe sources and malformed provenance", () => {
    const store = openUnifiedChangeEvidenceStore();
    try {
      expect(() => createUnifiedSourceArtifact(store, { ...source("feed"), sourceUri: "http://provider.example/feed" })).toThrow("source_uri_unsafe");
      expect(() => createUnifiedSourceArtifact(store, { ...source("feed"), sourceUri: "https://provider.example/feed?token=secret" })).toThrow("source_uri_unsafe");
      expect(() => createUnifiedSourceArtifact(store, { ...source("feed"), capturedAt: "2026-08-02T11:59:00.000Z" })).toThrow("provenance_time_invalid");
      expect(() => normalizeOpenApiSourceInput({ tenantId: "tenant-a", sourceUri: "urn:mendpoint:source:upload:bad", providerSlug: "p", content: "{}", observedAt: now, capturedAt: now, capturedBy: "p" })).toThrow("openapi_upload_document_invalid");
    } finally { store.close(); }
  });
});
