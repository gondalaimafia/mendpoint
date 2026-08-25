import { describe, expect, it } from "vitest";
import { GET as healthGet } from "../healthz/route";
import { GET as readyGet } from "./route";

describe("public deployment readiness", () => {
  it("reuses the full deployment health contract", () => {
    expect(readyGet).toBe(healthGet);
  });
});
