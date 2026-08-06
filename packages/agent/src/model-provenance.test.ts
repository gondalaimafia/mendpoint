import { describe, expect, it } from "vitest";
import {
  buildLiveModelProvenance,
  computeModelCostUsd,
  DEFAULT_MODEL_PRICE_TABLE,
} from "./model-provenance.js";

describe("live model cost attribution", () => {
  it("prices muse-spark-1.2 from the exact keyed table", () => {
    // 1,000,000 prompt tokens * 1.25 + 1,000,000 completion tokens * 4.25.
    expect(computeModelCostUsd("muse-spark-1.2", 1_000_000, 1_000_000)).toBeCloseTo(5.5, 10);
    expect(computeModelCostUsd("muse-spark-1.2", 2_000, 500))
      .toBeCloseTo((2_000 * 1.25 + 500 * 4.25) / 1_000_000, 12);
  });

  it("prices the approved muse-spark-1.2-contributor tier from the table", () => {
    // 1,000,000 prompt tokens * 0.10 + 1,000,000 completion tokens * 0.20.
    expect(computeModelCostUsd("muse-spark-1.2-contributor", 1_000_000, 1_000_000))
      .toBeCloseTo(0.3, 10);
    expect(computeModelCostUsd("muse-spark-1.2-contributor", 200, 160))
      .toBeCloseTo((200 * 0.1 + 160 * 0.2) / 1_000_000, 12);
  });

  it("returns null for an unpriced model rather than guessing", () => {
    expect(computeModelCostUsd("unknown-model-9", 1_000, 1_000)).toBeNull();
    expect(DEFAULT_MODEL_PRICE_TABLE["muse-spark-1.2"]).toBeDefined();
  });
});

describe("live model provenance capture", () => {
  it("captures body id, header id, echoed model, tokens, host, protocol, and cost", () => {
    const record = buildLiveModelProvenance({
      url: "https://api.meta.ai/v1/chat/completions",
      headerRequestId: "req-header-42",
      body: {
        id: "chatcmpl-body-7",
        model: "muse-spark-1.2",
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      },
    });
    expect(record.bodyRequestId).toBe("chatcmpl-body-7");
    expect(record.headerRequestId).toBe("req-header-42");
    expect(record.model).toBe("muse-spark-1.2");
    expect(record.promptTokens).toBe(100);
    expect(record.completionTokens).toBe(40);
    expect(record.totalTokens).toBe(140);
    expect(record.host).toBe("api.meta.ai");
    expect(record.protocol).toBe("https:");
    expect(record.costUsd).toBeCloseTo((100 * 1.25 + 40 * 4.25) / 1_000_000, 12);
    expect(record.monotonicTimestampMs).toBeGreaterThanOrEqual(0);
  });

  it("normalizes missing ids to null and records the actual protocol", () => {
    const record = buildLiveModelProvenance({
      url: "http://127.0.0.1:8080/v1/chat/completions",
      headerRequestId: null,
      body: { model: "muse-spark-1.2", usage: { prompt_tokens: 1, completion_tokens: 1 } },
    });
    expect(record.bodyRequestId).toBeNull();
    expect(record.headerRequestId).toBeNull();
    expect(record.protocol).toBe("http:");
    expect(record.totalTokens).toBe(0);
  });

  it("reports null cost when the echoed model is unpriced", () => {
    const record = buildLiveModelProvenance({
      url: "https://api.meta.ai/v1/chat/completions",
      headerRequestId: "req-1",
      body: { id: "id-1", model: "mystery-model", usage: { prompt_tokens: 5, completion_tokens: 5 } },
    });
    expect(record.costUsd).toBeNull();
  });
});
