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
      contractCases: [
        {
          id: "a",
          name: "a",
          requiredKeys: ["x"],
          responseBody: { x: 1 },
        },
      ],
    });
    expect(r.reportMarkdown).toContain("Warden PR gates");
    expect(r.ok).toBe(true);
  });
});
