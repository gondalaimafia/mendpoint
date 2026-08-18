import { describe, expect, it } from "vitest";
import { diffOpenApi } from "./index.js";

/**
 * Regression coverage for two spec-differ defects:
 *
 *  - Defect 2: the success response was read only from `200`/`201`/`default`, so
 *    a field removed from a `202`/`203`/`2XX` body looked like no change, and a
 *    `200`->`2XX` renumbering read as the removal of every response field.
 *  - Defect 3: an unnormalized edit distance minted a confident rename between
 *    any two short unrelated fields (`iso` -> `tag`), which downstream drives a
 *    destructive whole-file token rewrite.
 */

type Schema = Record<string, unknown>;

/** POST /charges with a request body and a response at `status` carrying `resProps`. */
function specWith(
  status: string,
  reqProps: Schema,
  reqRequired: string[],
  resProps: Schema,
): unknown {
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
                schema: { type: "object", required: reqRequired, properties: reqProps },
              },
            },
          },
          responses: {
            [status]: {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "object", properties: resProps },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe("Defect 2: success response selection across the 2xx space", () => {
  const RES_FULL: Schema = { id: { type: "string" }, receipt_url: { type: "string" } };
  const RES_TRIMMED: Schema = { id: { type: "string" } };
  const REQ: Schema = { amount: { type: "integer" } };

  it("200 (control): a removed response field is breaking", () => {
    const diff = diffOpenApi(
      specWith("200", REQ, ["amount"], RES_FULL),
      specWith("200", REQ, ["amount"], RES_TRIMMED),
    );
    expect(
      diff.entries.some(
        (e) => e.op === "response_field_removed" && e.field === "receipt_url",
      ),
    ).toBe(true);
    expect(diff.risk).toBe("breaking");
  });

  for (const status of ["202", "203", "2XX"]) {
    it(`${status}: a removed response field is seen and is breaking`, () => {
      const diff = diffOpenApi(
        specWith(status, REQ, ["amount"], RES_FULL),
        specWith(status, REQ, ["amount"], RES_TRIMMED),
      );
      expect(
        diff.entries.some(
          (e) => e.op === "response_field_removed" && e.field === "receipt_url",
        ),
      ).toBe(true);
      expect(diff.risk).toBe("breaking");
    });
  }

  it("200 -> 2XX renumbering with an unchanged body is NOT a mass field removal", () => {
    const diff = diffOpenApi(
      specWith("200", REQ, ["amount"], RES_FULL),
      specWith("2XX", REQ, ["amount"], RES_FULL),
    );
    // Pairing old/new by equivalent success status means the body compares to the
    // body, not to nothing: no field looks removed or added.
    expect(diff.entries.some((e) => e.op === "response_field_removed")).toBe(false);
    expect(diff.entries.some((e) => e.op === "response_field_added")).toBe(false);
  });
});

describe("Defect 3: no confident rename between short unrelated fields", () => {
  it("dropping optional `iso` and adding unrelated optional `tag` is not a rename", () => {
    // Distinct schemas, no shared example: the ONLY thing that could link them is
    // raw edit distance (levenshtein('iso','tag') === 3). Length-normalized, they
    // are not plausible successors, so `iso` is a removal and `tag` an addition.
    const v1 = specWith(
      "200",
      { amount: { type: "integer" }, iso: { type: "string", description: "ISO currency code" } },
      ["amount"],
      { id: { type: "string" } },
    );
    const v2 = specWith(
      "200",
      { amount: { type: "integer" }, tag: { type: "string", description: "free-form label" } },
      ["amount"],
      { id: { type: "string" } },
    );

    const diff = diffOpenApi(v1, v2);
    expect(diff.entries.some((e) => e.op === "request_field_renamed")).toBe(false);
    expect(
      diff.entries.some((e) => e.op === "request_field_removed" && e.field === "iso"),
    ).toBe(true);
    expect(
      diff.entries.some((e) => e.op === "request_field_added" && e.field === "tag"),
    ).toBe(true);
  });

  it("a genuine short rename backed by a shared example is still asserted", () => {
    // Same example value on both sides: strong evidence they are the same field,
    // so the lone candidate is a confident rename even though the names are short.
    const v1 = specWith(
      "200",
      { amount: { type: "integer" }, iso: { type: "string", example: "USD" } },
      ["amount"],
      { id: { type: "string" } },
    );
    const v2 = specWith(
      "200",
      { amount: { type: "integer" }, ccy: { type: "string", example: "USD" } },
      ["amount"],
      { id: { type: "string" } },
    );

    const diff = diffOpenApi(v1, v2);
    expect(
      diff.entries.some(
        (e) =>
          e.op === "request_field_renamed" &&
          e.fromField === "iso" &&
          e.toField === "ccy",
      ),
    ).toBe(true);
  });
});
