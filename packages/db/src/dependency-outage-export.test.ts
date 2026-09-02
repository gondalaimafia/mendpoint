import { describe, expect, it } from "vitest";
import { createDependencyOutageQueue } from "@mendpoint/db";

describe("dependency outage package contract", () => {
  it("resolves the supported dependency outage root export", () => {
    expect(createDependencyOutageQueue).toBeTypeOf("function");
  });
});
