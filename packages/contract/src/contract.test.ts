import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  breakingChangeGate,
  evaluatePrGates,
  reviewOpenApiDesign,
  runContractSuite,
} from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("contract suite", () => {
  it("flags missing keys and auth", () => {
    const r = runContractSuite([
      {
        id: "c1",
        name: "charge",
        requiredKeys: ["id", "amount"],
        responseBody: { id: "ch_1" },
        requireAuth: true,
        requestHeaders: {},
      },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "schema_key_missing")).toBe(true);
    expect(r.violations.some((v) => v.kind === "auth_missing")).toBe(true);
  });

  it("passes clean case", () => {
    const r = runContractSuite([
      {
        id: "c1",
        name: "ok",
        requiredKeys: ["id"],
        responseBody: { id: "1" },
        requireAuth: true,
        requestHeaders: { Authorization: "Bearer x" },
      },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("breaking change gate", () => {
  it("detects acme fixture breaking rename", () => {
    const v1 = JSON.parse(
      readFileSync(join(root, "fixtures/providers/acme-payments/openapi-v1.json"), "utf8"),
    );
    const v2 = JSON.parse(
      readFileSync(join(root, "fixtures/providers/acme-payments/openapi-v2.json"), "utf8"),
    );
    const g = breakingChangeGate(v1, v2, "acme-payments");
    // Acme v2 is a breaking evolution.
    expect(g.ok).toBe(false);
    expect(g.violations.length).toBeGreaterThan(0);
    expect(g.violations.every((violation) => violation.message.trim().length > 0)).toBe(true);
    expect(g.summary.length).toBeGreaterThan(0);
  });

  it("fails closed when expected response evidence is absent", () => {
    const r = runContractSuite(
      [
        {
          id: "c1",
          name: "missing",
          expectStatus: 200,
          requiredKeys: ["id"],
        },
      ],
      { observedStatuses: {} },
    );
    expect(r.ok).toBe(false);
    expect(r.violations.filter((v) => v.kind === "evidence_missing")).toHaveLength(2);
  });

  it("fails closed when the contract suite has no cases", () => {
    const r = runContractSuite([]);
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual(
      expect.objectContaining({ caseId: "contract-suite", kind: "evidence_missing" }),
    );
  });
});

describe("api reviewer", () => {
  it("scores openapi and mentions categories", () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/items": {
          get: {
            responses: { "200": { description: "ok" } },
          },
          post: {
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const r = reviewOpenApiDesign(spec);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.markdown).toContain("API reviewer");
  });
});

describe("pr gates", () => {
  it("aggregates gates markdown", () => {
    const r = evaluatePrGates({
      oldSpec: { openapi: "3.0.0", paths: {} },
      newSpec: { openapi: "3.0.0", paths: {} },
      contractCases: [
        {
          id: "a",
          name: "a",
          requiredKeys: ["x"],
          responseBody: { x: 1 },
        },
      ],
      securityScanOk: true,
    });
    expect(r.reportMarkdown).toContain("Warden PR gates");
    expect(r.ok).toBe(true);
  });

  it("fails closed when gate evidence is not supplied", () => {
    const r = evaluatePrGates({});
    expect(r.ok).toBe(false);
    expect(r.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "oas-breaking-change", ok: false }),
        expect.objectContaining({ id: "security-scan", ok: false }),
      ]),
    );
  });

  it("labels a caller-supplied security gate as attested, not verified", () => {
    const r = evaluatePrGates({
      oldSpec: { openapi: "3.0.0", paths: {} },
      newSpec: { openapi: "3.0.0", paths: {} },
      contractCases: [
        { id: "a", name: "a", requiredKeys: ["x"], responseBody: { x: 1 } },
      ],
      securityScanAttested: true,
    });

    const sec = r.gates.find((g) => g.id === "security-scan");
    expect(sec?.ok).toBe(true);
    // Provenance is explicit in the type: the security gate is never "verified".
    expect(sec?.verified).toBe(false);
    expect(sec?.detail).toMatch(/attested/i);
    expect(sec?.detail).not.toMatch(/scan passed/i);
    // Structural gates remain verified.
    expect(r.gates.find((g) => g.id === "contract-suite")?.verified).toBe(true);
    // The rendered PR evidence warns a reviewer the pass is unverified.
    expect(r.reportMarkdown).toMatch(/attested, not verified/i);
  });

  it("still accepts the legacy securityScanOk alias and stays fail-closed", () => {
    const attested = evaluatePrGates({ securityScanOk: true });
    expect(attested.gates.find((g) => g.id === "security-scan")?.ok).toBe(true);

    const missing = evaluatePrGates({ securityScanOk: false });
    expect(missing.gates.find((g) => g.id === "security-scan")?.ok).toBe(false);
  });
});
