import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runTransformerLiveEval } from "./transformer-live-eval.js";

const MODEL = "model-a";
const TENANT = "tenant-live";
const SOURCE_PACKAGE = {
  name: "synthetic-runtime-service",
  private: true,
  engines: { node: ">=18 <20" },
  scripts: { test: "node --test" },
  dependencies: { undici: "^6.19.0" },
};
const SOURCE_CONTENT = `${JSON.stringify(SOURCE_PACKAGE, null, 2)}\n`;
const SOURCE_DIGEST = `sha256:${createHash("sha256").update(SOURCE_CONTENT, "utf8").digest("hex")}`;

function liveEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MENDPOINT_EVAL_LIVE_TRANSFORMER: "1",
    MENDPOINT_TRANSFORMER_LIVE_EVAL_TENANT: TENANT,
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED: "1",
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS: TENANT,
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER: "openai-compatible",
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT: "us-central-primary",
    MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED: "1",
    MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION: "us-central1",
    MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION: "confidential",
    MENDPOINT_TRANSFORMER_LIVE_EVAL_MAX_USD: "1",
    LLM_AGENT_MODEL: MODEL,
    LLM_AGENT_URL: "https://models.example/v1",
    OPENAI_API_KEY: "test-secret",
    ...overrides,
  };
}

function responseFor(nextEngine = ">=20 <21", request = 1): Response {
  const nextContent = `${JSON.stringify({
    ...SOURCE_PACKAGE,
    engines: { node: nextEngine },
  }, null, 2)}\n`;
  return new Response(JSON.stringify({
    id: `body-${request}`,
    model: MODEL,
    choices: [{
      message: {
        content: JSON.stringify({
          plan: {
            edits: [{
              path: "package.json",
              observedContentDigest: SOURCE_DIGEST,
              nextContent,
              rationale: "Update the synthetic runtime constraint to the held-out target.",
              semanticCategory: "configuration",
              risk: "low",
              confidence: 98,
            }],
          },
        }),
      },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": `header-${request}`,
    },
  });
}

const PRICE_TABLE = {
  [MODEL]: { promptUsdPerMillion: 1, completionUsdPerMillion: 2 },
} as const;

describe("Transformer live model eval", () => {
  it("fails closed without the explicit live Transformer opt in", async () => {
    const env = liveEnv();
    delete env.MENDPOINT_EVAL_LIVE_TRANSFORMER;

    await expect(runTransformerLiveEval({ env, repetitions: 1 }))
      .rejects.toThrow("transformer_live_eval_opt_in_required");
  });

  it("fails closed when the production adapter policy is absent", async () => {
    await expect(runTransformerLiveEval({
      env: {
        MENDPOINT_EVAL_LIVE_TRANSFORMER: "1",
        MENDPOINT_TRANSFORMER_LIVE_EVAL_TENANT: TENANT,
      },
      repetitions: 1,
    })).rejects.toThrow("transformer_live_eval_configuration_required");
  });

  it("uses the production adapter and router with objective, provenance, and cost evidence", async () => {
    let request = 0;
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      request += 1;
      bodies.push(String(init.body));
      return responseFor(">=20 <21", request);
    });

    const report = await runTransformerLiveEval({
      env: liveEnv(),
      repetitions: 3,
      fetchImpl,
      priceTable: PRICE_TABLE,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(report.passed).toBe(true);
    expect(report.passRate).toBe(1);
    expect(report.consistencyRate).toBe(1);
    expect(report.totalTokens).toBe(450);
    expect(report.spentUsd).toBeCloseTo(0.00054, 10);
    expect(report.trials).toHaveLength(3);
    for (const trial of report.trials) {
      expect(trial.passed).toBe(true);
      expect(trial.objectiveVerified).toBe(true);
      expect(trial.filesChanged).toEqual(["package.json"]);
      expect(trial.provider).toBe("openai-compatible");
      expect(trial.model).toBe(MODEL);
      expect(trial.deployment).toBe("us-central-primary");
      expect(trial.executionRegion).toBe("us-central1");
      expect(trial.totalTokens).toBe(150);
      expect(trial.costUsd).toBeCloseTo(0.00018, 10);
      expect(trial.provenance[0]).toMatchObject({
        configuredModel: MODEL,
        actualModel: MODEL,
        endpointProtocol: "https:",
        bodyRequestId: `body-${trial.trial}`,
        headerRequestId: `header-${trial.trial}`,
      });
      expect(trial.grades.every((candidate) => candidate.passed)).toBe(true);
    }

    for (const body of bodies) {
      const parsed = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> };
      expect(parsed.model).toBe(MODEL);
      const user = parsed.messages.find((message) => message.role === "user");
      const input = JSON.parse(user?.content ?? "null") as {
        context: Array<{ path: string; content: string; digest: string }>;
      };
      expect(input.context).toEqual([expect.objectContaining({
        path: "package.json",
        content: SOURCE_CONTENT,
        digest: SOURCE_DIGEST,
      })]);
      expect(user?.content).not.toContain("C:\\Users\\Talal");
    }
  });

  it("returns failed evidence when the held-out objective is not satisfied", async () => {
    const report = await runTransformerLiveEval({
      env: liveEnv(),
      repetitions: 1,
      fetchImpl: async () => responseFor(">=18 <20"),
      priceTable: PRICE_TABLE,
    });

    expect(report.passed).toBe(false);
    expect(report.passRate).toBe(0);
    expect(report.trials[0]?.objectiveVerified).toBe(false);
    expect(report.trials[0]?.grades.find((candidate) => candidate.id === "objective.verified")?.passed)
      .toBe(false);
  });

  it("refuses before a provider call when the live budget is zero", async () => {
    const fetchImpl = vi.fn(async () => responseFor());

    await expect(runTransformerLiveEval({
      env: liveEnv({ MENDPOINT_TRANSFORMER_LIVE_EVAL_MAX_USD: "0" }),
      repetitions: 1,
      fetchImpl,
      priceTable: PRICE_TABLE,
    })).rejects.toThrow("transformer_live_eval_budget_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
