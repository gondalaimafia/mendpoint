import { describe, expect, it } from "vitest";
import { parseChangelogEntry } from "./changelog-parse.js";

describe("parseChangelogEntry", () => {
  it("extracts field and date from deprecation blurb", () => {
    const r = parseChangelogEntry(
      "Deprecating request field amount_cents on 2026-12-01. Use amount.",
    );
    expect(r.fields).toContain("amount_cents");
    expect(r.deprecationAt).toBe("2026-12-01");
    expect(r.replacements[0]).toMatchObject({ from: "amount_cents", to: "amount" });
  });

  it("parses rename arrow and path tokens", () => {
    const r = parseChangelogEntry(
      "## Breaking\n- **Rename:** `amount_cents` → `amount` on charge create.\n- Removed GET /v1/charges/{id}/receipt",
    );
    expect(r.replacements.some((x) => x.from === "amount_cents" && x.to === "amount")).toBe(
      true,
    );
    expect(r.fields).toContain("amount_cents");
    expect(r.fields).toContain("amount");
    expect(r.fields.some((f) => f.includes("/v1/charges"))).toBe(true);
    expect(r.summary.length).toBeGreaterThan(0);
  });

  it("parses replace X with Y", () => {
    const r = parseChangelogEntry(
      "We replaced max_tokens with max_completion_tokens for chat completions.",
    );
    expect(r.replacements).toContainEqual({
      from: "max_tokens",
      to: "max_completion_tokens",
    });
    expect(r.fields).toContain("max_tokens");
    expect(r.fields).toContain("max_completion_tokens");
  });

  it("parses prose deprecation date", () => {
    const r = parseChangelogEntry(
      "The Body field is deprecated as of December 1, 2026. Use Content.",
    );
    expect(r.deprecationAt).toBe("2026-12-01");
    expect(r.replacements.some((x) => x.from === "Body" && x.to === "Content")).toBe(true);
  });

  it("handles empty input", () => {
    const r = parseChangelogEntry("");
    expect(r.fields).toEqual([]);
    expect(r.replacements).toEqual([]);
    expect(r.summary).toBe("");
    expect(r.deprecationAt).toBeUndefined();
  });

  it("extracts camelCase and dotted fields", () => {
    const r = parseChangelogEntry(
      "customers.list starting_after cursor remains; rename getObject to GetObjectCommand.",
    );
    expect(r.fields).toContain("customers.list");
    expect(r.fields).toContain("starting_after");
    expect(r.replacements.some((x) => x.from === "getObject" && x.to === "GetObjectCommand")).toBe(
      true,
    );
  });
});
