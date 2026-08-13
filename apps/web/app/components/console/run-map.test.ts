import { describe, expect, it } from "vitest";
import { formatDuration, isRunActive, mapRunStatus, runDuration } from "./run-map";

describe("run-map", () => {
  it("maps every queue status onto a DS lifecycle state, keeping the exact label", () => {
    expect(mapRunStatus("pending")).toEqual({ status: "pending", label: "pending" });
    expect(mapRunStatus("running")).toEqual({ status: "pending", label: "running" });
    expect(mapRunStatus("done")).toEqual({ status: "merged", label: "done" });
    expect(mapRunStatus("succeeded")).toEqual({ status: "merged", label: "succeeded" });
    expect(mapRunStatus("failed")).toEqual({ status: "failing", label: "failed" });
    expect(mapRunStatus("dead_letter")).toEqual({ status: "failing", label: "dead_letter" });
    expect(mapRunStatus("cancelled")).toEqual({ status: "draft", label: "cancelled" });
    // Unknown statuses are surfaced verbatim, never dropped.
    expect(mapRunStatus("weird")).toEqual({ status: "pending", label: "weird" });
  });

  it("treats only pending/running as active", () => {
    expect(isRunActive("pending")).toBe(true);
    expect(isRunActive("running")).toBe(true);
    expect(isRunActive("failed")).toBe(false);
    expect(isRunActive("done")).toBe(false);
  });

  it("formats a compact two-unit duration", () => {
    expect(formatDuration("2026-08-13T12:00:00.000Z", "2026-08-13T12:02:59.000Z")).toBe("2m 59s");
    expect(formatDuration("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:05.000Z")).toBe("5s");
    expect(formatDuration("2026-08-13T12:00:00.000Z", "2026-08-13T13:05:00.000Z")).toBe("1h 5m");
  });

  it("rejects a non-duration (missing/inverted/unfinished)", () => {
    expect(formatDuration("bad", "2026-08-13T12:00:00.000Z")).toBeNull();
    expect(formatDuration("2026-08-13T12:05:00.000Z", "2026-08-13T12:00:00.000Z")).toBeNull();
    expect(runDuration(null, "2026-08-13T12:00:00.000Z")).toBeNull();
    expect(runDuration("2026-08-13T12:00:00.000Z", null)).toBeNull();
    expect(runDuration("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:03.000Z")).toBe("3s");
  });
});
