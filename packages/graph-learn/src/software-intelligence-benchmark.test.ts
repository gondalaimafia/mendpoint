import { describe, expect, it, vi } from "vitest";
import { runChangeGraphRepresentationBenchmark } from "./software-intelligence-benchmark.js";

describe("Change Graph representation benchmark", () => {
  it("compares raw and graph context with one generator contract and isolated answer keys", async () => {
    const seen = new Set<string>();
    const scenarios = [
      ["dev-direct", "development", false],
      ["dev-indirect", "development", true],
      ["val-direct", "validation", false],
      ["val-indirect", "validation", true],
      ["hold-direct", "holdout", false],
      ["hold-indirect", "holdout", true],
    ].map(([id, split, indirect]) => ({
      id: String(id),
      split: split as "development" | "validation" | "holdout",
      indirect: Boolean(indirect),
      splitGroupId: `family:${id}`,
      task: `Find the impacted test for ${id}`,
      expectedEntityIds: [`test:${id}`],
      rawContext: indirect ? `raw noisy repository for ${id}` : `raw ANSWER=test:${id}`,
      graphContext: `graph PATH=test:${id}`,
    }));
    const generator = vi.fn(async (input: {
      scenarioId: string;
      task: string;
      context: string;
      arm: "raw" | "graph";
    }) => {
      expect(input).not.toHaveProperty("expectedEntityIds");
      seen.add(input.scenarioId);
      const match = input.context.match(/(?:ANSWER|PATH)=(test:[^\s]+)/);
      return {
        entityIds: match ? [match[1]!] : [],
        deterministicAccepted: Boolean(match),
        ...(!match ? { failureCategory: "model_abstained" } : {}),
        usage: {
          inputTokens: input.context.length,
          outputTokens: match ? 4 : 1,
          latencyMs: input.arm === "raw" ? 20 : 5,
          costUsd: input.arm === "raw" ? 0.02 : 0.005,
        },
      };
    });
    const verifier = vi.fn(async () => ({ score: 0.99, model: "deepseek-v4-flash" }));

    const report = await runChangeGraphRepresentationBenchmark({
      benchmarkId: "software-relationships-v1",
      generatorId: "muse-1.2-contract",
      scenarios,
      generator,
      verifier,
    });

    expect(seen.size).toBe(6);
    expect(generator).toHaveBeenCalledTimes(12);
    expect(report.arms.raw.accuracy).toBe(0.5);
    expect(report.arms.graph.accuracy).toBe(1);
    expect(report.arms.graph.contextBytes).toBeLessThan(report.arms.raw.contextBytes);
    expect(report.arms.graph.costUsd).toBeLessThan(report.arms.raw.costUsd);
    expect(report.splits.holdout.indirectCount).toBe(1);
    expect(report.splits.holdout.scenarioCount).toBe(2);
    // Soft verification runs only on deterministically accepted answers and
    // never changes the raw arm's three rejected indirect answers into passes.
    expect(verifier).toHaveBeenCalledTimes(9);
    expect(report.arms.raw.correct).toBe(3);
    expect(report.arms.raw.abstained).toBe(3);
    expect(report.arms.raw.failureCategories).toEqual({ model_abstained: 3 });
    expect(report.schemaVersion).toBe("mendpoint.change-graph-benchmark.v1");
    expect(report.scenarioSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.reportDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects split leakage and a validation or holdout set with less than half indirect cases", async () => {
    const base = {
      id: "same-family",
      split: "validation" as const,
      indirect: false,
      task: "task",
      expectedEntityIds: ["test:x"],
      rawContext: "raw",
      graphContext: "graph",
      splitGroupId: "family-a",
    };
    await expect(runChangeGraphRepresentationBenchmark({
      benchmarkId: "invalid",
      generatorId: "muse",
      scenarios: [
        { ...base, id: "dev", split: "development", splitGroupId: "family-dev" },
        base,
        { ...base, id: "hold", split: "holdout" },
      ],
      generator: async () => ({
        entityIds: [],
        deterministicAccepted: false,
        usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 },
      }),
    })).rejects.toThrow("change_graph_benchmark_split_group_leakage");
  });

  it("snapshots benchmark identity before executing the generator", async () => {
    const scenarios = [
      ["dev", "development"],
      ["validation", "validation"],
      ["holdout", "holdout"],
    ].map(([id, split]) => ({
      id: id!,
      split: split as "development" | "validation" | "holdout",
      indirect: true,
      splitGroupId: `family:${id}`,
      task: "Find the impacted test",
      expectedEntityIds: ["test:x"],
      rawContext: "raw",
      graphContext: "graph",
    }));
    const request = {
      benchmarkId: "benchmark-original",
      generatorId: "generator-original",
      scenarios,
      generator: async () => {
        request.generatorId = "generator-mutated";
        return {
          entityIds: ["test:x"],
          deterministicAccepted: true,
          usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0 },
        };
      },
    };

    const report = await runChangeGraphRepresentationBenchmark(request);
    expect(report.generatorId).toBe("generator-original");
    expect(request.generatorId).toBe("generator-mutated");
  });

  it("rejects malformed generator output before soft verification", async () => {
    const verifier = vi.fn(async () => ({ score: 1, model: "deepseek-v4-flash" }));
    const scenario = (id: string, split: "development" | "validation" | "holdout") => ({
      id,
      split,
      indirect: true,
      splitGroupId: `family:${id}`,
      task: "Find the impacted test",
      expectedEntityIds: ["test:x"],
      rawContext: "raw",
      graphContext: "graph",
    });
    await expect(runChangeGraphRepresentationBenchmark({
      benchmarkId: "benchmark-invalid-output",
      generatorId: "generator",
      scenarios: [
        scenario("dev", "development"),
        scenario("validation", "validation"),
        scenario("holdout", "holdout"),
      ],
      generator: async () => ({
        entityIds: ["test:x"],
        deterministicAccepted: true,
        usage: { inputTokens: -1, outputTokens: 0, latencyMs: 0, costUsd: 0 },
      }),
      verifier,
    })).rejects.toThrow(
      "change_graph_benchmark_usage_invalid",
    );
    expect(verifier).not.toHaveBeenCalled();
  });
});
