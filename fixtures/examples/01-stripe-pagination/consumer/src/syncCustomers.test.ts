import { describe, it, expect, vi } from "vitest";

vi.mock("stripe", () => ({
  default: class {
    customers = {
      list: vi.fn(async ({ starting_after }: { starting_after?: string }) => ({
        data: starting_after ? [] : [{ id: "cus_1" }],
        has_more: false,
      })),
    };
  },
}));

describe("syncCustomers pagination mock", () => {
  it("uses starting_after shape", async () => {
    const { fetchAllCustomers } = await import("./syncCustomers.js");
    const rows = await fetchAllCustomers();
    expect(Array.isArray(rows)).toBe(true);
  });
});
