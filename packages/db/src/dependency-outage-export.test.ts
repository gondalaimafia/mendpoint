import { describe, expect, it } from "vitest";
import { createDependencyOutageQueue } from "@mendpoint/db/dependency-outage";

describe("dependency outage package contract", () => {
  it("resolves the supported dependency outage subpath", () => {
    expect(createDependencyOutageQueue).toBeTypeOf("function");
  });
});
