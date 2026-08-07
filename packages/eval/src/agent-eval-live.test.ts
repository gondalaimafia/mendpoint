import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLiveEvalOption, runWardenLiveEval } from "./agent-eval-live.js";

const APPROVED_MODEL = "muse-spark-1.2-contributor";

describe("live eval command options", () => {
  it("accepts assignment and separated values without consuming another option", () => {
    expect(parseLiveEvalOption(["node", "eval", "--product=transformer"], "product"))
      .toBe("transformer");
    expect(parseLiveEvalOption(["node", "eval", "--product", "transformer"], "product"))
      .toBe("transformer");
    expect(parseLiveEvalOption(["node", "eval", "--product", "--repetitions", "3"], "product"))
      .toBeUndefined();
  });
});

type MockConfig = {
  echoModel: string;
  includeBodyId: boolean;
  includeHeaderId: boolean;
  status?: number;
  toolCalls?: readonly Readonly<{
    tool: string;
    args: Readonly<Record<string, unknown>>;
    thought: string;
  }>[];
};

type MockToolCall = NonNullable<MockConfig["toolCalls"]>[number];

function modelResponse(toolCall: MockToolCall, request: number): Response {
  return new Response(JSON.stringify({
    id: `chatcmpl-live-${request}`,
    model: APPROVED_MODEL,
    choices: [{ message: { content: JSON.stringify(toolCall) } }],
    usage: { prompt_tokens: 200, completion_tokens: 160, total_tokens: 360 },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": `req-live-${request}`,
    },
  });
}

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
            content: JSON.stringify(config.toolCalls?.[calls - 1] ?? {
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
    vi.unstubAllGlobals();
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

  it("rejects unbounded retry and backoff options before any provider call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    await expect(runWardenLiveEval({ repetitions: 1, maxTransientRetries: Infinity }))
      .rejects.toThrow("warden_live_eval_transient_retries_invalid");
    await expect(runWardenLiveEval({ repetitions: 1, maxRateLimitRetries: 11 }))
      .rejects.toThrow("warden_live_eval_rate_limit_retries_invalid");
    await expect(runWardenLiveEval({ repetitions: 1, transientBackoffMs: 10_001 }))
      .rejects.toThrow("warden_live_eval_transient_backoff_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("rejects every present but invalid USD budget before any provider call", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const value of ["", " ", "-1", "NaN", "not-a-number", "Infinity"]) {
      process.env.MENDPOINT_LIVE_EVAL_MAX_USD = value;
      await expect(runWardenLiveEval({ repetitions: 1 }))
        .rejects.toThrow("warden_live_eval_budget_invalid");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reserves a conservative call ceiling before a nonzero budget can be exceeded", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    process.env.MENDPOINT_LIVE_EVAL_MAX_USD = "0.000001";
    const fetchMock = vi.fn(async () => modelResponse({
      tool: "read_file",
      args: { path: "client.js" },
      thought: "inspect the client",
    }, 1));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runWardenLiveEval({ repetitions: 1 }))
      .rejects.toThrow("warden_live_eval_budget_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
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
      // Both transport and the unfinished coding objective fail closed.
      const failed = trial.grades.filter((grade) => !grade.passed).map((grade) => grade.id);
      expect(failed).toEqual(expect.arrayContaining([
        "transport.https",
        "objective.completed",
        "objective.verifier_passed",
      ]));
      expect(trial.ok).toBe(false);
      expect(trial.objectiveVerified).toBe(false);
      expect(trial.passed).toBe(false);
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("requires a completed verified repair in addition to valid provenance", async () => {
    const { server, port } = await startMockServer({
      echoModel: APPROVED_MODEL,
      includeBodyId: true,
      includeHeaderId: true,
      toolCalls: [
        {
          tool: "read_file",
          args: { path: "client.js" },
          thought: "inspect the failing client path",
        },
        {
          tool: "replace_in_file",
          args: { path: "client.js", from: "/v1/chargess", to: "/v1/charges" },
          thought: "repair only the observed endpoint typo",
        },
        {
          tool: "run_command",
          args: { command: "node check.mjs" },
          thought: "verify the exact repair",
        },
      ],
    });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;
    try {
      const report = await runWardenLiveEval({ repetitions: 1 });
      const trial = report.trials[0]!;
      const failed = trial.grades.filter((grade) => !grade.passed).map((grade) => grade.id);
      expect(failed).toEqual(["transport.https"]);
      expect(trial.objectiveVerified).toBe(true);
      expect(trial.ok).toBe(true);
      expect(trial.verifierStatus).toBe("passed");
      expect(trial.stoppedReason).toBe("verify_passed");
      expect(trial.filesChanged).toEqual(["client.js"]);
      expect(trial.passed).toBe(false);
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("never executes candidate code and rejects verifier process tampering", async () => {
    const original = "export const chargePath = '/v1/chargess';\n";
    const malicious = [
      'import { writeFileSync } from "node:fs";',
      'process.exit = () => undefined;',
      'writeFileSync(new URL("./unexpected.txt", import.meta.url), "side effect");',
      'writeFileSync(new URL("./check.mjs", import.meta.url), "process.exit(0);\\n");',
      'export const chargePath = "/wrong";',
      "",
    ].join("\n");
    const toolCalls: MockToolCall[] = [
      { tool: "read_file", args: { path: "client.js" }, thought: "inspect" },
      {
        tool: "replace_in_file",
        args: { path: "client.js", from: original, to: malicious },
        thought: "malicious side effect",
      },
      { tool: "run_command", args: { command: "node check.mjs" }, thought: "verify" },
    ];
    let request = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const call = toolCalls[request] ?? toolCalls.at(-1)!;
      request += 1;
      return modelResponse(call, request);
    }));
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    const report = await runWardenLiveEval({ repetitions: 1 });
    const trial = report.trials[0]!;
    const failed = trial.grades.filter((grade) => !grade.passed).map((grade) => grade.id);

    expect(trial.ok).toBe(false);
    expect(trial.verifierStatus).toBe("failed");
    expect(trial.filesChanged).toEqual([]);
    expect(failed).toEqual(expect.arrayContaining([
      "objective.completed",
      "objective.verifier_passed",
      "objective.exact_allowed_files",
      "objective.hidden_semantic_judge",
      "objective.no_rollback",
    ]));
    expect(failed).not.toContain("objective.verifier_immutable");
    expect(report.passed).toBe(false);
  });

  it("can produce a fully passing schema v2 report over an approved HTTPS endpoint", async () => {
    const toolCalls: MockToolCall[] = [
      {
        tool: "read_file",
        args: { path: "client.js" },
        thought: "inspect the failing client path",
      },
      {
        tool: "replace_in_file",
        args: { path: "client.js", from: "/v1/chargess", to: "/v1/charges" },
        thought: "repair only the observed endpoint typo",
      },
      {
        tool: "run_command",
        args: { command: "node check.mjs" },
        thought: "verify the exact repair",
      },
    ];
    let request = 0;
    const fetchMock = vi.fn(async () => {
      const call = toolCalls[request] ?? toolCalls.at(-1)!;
      request += 1;
      return modelResponse(call, request);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    const report = await runWardenLiveEval({ repetitions: 1 });

    expect(report.schemaVersion).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.spentUsd).toBeGreaterThan(0);
    expect(report.spentUsd).toBeLessThanOrEqual(report.budgetUsd);
    expect(report.trials[0]).toMatchObject({
      passed: true,
      objectiveVerified: true,
      ok: true,
      verifierStatus: "passed",
      stoppedReason: "verify_passed",
      filesChanged: ["client.js"],
    });
    expect(report.trials[0]?.grades.every((grade) => grade.passed)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("charges the reservation and fails closed when provider usage is missing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl-live-missing-usage",
      model: APPROVED_MODEL,
      choices: [{ message: { content: JSON.stringify({
        tool: "read_file",
        args: { path: "client.js" },
        thought: "inspect",
      }) } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req-missing-usage" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    const report = await runWardenLiveEval({ repetitions: 1 });

    expect(report.passed).toBe(false);
    expect(report.spentUsd).toBeGreaterThan(0);
    expect(report.trials[0]).toMatchObject({
      passed: false,
      stoppedReason: "model_response_invalid",
      totalTokens: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats different successful tool paths as the same semantic outcome", async () => {
    const toolCalls: MockToolCall[] = [
      { tool: "read_file", args: { path: "client.js" }, thought: "first trial inspect" },
      {
        tool: "replace_in_file",
        args: { path: "client.js", from: "/v1/chargess", to: "/v1/charges" },
        thought: "first trial repair",
      },
      { tool: "run_command", args: { command: "node check.mjs" }, thought: "first trial verify" },
      { tool: "list_dir", args: { path: "." }, thought: "second trial orient" },
      { tool: "read_file", args: { path: "client.js" }, thought: "second trial inspect" },
      {
        tool: "replace_in_file",
        args: { path: "client.js", from: "/v1/chargess", to: "/v1/charges" },
        thought: "second trial repair",
      },
      { tool: "run_command", args: { command: "node check.mjs" }, thought: "second trial verify" },
    ];
    let request = 0;
    const fetchMock = vi.fn(async () => {
      const call = toolCalls[request] ?? toolCalls.at(-1)!;
      request += 1;
      return modelResponse(call, request);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    const report = await runWardenLiveEval({ repetitions: 2 });

    expect(report.trials.map((trial) => trial.provenance.length)).toEqual([3, 4]);
    expect(report.trials.every((trial) => trial.passed)).toBe(true);
    expect(report.consistent).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("charges successful work and conservative uncertainty before a rate limit retry", async () => {
    const toolCalls: MockToolCall[] = [
      { tool: "read_file", args: { path: "client.js" }, thought: "inspect first attempt" },
      { tool: "read_file", args: { path: "client.js" }, thought: "inspect retry" },
      {
        tool: "replace_in_file",
        args: { path: "client.js", from: "/v1/chargess", to: "/v1/charges" },
        thought: "repair retry",
      },
      { tool: "run_command", args: { command: "node check.mjs" }, thought: "verify retry" },
    ];
    let request = 0;
    const fetchMock = vi.fn(async () => {
      request += 1;
      if (request === 2) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      const toolIndex = request === 1 ? 0 : request - 2;
      return modelResponse(toolCalls[toolIndex] ?? toolCalls.at(-1)!, request);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    const report = await runWardenLiveEval({
      repetitions: 1,
      maxRateLimitRetries: 1,
      rateLimitBackoffMs: 1,
      sleep: async () => undefined,
    });

    const measuredProvenanceCost = report.trials[0]!.provenance.reduce(
      (sum, record) => sum + (record.costUsd ?? 0),
      0,
    );
    expect(report.passed).toBe(true);
    expect(report.spentUsd).toBe(report.trials[0]!.costUsd);
    expect(report.spentUsd).toBeGreaterThan(measuredProvenanceCost);
    expect(report.spentUsd).toBeLessThanOrEqual(report.budgetUsd);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("retries a typed transient HTTP failure without bypassing the shared budget", async () => {
    const toolCalls: MockToolCall[] = [
      { tool: "read_file", args: { path: "client.js" }, thought: "inspect" },
      {
        tool: "replace_in_file",
        args: { path: "client.js", from: "/v1/chargess", to: "/v1/charges" },
        thought: "repair",
      },
      { tool: "run_command", args: { command: "node check.mjs" }, thought: "verify" },
    ];
    let request = 0;
    const fetchMock = vi.fn(async () => {
      request += 1;
      if (request === 1) return new Response("unavailable", { status: 503 });
      return modelResponse(toolCalls[request - 2] ?? toolCalls.at(-1)!, request);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    const report = await runWardenLiveEval({
      repetitions: 1,
      maxTransientRetries: 1,
      transientBackoffMs: 1,
      sleep: async () => undefined,
    });

    const measuredProvenanceCost = report.trials[0]!.provenance.reduce(
      (sum, record) => sum + (record.costUsd ?? 0),
      0,
    );
    expect(report.passed).toBe(true);
    expect(report.spentUsd).toBeGreaterThan(measuredProvenanceCost);
    expect(report.spentUsd).toBeLessThanOrEqual(report.budgetUsd);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry a permanent provider HTTP failure", async () => {
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_AGENT_URL = "https://models.example/v1";
    process.env.LLM_AGENT_MODEL = APPROVED_MODEL;

    const report = await runWardenLiveEval({
      repetitions: 1,
      maxTransientRetries: 2,
      transientBackoffMs: 1,
      sleep: async () => undefined,
    });

    expect(report.passed).toBe(false);
    expect(report.trials[0]!.stoppedReason).toBe("model_http_error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
