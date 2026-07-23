import { describe, expect, it } from "vitest";
import { ChangeRiskSchema, newId, ok } from "./index.js";

describe("shared", () => {
  it("validates change risk", () => {
    expect(ChangeRiskSchema.parse("breaking")).toBe("breaking");
  });

  it("generates ids", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("ok helper", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });
});
