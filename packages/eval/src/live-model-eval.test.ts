import { describe, expect, it } from "vitest";
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import {
  gradeLiveModelProvenance,
  type LiveModelApprovedConfig,
  type LiveModelGradeInput,
} from "./live-model-eval.js";

const APPROVED: LiveModelApprovedConfig = Object.freeze({
  host: "api.meta.ai",
  model: "muse-spark-1.2",
});

function record(
  overrides: Partial<LiveModelProvenanceRecord> = {},
): LiveModelProvenanceRecord {
  return Object.freeze({
    providerId: null,
    bodyRequestId: "chatcmpl-1",
    headerRequestId: "req-1",
    model: "muse-spark-1.2",
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    host: "api.meta.ai",
    protocol: "https:",
    costUsd: 0.0002,
    monotonicTimestampMs: 12.5,
    ...overrides,
  });
}

function input(overrides: Partial<LiveModelGradeInput> = {}): LiveModelGradeInput {
  return {
    approved: APPROVED,
    provenance: [record()],
    plannerSources: ["model"],
    scriptedPlannerInjected: false,
    ...overrides,
  };
}

function failedIds(result: ReturnType<typeof gradeLiveModelProvenance>): string[] {
  return result.grades.filter((candidate) => !candidate.passed).map((candidate) => candidate.id);
}

describe("live model machine verification", () => {
  it("passes only when every provenance condition holds", () => {
    const result = gradeLiveModelProvenance(input());
    expect(result.passed).toBe(true);
    expect(failedIds(result)).toEqual([]);
  });

  it("fails closed when no provenance was captured", () => {
    const result = gradeLiveModelProvenance(input({ provenance: [] }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("provenance.present");
  });

  it("rejects a host that does not match the approved endpoint", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ host: "api.evil.example" })],
    }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("provider.host_match");
  });

  it("rejects an echoed model that differs from the approved model", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ model: "muse-spark-1.2-preview" })],
    }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("model.exact_echo");
  });

  it("requires at least one nonempty request id per call", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ bodyRequestId: null, headerRequestId: null })],
    }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("request_id.present");
  });

  it("accepts a header-only request id", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ bodyRequestId: null, headerRequestId: "req-header" })],
    }));
    expect(result.passed).toBe(true);
  });

  it("rejects zero token usage", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })],
    }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("tokens.nonzero");
  });

  it("rejects inconsistent token totals", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ promptTokens: 100, completionTokens: 40, totalTokens: 999 })],
    }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("tokens.consistent");
  });

  it("rejects non-https transport", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ protocol: "http:" })],
    }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("transport.https");
  });

  it("rejects a null (unpriced) cost", () => {
    const result = gradeLiveModelProvenance(input({
      provenance: [record({ costUsd: null })],
    }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("cost.present");
  });

  it("requires the graded steps to be planned by the live model", () => {
    const result = gradeLiveModelProvenance(input({ plannerSources: ["heuristic"] }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("planner.model_source");
  });

  it("rejects a mixed trajectory with even one non-model graded step", () => {
    const result = gradeLiveModelProvenance(input({ plannerSources: ["model", "heuristic"] }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("planner.model_source");
  });

  it("fails when a scripted planner was injected", () => {
    const result = gradeLiveModelProvenance(input({ scriptedPlannerInjected: true }));
    expect(result.passed).toBe(false);
    expect(failedIds(result)).toContain("planner.no_scripted_injection");
  });
});
