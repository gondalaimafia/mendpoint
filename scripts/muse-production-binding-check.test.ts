import { describe, expect, it } from "vitest";
import {
  checkMuseProductionBinding,
  parseFlyEnv,
} from "./muse-production-binding-check.js";

const valid = [
  "[env]",
  'MENDPOINT_MODEL_PROVIDER = "muse-spark"',
  'LLM_AGENT_MODEL = "muse-spark-1.2-contributor"',
  'LLM_CONFIRM_MODEL = "muse-spark-1.2-contributor"',
  'MENDPOINT_LIVE_APPROVED_MODEL = "muse-spark-1.2-contributor"',
  'MENDPOINT_CHANGE_GRAPH_BENCHMARK_APPROVED_MODEL = "muse-spark-1.2-contributor"',
  "[http_service]",
].join("\n");

describe("Muse production binding gate", () => {
  it("accepts one explicit provider and exact model across runtime and evaluation", () => {
    expect(checkMuseProductionBinding(valid)).toEqual([]);
  });

  it("rejects an implicit provider fallback or mismatched evaluation model", () => {
    const invalid = valid
      .replace('MENDPOINT_MODEL_PROVIDER = "muse-spark"\n', "")
      .replace('LLM_CONFIRM_MODEL = "muse-spark-1.2-contributor"', 'LLM_CONFIRM_MODEL = "gpt-4o-mini"');
    expect(checkMuseProductionBinding(invalid)).toEqual([
      "MENDPOINT_MODEL_PROVIDER: expected muse-spark, found missing",
      "LLM_CONFIRM_MODEL: expected muse-spark-1.2-contributor, found gpt-4o-mini",
    ]);
  });

  it("rejects duplicate environment bindings instead of accepting the last value", () => {
    expect(() => parseFlyEnv(`${valid}\n[env]\nLLM_AGENT_MODEL = "other"`)).toThrow(
      "duplicate Fly env binding: LLM_AGENT_MODEL",
    );
  });
});
