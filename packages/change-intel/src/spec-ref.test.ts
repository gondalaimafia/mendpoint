import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffOpenApi, normalizeChange } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const meridianDir = join(root, "fixtures/providers/meridian-payments");

/** Minimal spec with one `POST /x` whose request body is a `$ref`. */
function specWithRequestRef(
  schemas: Record<string, unknown>,
  ref = "#/components/schemas/Req",
): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/x": {
        post: {
          operationId: "doX",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: ref } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: { schemas },
  };
}

/** Minimal spec with one `GET /x` whose 200 response is a `$ref`. */
function specWithResponseRef(
  schemas: Record<string, unknown>,
  ref = "#/components/schemas/Res",
): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/x": {
        get: {
          operationId: "getX",
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: ref } } },
            },
          },
        },
      },
    },
    components: { schemas },
  };
}

describe("change-intel $ref resolution", () => {
  it("detects a breaking field rename hidden behind a request $ref (real Meridian case)", () => {
    const v1 = JSON.parse(readFileSync(join(meridianDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(meridianDir, "openapi-v2.json"), "utf8"));
    const diff = diffOpenApi(v1, v2);

    // Was misclassified as new_capability before ref resolution existed.
    expect(diff.risk).toBe("breaking");

    const rename = diff.entries.find((e) => e.op === "request_field_renamed");
    expect(rename).toBeDefined();
    expect(rename?.path).toBe("/v1/charges");
    expect(rename?.method).toBe("post");
    expect(rename?.fromField).toBe("source");
    expect(rename?.toField).toBe("payment_method");

    // The two unrelated additive changes are reported separately, not conflated.
    expect(
      diff.entries.some((e) => e.op === "path_added" && e.path === "/v1/balance"),
    ).toBe(true);
    expect(
      diff.entries.some(
        (e) =>
          e.op === "request_field_added" &&
          e.field === "receipt_email" &&
          e.path === "/v1/charges",
      ),
    ).toBe(true);

    // Resolution was total: no unresolved/remote/cyclic refs.
    expect(diff.resolution.complete).toBe(true);
    expect(diff.resolution.issues).toHaveLength(0);
  });

  it("surfaces the ref-resolved rename through impactable surfaces", () => {
    const v1 = JSON.parse(readFileSync(join(meridianDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(meridianDir, "openapi-v2.json"), "utf8"));
    const { surfaces } = normalizeChange(v1, v2, { providerSlug: "meridian" });
    const renameSurface = surfaces.find((s) => s.op === "request_field_renamed");
    expect(renameSurface?.fromField).toBe("source");
    expect(renameSurface?.toField).toBe("payment_method");
    expect(renameSurface?.severity).toBe("breaking");
    expect(renameSurface?.searchTokens).toContain("source");
    expect(renameSurface?.searchTokens).toContain("payment_method");
  });

  it("detects a field removed behind a $ref", () => {
    const v1 = specWithRequestRef({
      Req: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
    });
    const v2 = specWithRequestRef({
      Req: { type: "object", properties: { a: { type: "string" } } },
    });
    const diff = diffOpenApi(v1, v2);
    expect(diff.risk).toBe("breaking");
    expect(
      diff.entries.some((e) => e.op === "request_field_removed" && e.field === "b"),
    ).toBe(true);
  });

  it("classifies a field added behind a $ref as additive, not breaking", () => {
    // Response field addition behind a ref.
    const rv1 = specWithResponseRef({
      Res: { type: "object", properties: { a: { type: "string" } } },
    });
    const rv2 = specWithResponseRef({
      Res: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
      },
    });
    const rDiff = diffOpenApi(rv1, rv2);
    expect(rDiff.entries.some((e) => e.op === "response_field_added" && e.field === "b")).toBe(true);
    expect(rDiff.entries.every((e) => e.breaking === false)).toBe(true);
    expect(rDiff.risk).toBe("new_capability");

    // Optional request field addition behind a ref is non-breaking too.
    const qv1 = specWithRequestRef({
      Req: { type: "object", required: ["a"], properties: { a: { type: "string" } } },
    });
    const qv2 = specWithRequestRef({
      Req: {
        type: "object",
        required: ["a"],
        properties: { a: { type: "string" }, note: { type: "string" } },
      },
    });
    const qDiff = diffOpenApi(qv1, qv2);
    const added = qDiff.entries.find((e) => e.op === "request_field_added");
    expect(added?.field).toBe("note");
    expect(added?.breaking).toBe(false);
    expect(qDiff.risk).toBe("non_breaking");
  });

  it("terminates on a cyclic (mutually recursive) schema pair and still diffs", () => {
    // A composes B composes A: a cycle through allOf/$ref at the schema root.
    const schemas = (bProps: Record<string, unknown>) => ({
      A: {
        allOf: [
          { $ref: "#/components/schemas/B" },
          { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        ],
      },
      B: {
        allOf: [
          { $ref: "#/components/schemas/A" },
          { type: "object", properties: bProps },
        ],
      },
    });
    const v1 = specWithRequestRef(schemas({ b: { type: "string" } }), "#/components/schemas/A");
    const v2 = specWithRequestRef(schemas({}), "#/components/schemas/A");

    const diff = diffOpenApi(v1, v2);
    // The field carried through the cyclic composition was seen and its removal caught.
    expect(diff.entries.some((e) => e.op === "request_field_removed" && e.field === "b")).toBe(true);
    // The cycle was bounded, not silently followed to exhaustion.
    expect(diff.resolution.complete).toBe(false);
    expect(diff.resolution.issues.some((i) => i.kind === "cycle_bounded")).toBe(true);
  });

  it("does not lose a field carried through allOf composition", () => {
    const v1 = specWithRequestRef({
      Base: { type: "object", properties: { inherited: { type: "string" } } },
      Req: {
        allOf: [
          { $ref: "#/components/schemas/Base" },
          { type: "object", properties: { own: { type: "string" } } },
        ],
      },
    });
    const v2 = specWithRequestRef({
      Base: { type: "object", properties: {} },
      Req: {
        allOf: [
          { $ref: "#/components/schemas/Base" },
          { type: "object", properties: { own: { type: "string" } } },
        ],
      },
    });
    const diff = diffOpenApi(v1, v2);
    // If the allOf-inherited field were lost, this removal would go undetected.
    expect(
      diff.entries.some((e) => e.op === "request_field_removed" && e.field === "inherited"),
    ).toBe(true);
  });

  it("refuses a remote/external $ref and records it instead of fetching", () => {
    const external = "https://attacker.example/schema.json#/Req";
    const v1 = specWithRequestRef({}, external);
    const v2 = specWithRequestRef({}, external);
    const diff = diffOpenApi(v1, v2);
    const issue = diff.resolution.issues.find((i) => i.kind === "external_ref");
    expect(issue).toBeDefined();
    expect(issue?.ref).toBe(external);
    expect(diff.resolution.complete).toBe(false);
  });

  it("records an unresolvable local $ref rather than treating it as empty", () => {
    const v1 = specWithRequestRef({
      Req: { type: "object", properties: { a: { type: "string" } } },
    });
    // v2 points the request body at a schema that does not exist.
    const v2 = specWithRequestRef({}, "#/components/schemas/Missing");
    const diff = diffOpenApi(v1, v2);
    const issue = diff.resolution.issues.find((i) => i.kind === "unresolvable_ref");
    expect(issue).toBeDefined();
    expect(issue?.ref).toBe("#/components/schemas/Missing");
    expect(diff.resolution.complete).toBe(false);
  });

  it("resolves a requestBody-level component $ref, not only schema-level", () => {
    const spec = (fields: Record<string, unknown>, required: string[]) => ({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            operationId: "doX",
            requestBody: { $ref: "#/components/requestBodies/XBody" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        requestBodies: {
          XBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Req" } },
            },
          },
        },
        schemas: { Req: { type: "object", required, properties: fields } },
      },
    });
    const v1 = spec({ a: { type: "string" } }, ["a"]);
    const v2 = spec({ a: { type: "string" }, a2: { type: "string" } }, ["a", "a2"]);
    const diff = diffOpenApi(v1, v2);
    expect(
      diff.entries.some((e) => e.op === "request_field_added_required" && e.field === "a2"),
    ).toBe(true);
    expect(diff.resolution.complete).toBe(true);
  });

  it("finds field-level changes on a real-structure Stripe extract (form-urlencoded + $ref response)", () => {
    const dir = join(root, "fixtures/providers/stripe-charges-trimmed");
    const v1 = JSON.parse(readFileSync(join(dir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(dir, "openapi-v2.json"), "utf8"));
    const diff = diffOpenApi(v1, v2);

    const fieldOps = new Set([
      "request_field_renamed",
      "request_field_removed",
      "request_field_added_required",
      "request_field_added",
      "response_field_removed",
      "response_field_added",
    ]);
    const fieldLevel = diff.entries.filter((e) => fieldOps.has(e.op));

    // The headline: field-level entries are non-zero on a realistic spec whose
    // request body is form-urlencoded and whose response is a $ref.
    expect(fieldLevel.length).toBeGreaterThan(0);
    expect(diff.risk).toBe("breaking");

    // The Stripe-era rename, behind a form-urlencoded body, read as a rename.
    expect(
      diff.entries.some(
        (e) =>
          e.op === "request_field_renamed" &&
          e.path === "/v1/charges" &&
          e.fromField === "source" &&
          e.toField === "payment_method",
      ),
    ).toBe(true);
    // A required field removed from the request reads as breaking.
    expect(
      diff.entries.some(
        (e) => e.op === "request_field_removed" && e.field === "capture" && e.breaking,
      ),
    ).toBe(true);
    // A field removed from the response schema *behind the $ref* is seen.
    expect(
      diff.entries.some(
        (e) => e.op === "response_field_removed" && e.field === "disputed" && e.breaking,
      ),
    ).toBe(true);
    // Nested unresolved refs inside `charge` (customer) are never dereferenced
    // by a top-level flatten, so resolution stays complete.
    expect(diff.resolution.complete).toBe(true);
  });

  // Full 8 MB Stripe pair. Skipped unless both env vars point at local files, so
  // multi-megabyte specs never enter the repo. Exercises cycle/perf at real scale.
  const realV1 = process.env.MENDPOINT_STRIPE_SPEC_V1;
  const realV2 = process.env.MENDPOINT_STRIPE_SPEC_V2;
  it.skipIf(!realV1 || !realV2)(
    "diffs the full real Stripe spec pair within a time bound and terminates",
    () => {
      const v1 = JSON.parse(readFileSync(realV1 as string, "utf8"));
      const v2 = JSON.parse(readFileSync(realV2 as string, "utf8"));
      const started = performance.now();
      const diff = diffOpenApi(v1, v2);
      const elapsedMs = performance.now() - started;
      // A correct implementation descends into schemas, so it is slower than the
      // "3 ms doing nothing" baseline, but it must stay well clear of pathological.
      expect(elapsedMs).toBeLessThan(5000);
      expect(Array.isArray(diff.entries)).toBe(true);
      expect(diff.resolution).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(
        `[real-stripe] entries=${diff.entries.length} elapsedMs=${elapsedMs.toFixed(1)} resolutionComplete=${diff.resolution.complete} issues=${diff.resolution.issues.length}`,
      );
    },
  );

  it("keeps inline (non-ref) specs total in the resolution report", () => {
    const inlineDir = join(root, "fixtures/providers/acme-payments");
    const v1 = JSON.parse(readFileSync(join(inlineDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(inlineDir, "openapi-v2.json"), "utf8"));
    const diff = diffOpenApi(v1, v2);
    expect(diff.resolution.complete).toBe(true);
    expect(diff.resolution.issues).toHaveLength(0);
    // Behaviour unchanged: the inline rename is still caught.
    expect(
      diff.entries.some(
        (e) =>
          e.op === "request_field_renamed" &&
          e.fromField === "amount_cents" &&
          e.toField === "amount",
      ),
    ).toBe(true);
  });
});
