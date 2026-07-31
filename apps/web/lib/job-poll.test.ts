import { describe, expect, it, vi } from "vitest";
import { waitForJob } from "./job-poll";

describe("waitForJob", () => {
  it("returns when queued work reaches a terminal state", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([{ id: "job-1", status: "running" }]),
      )
      .mockResolvedValueOnce(
        Response.json([{ id: "job-1", status: "done" }]),
      );

    await expect(
      waitForJob("/api", "job-1", {
        fetchImpl,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ id: "job-1", status: "done" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops after the bounded polling window", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () =>
        Response.json([{ id: "job-1", status: "pending" }]),
      );

    await expect(
      waitForJob("/api", "job-1", {
        attempts: 2,
        fetchImpl,
        sleep: async () => undefined,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
