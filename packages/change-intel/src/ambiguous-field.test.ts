import { describe, expect, it } from "vitest";
import { diffOpenApi } from "./index.js";

/** Minimal OpenAPI doc with one POST request body schema at `path`. */
function specWithPath(path: string, props: Record<string, unknown>, required: string[]): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      [path]: {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChargeCreate" },
              },
            },
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ChargeCreate" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { ChargeCreate: { type: "object", required, properties: props } },
    },
  };
}

/** Minimal OpenAPI doc with one POST /charges request body schema. */
function specWith(props: Record<string, unknown>, required: string[]): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/charges": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChargeCreate" },
              },
            },
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ChargeCreate" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { ChargeCreate: { type: "object", required, properties: props } },
    },
  };
}

const SOURCE = {
  type: "string",
  description: "Payment source token (v1 name).",
  example: "pm_1AbCdEf",
};

describe("ambiguous field changes (abstain, do not guess)", () => {
  it("two plausible successors ⇒ ambiguous entry, no asserted rename", () => {
    const v1 = specWith({ amount: { type: "integer" }, source: SOURCE }, ["amount", "source"]);
    const v2 = specWith(
      {
        amount: { type: "integer" },
        // Same type + copied example as `source`: a plausible successor even
        // though the name and description differ.
        payment_method: {
          type: "string",
          description: "renamed from source",
          example: "pm_1AbCdEf",
        },
        // Lexical substring of `source`: the second plausible successor.
        payment_source: { type: "string", description: "bank/ACH successor" },
      },
      ["amount", "payment_method"],
    );

    const diff = diffOpenApi(v1, v2);
    const ambiguous = diff.entries.filter((e) => e.op === "request_field_ambiguous");
    const renames = diff.entries.filter((e) => e.op === "request_field_renamed");

    expect(renames).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]!.fromField).toBe("source");
    expect(ambiguous[0]!.candidates).toEqual(
      expect.arrayContaining(["payment_method", "payment_source"]),
    );
    // Neither successor is emitted as a plain added/removed field...
    expect(diff.entries.some((e) => e.op === "request_field_removed" && e.field === "source")).toBe(
      false,
    );
    expect(
      diff.entries.some(
        (e) =>
          (e.op === "request_field_added" || e.op === "request_field_added_required") &&
          (e.field === "payment_method" || e.field === "payment_source"),
      ),
    ).toBe(false);
    // ...and the summary names it a human decision.
    expect(diff.summary).toContain("ambiguous field source");
    expect(diff.risk).toBe("breaking");
  });

  it("one successor ⇒ confident rename (no regression)", () => {
    const v1 = specWith({ amount: { type: "integer" }, source: SOURCE }, ["amount", "source"]);
    const v2 = specWith(
      {
        amount: { type: "integer" },
        payment_method: {
          type: "string",
          description: "renamed from source",
          example: "pm_1AbCdEf",
        },
        // A genuinely unrelated new field (different shape, no shared example) is
        // NOT a plausible successor and must not create ambiguity.
        receipt_email: { type: "string", format: "email" },
      },
      ["amount", "payment_method"],
    );

    const diff = diffOpenApi(v1, v2);
    const ambiguous = diff.entries.filter((e) => e.op === "request_field_ambiguous");
    const renames = diff.entries.filter((e) => e.op === "request_field_renamed");

    expect(ambiguous).toHaveLength(0);
    expect(renames).toHaveLength(1);
    expect(renames[0]!.fromField).toBe("source");
    expect(renames[0]!.toField).toBe("payment_method");
  });

  // The intersection of the two features that meet in this file's diff: a path
  // that is BOTH version-bumped (so it is only reached through version-normalized
  // pairing, not exact-key matching) AND whose field has more than one plausible
  // successor. If version pairing ran a stale copy of the operation diff, it would
  // resume guessing a successor exactly where the change is hardest. It must run
  // the same ambiguity-aware logic and abstain.
  it("version-bumped path with two plausible successors ⇒ abstains, never guesses", () => {
    const v1 = specWithPath("/v1/charges", { amount: { type: "integer" }, source: SOURCE }, [
      "amount",
      "source",
    ]);
    const v2 = specWithPath(
      "/v2/charges",
      {
        amount: { type: "integer" },
        payment_method: {
          type: "string",
          description: "renamed from source",
          example: "pm_1AbCdEf",
        },
        payment_source: { type: "string", description: "bank/ACH successor" },
      },
      ["amount", "payment_method"],
    );

    const diff = diffOpenApi(v1, v2);
    // The version bump is still reported and still anchors provenance.
    expect(
      diff.entries.some((e) => e.op === "path_removed" && e.path === "/v1/charges"),
    ).toBe(true);
    expect(
      diff.entries.some((e) => e.op === "path_added" && e.path === "/v2/charges"),
    ).toBe(true);

    const ambiguous = diff.entries.filter((e) => e.op === "request_field_ambiguous");
    const renames = diff.entries.filter((e) => e.op === "request_field_renamed");

    // Ambiguity is detected on the version-paired operation and recorded against
    // the OLD (v1) path, and no successor is guessed.
    expect(renames).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]!.path).toBe("/v1/charges");
    expect(ambiguous[0]!.fromField).toBe("source");
    expect(ambiguous[0]!.candidates).toEqual(
      expect.arrayContaining(["payment_method", "payment_source"]),
    );
    // Neither successor leaks out as a plain added/removed field.
    expect(
      diff.entries.some((e) => e.op === "request_field_removed" && e.field === "source"),
    ).toBe(false);
    expect(
      diff.entries.some(
        (e) =>
          (e.op === "request_field_added" || e.op === "request_field_added_required") &&
          (e.field === "payment_method" || e.field === "payment_source"),
      ),
    ).toBe(false);
    expect(diff.summary).toContain("ambiguous field source");
    expect(diff.risk).toBe("breaking");
  });
});
