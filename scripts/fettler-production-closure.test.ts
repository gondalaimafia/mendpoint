import { describe, expect, it } from "vitest";
import {
  buildFettlerProductionClosure,
  serializeFettlerProductionClosure,
} from "./fettler-production-closure.js";

describe("Fettler production closure operating contracts", () => {
  it("binds performance and metric definitions without claiming a measurement", () => {
    const closure = buildFettlerProductionClosure();

    expect(closure).toMatchObject({
      schemaVersion: "fettler-production-requirement-closure/1",
      product: "fettler",
      release: "production",
      operatingContracts: {
        performance: {
          version: "2026-09-02.v2",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          metricDictionaryVersion: "2026-09-02.v1",
          metricDictionaryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          evidence: {
            status: "not_observed",
            reason: "production_measurement_not_supplied",
          },
        },
      },
    });
    expect(serializeFettlerProductionClosure()).toBe(
      `${JSON.stringify(closure, null, 2)}\n`,
    );
  });
});
