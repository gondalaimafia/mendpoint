import { describe, expect, it } from "vitest";
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import type { LlmCallObservation } from "@mendpoint/code-impact";
import {
  gradeLiveModelProvenance,
  liveModelRecordFromObservation,
  resolveLiveLaneConfig,
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

describe("live lane configuration preflight", () => {
  const armed = Object.freeze({
    MENDPOINT_LIVE_APPROVED_HOST: "api.meta.ai",
    MENDPOINT_LIVE_APPROVED_MODEL: "muse-spark-1.2-contributor",
    LLM_CONFIRM_MODE: "live",
    OPENAI_API_KEY: "sk-test",
    LLM_CONFIRM_MODEL: "muse-spark-1.2-contributor",
  }) as NodeJS.ProcessEnv;

  it("is ready only when host, live mode, and a key are all configured", () => {
    const config = resolveLiveLaneConfig(armed);
    expect(config.status).toBe("ready");
    if (config.status === "ready") {
      expect(config.approved).toEqual({ host: "api.meta.ai", model: "muse-spark-1.2-contributor" });
      expect(config.requestedModel).toBe("muse-spark-1.2-contributor");
    }
  });

  it("defaults the approved model to the contributor tier when unset", () => {
    const { MENDPOINT_LIVE_APPROVED_MODEL: _omit, ...rest } = armed as Record<string, string>;
    const config = resolveLiveLaneConfig(rest as NodeJS.ProcessEnv);
    expect(config.status).toBe("ready");
    if (config.status === "ready") {
      expect(config.approved.model).toBe("muse-spark-1.2-contributor");
    }
  });

  it("skips honestly, with a reason, when the approved host is not pinned", () => {
    const { MENDPOINT_LIVE_APPROVED_HOST: _omit, ...rest } = armed as Record<string, string>;
    const config = resolveLiveLaneConfig(rest as NodeJS.ProcessEnv);
    expect(config.status).toBe("skipped");
    if (config.status === "skipped") {
      expect(config.reason).toContain("MENDPOINT_LIVE_APPROVED_HOST");
      expect(config.reason).toContain("not measured");
    }
  });

  it("skips (never falls back to heuristic) when live mode is not armed", () => {
    const config = resolveLiveLaneConfig({
      MENDPOINT_LIVE_APPROVED_HOST: "api.meta.ai",
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    expect(config.status).toBe("skipped");
    if (config.status === "skipped") {
      expect(config.reason).toContain("live mode is not active");
      expect(config.reason).toContain("report it as live");
    }
  });

  it("skips when live mode is set but no API key is present (would run heuristic)", () => {
    const config = resolveLiveLaneConfig({
      MENDPOINT_LIVE_APPROVED_HOST: "api.meta.ai",
      LLM_CONFIRM_MODE: "live",
    } as NodeJS.ProcessEnv);
    // resolveLlmConfirmMode downgrades live→heuristic without a key; the lane
    // must refuse rather than measure the heuristic path.
    expect(config.status).toBe("skipped");
    if (config.status === "skipped") {
      expect(config.reason).toContain("heuristic");
    }
  });
});

describe("live model provenance capture from an observed call", () => {
  const approved: LiveModelApprovedConfig = Object.freeze({
    host: "api.meta.ai",
    model: "muse-spark-1.2-contributor",
  });

  function observation(overrides: Partial<LlmCallObservation> = {}): LlmCallObservation {
    return Object.freeze({
      url: "https://api.meta.ai/v1/chat/completions",
      headerRequestId: "req-42",
      body: Object.freeze({
        id: "chatcmpl-77",
        model: "muse-spark-1.2-contributor",
        usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
      }),
      ...overrides,
    });
  }

  it("round-trips the echoed model, host, tokens, and priced cost", () => {
    const record = liveModelRecordFromObservation(observation());
    expect(record.model).toBe("muse-spark-1.2-contributor");
    expect(record.host).toBe("api.meta.ai");
    expect(record.protocol).toBe("https:");
    expect(record.promptTokens).toBe(200);
    expect(record.completionTokens).toBe(50);
    expect(record.totalTokens).toBe(250);
    expect(record.bodyRequestId).toBe("chatcmpl-77");
    expect(record.headerRequestId).toBe("req-42");
    expect(record.costUsd).not.toBeNull();

    const grade = gradeLiveModelProvenance({
      approved,
      provenance: [record],
      plannerSources: ["model"],
      scriptedPlannerInjected: false,
    });
    expect(grade.passed).toBe(true);
  });

  it("flags — never silently accepts — a call that echoed a different model", () => {
    const record = liveModelRecordFromObservation(
      observation({
        body: Object.freeze({
          id: "chatcmpl-9",
          model: "gpt-4o-mini",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      }),
    );
    expect(record.model).toBe("gpt-4o-mini");
    const grade = gradeLiveModelProvenance({
      approved,
      provenance: [record],
      plannerSources: ["model"],
      scriptedPlannerInjected: false,
    });
    expect(grade.passed).toBe(false);
    expect(grade.grades.find((g) => g.id === "model.exact_echo")?.passed).toBe(false);
  });
});
