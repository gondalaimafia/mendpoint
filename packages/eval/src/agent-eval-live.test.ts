import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWardenLiveEval } from "./agent-eval-live.js";

const APPROVED_MODEL = "muse-spark-1.2-contributor";

type MockConfig = {
  echoModel: string;
  includeBodyId: boolean;
  includeHeaderId: boolean;
  status?: number;
};

function startMockServer(config: MockConfig): Promise<{ server: Server; port: number }> {
  let calls = 0;
  const server = createServer((request, response) => {
    // Drain the request body so the socket completes cleanly.
    request.on("data", () => undefined);
    request.on("end", () => {
      calls += 1;
      if (config.status && config.status !== 200) {
        response.writeHead(config.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      const body: Record<string, unknown> = {
        model: config.echoModel,
        choices: [{
          message: {
            content: JSON.stringify({
              tool: "read_file",
              args: { path: "client.js" },
              thought: "inspect the client",
            }),
          },
        }],
        // Muse Spark is a reasoning model; completions carry real headroom.
        usage: { prompt_tokens: 200, completion_tokens: 160, total_tokens: 360 },
      };
      if (config.includeBodyId) body.id = `chatcmpl-live-${calls}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.includeHeaderId) headers["x-request-id"] = `req-live-${calls}`;
      response.writeHead(200, headers);
      response.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "LLM_AGENT_URL",
  "OPENAI_BASE_URL",
  "LLM_AGENT_MODEL",
  "MENDPOINT_LIVE_APPROVED_MODEL",
  "MENDPOINT_LIVE_EVAL_MAX_USD",
  "NODE_ENV",
] as const;

describe("Warden live eval runner", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    // Start from a clean slate so a stray ambient key cannot leak into a case.
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.LLM_AGENT_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.LLM_AGENT_MODEL;
    delete process.env.MENDPOINT_LIVE_APPROVED_MODEL;
    delete process.env.MENDPOINT_LIVE_EVAL_MAX_USD;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("refuses to run when OPENAI_API_KEY is missing", async () => {
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    await expect(runWardenLiveEval({ repetitions: 1 }))
      .rejects.toThrow("warden_live_eval_credentials_required");
  });

  it("refuses to run when LLM_AGENT_URL is missing", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    await expect(runWardenLiveEval({ repetitions: 1 }))
      .rejects.toThrow("warden_live_eval_credentials_required");
  });

  it("fails closed when the configured model is not the approved model", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = "some-unapproved-model";
    await expect(runWardenLiveEval({ repetitions: 1 }))
      .rejects.toThrow("warden_model_not_approved");
  });

  it("runs the approved contributor tier model without rejecting it", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    process.env.MENDPOINT_LIVE_EVAL_MAX_USD = "0";
    // Budget 0 aborts before any call, proving the approved model passed the gate.
    await expect(runWardenLiveEval({ repetitions: 1 }))
      .rejects.toThrow("warden_live_eval_budget_exceeded");
  });

  it("aborts before exceeding the configured USD budget", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    process.env.MENDPOINT_LIVE_EVAL_MAX_USD = "0";
    await expect(runWardenLiveEval({ repetitions: 1 }))
      .rejects.toThrow("warden_live_eval_budget_exceeded");
  });

  it("backs off a provider 429 within bounded retries, then fails the trial", async () => {
    const { server, port } = await startMockServer({
      echoModel: APPROVED_MODEL,
      includeBodyId: true,
      includeHeaderId: true,
      status: 429,
    });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    try {
      await expect(runWardenLiveEval({
        repetitions: 1,
        maxRateLimitRetries: 2,
        rateLimitBackoffMs: 1,
        sleep: async () => undefined,
      })).rejects.toThrow("warden_live_eval_rate_limited");
    } finally {
      await closeServer(server);
    }
  });

  it("captures provenance from the mock and fails the lane over plain http", async () => {
    const { server, port } = await startMockServer({
      echoModel: APPROVED_MODEL,
      includeBodyId: true,
      includeHeaderId: true,
    });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    try {
      const report = await runWardenLiveEval({ repetitions: 1 });
      expect(report.lane).toBe("live_model");
      expect(report.approved.host).toBe(`127.0.0.1:${port}`);
      expect(report.approved.model).toBe(APPROVED_MODEL);
      const trial = report.trials[0]!;
      expect(trial.provenance.length).toBeGreaterThanOrEqual(1);
      const record = trial.provenance[0]!;
      expect(record.host).toBe(`127.0.0.1:${port}`);
      expect(record.model).toBe(APPROVED_MODEL);
      expect(record.bodyRequestId).toMatch(/^chatcmpl-live-/);
      expect(record.headerRequestId).toMatch(/^req-live-/);
      expect(record.protocol).toBe("http:");
      expect(trial.totalTokens).toBeGreaterThan(0);
      expect(trial.costUsd).toBeGreaterThan(0);
      // Only the transport check fails over plain http; the lane fails closed.
      const failed = trial.grades.filter((grade) => !grade.passed).map((grade) => grade.id);
      expect(failed).toEqual(["transport.https"]);
      expect(trial.passed).toBe(false);
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("fails the model check when the provider echoes a different model", async () => {
    const { server, port } = await startMockServer({
      echoModel: "muse-spark-1.2-preview",
      includeBodyId: true,
      includeHeaderId: true,
    });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    try {
      const report = await runWardenLiveEval({ repetitions: 1 });
      const failed = report.trials[0]!.grades.filter((grade) => !grade.passed).map((grade) => grade.id);
      expect(failed).toContain("model.exact_echo");
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("fails the request id check when the provider omits every id", async () => {
    const { server, port } = await startMockServer({
      echoModel: APPROVED_MODEL,
      includeBodyId: false,
      includeHeaderId: false,
    });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    try {
      const report = await runWardenLiveEval({ repetitions: 1 });
      const failed = report.trials[0]!.grades.filter((grade) => !grade.passed).map((grade) => grade.id);
      expect(failed).toContain("request_id.present");
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});
