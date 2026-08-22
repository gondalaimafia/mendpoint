import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdaptiveRepairPlannerInput } from "@mendpoint/transformer";
import {
  discardTransformerAdaptiveModelEvidence,
  authorizeConfiguredTransformerAdaptiveExternalProcessing,
  persistTransformerAdaptiveModelEvidence,
  resolveTransformerAdaptivePlannerAdapter,
  type TransformerAdaptiveModelProvenance,
} from "./transformer-adaptive-planner.js";

const PRICE_TABLE = Object.freeze({
  "model-a": Object.freeze({ promptUsdPerMillion: 1, completionUsdPerMillion: 2 }),
});

const INPUT: AdaptiveRepairPlannerInput = Object.freeze({
  schemaVersion: 1,
  unitId: "unit-a",
  goal: "Repair the failed runtime migration",
  recipe: Object.freeze({
    id: "node-runtime-18-to-20",
    version: 2,
    digest: `sha256:${"a".repeat(64)}`,
  }),
  iteration: 1,
  failingCommandId: "package-engine",
  verifierOutput: "package engine mismatch",
  context: Object.freeze([Object.freeze({
    path: "package.json",
    content: '{"engines":{"node":">=20 <22"}}\n',
    digest: `sha256:${"b".repeat(64)}`,
    truncated: false,
  })]),
  allowedMutationPaths: Object.freeze(["package.json"]),
  priorChangedPaths: Object.freeze([]),
  budget: Object.freeze({
    plannerCalls: 2,
    modelCalls: 2,
    inputTokens: 10_000,
    outputTokens: 1_000,
    totalTokens: 11_000,
    actualCostUsd: 1,
  }),
});

function accountingOptions(
  signal?: AbortSignal,
  executionScopeId = `sha256:${"1".repeat(64)}`,
) {
  const reservations: unknown[] = [];
  const settlements: unknown[] = [];
  return {
    reservations,
    settlements,
    options: {
      ...(signal ? { signal } : {}),
      externalModelAccounting: {
        executionScopeId,
        reserve: async (value: unknown) => { reservations.push(value); },
        settle: async (value: unknown) => { settlements.push(value); },
      },
    },
  };
}

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_SOURCE_ENABLED: "1",
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_SOURCE_TENANTS: "tenant-a,tenant-b",
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_PROVIDER: "openai-compatible",
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_DEPLOYMENT: "us-central-primary",
    MENDPOINT_REGAUGE_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED: "1",
    MENDPOINT_REGAUGE_ADAPTIVE_EXECUTION_REGION: "us-central1",
    MENDPOINT_REGAUGE_ADAPTIVE_MAX_DATA_CLASSIFICATION: "confidential",
    LLM_AGENT_MODEL: "model-a",
    LLM_AGENT_URL: "https://models.example/v1",
    OPENAI_API_KEY: "test-secret",
  };
}

function successfulResponse(): Response {
  return new Response(JSON.stringify({
    id: "request-body-a",
    model: "model-a",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      plan: {
        edits: [{
          path: "package.json",
          observedContentDigest: `sha256:${"b".repeat(64)}`,
          nextContent: '{"engines":{"node":">=20 <21"}}\n',
          rationale: "Raise the runtime declaration to the verified target.",
          semanticCategory: "dependencies",
          risk: "low",
          confidence: 96,
        }],
        rationale: "Match the approved Node 20 engine range",
      },
    }) } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "request-header-a" },
  });
}

describe("Transformer adaptive model planner", () => {
  it("is disabled by default and requires an explicitly allowlisted tenant", () => {
    expect(resolveTransformerAdaptivePlannerAdapter("tenant-a", {})).toBeUndefined();
    expect(resolveTransformerAdaptivePlannerAdapter("tenant-c", enabledEnv())).toBeUndefined();

    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv());
    expect(adapter?.policy).toMatchObject({
      approved: true,
      tenantId: "tenant-a",
      provider: "openai-compatible",
      model: "model-a",
      deployment: "us-central-primary",
      approvedExternalProcessing: true,
      executionRegion: "us-central1",
      maximumDataClassification: "confidential",
      endpoint: "https://models.example/v1/chat/completions",
      policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("fails closed unless external processing, region, and classification are explicit", () => {
    for (const key of [
      "MENDPOINT_REGAUGE_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED",
      "MENDPOINT_REGAUGE_ADAPTIVE_EXECUTION_REGION",
      "MENDPOINT_REGAUGE_ADAPTIVE_MAX_DATA_CLASSIFICATION",
    ] as const) {
      const env = enabledEnv();
      delete env[key];
      expect(() => resolveTransformerAdaptivePlannerAdapter("tenant-a", env)).toThrow(
        /^transformer_adaptive_model_(policy_incomplete|classification_invalid)$/,
      );
    }
  });

  it("authorizes only the exact configured tenant policy and denies drift or missing configuration", () => {
    const env = enabledEnv();
    const policy = resolveTransformerAdaptivePlannerAdapter("tenant-a", env)!.policy;
    const input = {
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      sourceArtifactIds: ["snapshot-a"],
      policy,
    };
    expect(authorizeConfiguredTransformerAdaptiveExternalProcessing(input, env)).toEqual({
      allowed: true,
      evidenceRef: `transformer-adaptive-authorization:${policy.policyDigest}`,
    });
    expect(authorizeConfiguredTransformerAdaptiveExternalProcessing(input, {})).toEqual({
      allowed: false,
    });
    expect(authorizeConfiguredTransformerAdaptiveExternalProcessing({
      ...input,
      policy: { ...policy, deployment: "different-deployment" },
    }, env)).toEqual({ allowed: false });
    expect(authorizeConfiguredTransformerAdaptiveExternalProcessing({
      ...input,
      tenantId: "tenant-c",
    }, env)).toEqual({ allowed: false });
  });

  it("returns a strictly parsed plan with measured usage and call provenance", async () => {
    const provenance: TransformerAdaptiveModelProvenance[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-secret" });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({ model: "model-a", temperature: 0, max_tokens: 1_000 });
      expect(request.response_format).toMatchObject({
        type: "json_schema",
        json_schema: {
          name: "transformer_adaptive_plan",
          strict: true,
          schema: {
            properties: {
              plan: {
                required: ["edits", "requestContextPaths", "markUnfixable", "rationale"],
              },
            },
          },
        },
      });
      return successfulResponse();
    });
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      onProvenance: (record) => provenance.push(record),
      priceTable: PRICE_TABLE,
    })!;

    const accounting = accountingOptions();
    await expect(adapter.planner(INPUT, accounting.options)).resolves.toMatchObject({
      plan: {
        edits: [{
          path: "package.json",
          nextContent: expect.stringContaining(">=20 <21"),
          rationale: "Raise the runtime declaration to the verified target.",
          semanticCategory: "dependencies",
          risk: "low",
          confidence: 96,
        }],
      },
      usage: {
        modelCalled: true,
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        costUsd: 0.00018,
        model: "model-a",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(adapter.provenance()).toHaveLength(1);
    expect(provenance).toEqual([expect.objectContaining({
      tenantId: "tenant-a",
      provider: "openai-compatible",
      configuredModel: "model-a",
      actualModel: "model-a",
      deployment: "us-central-primary",
      bodyRequestId: "request-body-a",
      headerRequestId: "request-header-a",
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      costUsd: 0.00018,
    })]);
    expect(accounting.reservations).toEqual([
      expect.objectContaining({
        provider: "openai-compatible",
        configuredModel: "model-a",
        maximumInputTokens: expect.any(Number),
        maximumOutputTokens: 1_000,
      }),
    ]);
    expect(accounting.settlements).toEqual([
      expect.objectContaining({
        status: "succeeded",
        actualModel: "model-a",
        headerRequestId: "request-header-a",
        totalTokens: 150,
      }),
    ]);
  });

  it.each([
    ["zero", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
    ["missing", undefined],
  ])("rejects %s provider usage and settles the reserved call as failed", async (_label, usage) => {
    const body = JSON.parse(await successfulResponse().text()) as Record<string, unknown>;
    if (usage === undefined) delete body.usage;
    else body.usage = usage;
    const accounting = accountingOptions();
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl: async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "request-header-invalid" },
      }),
      priceTable: PRICE_TABLE,
    })!;

    await expect(adapter.planner(INPUT, accounting.options)).rejects.toThrow(
      "transformer_adaptive_model_response_invalid",
    );
    expect(accounting.reservations).toHaveLength(1);
    expect(accounting.settlements).toEqual([
      expect.objectContaining({
        status: "failed",
        headerRequestId: "request-header-invalid",
        errorCode: "transformer_adaptive_model_response_invalid",
      }),
    ]);
    expect(adapter.provenance()).toHaveLength(0);
  });

  it("accepts a strict provider's parsed JSON object content and rejects truncated output", async () => {
    const objectBody = JSON.parse(await successfulResponse().text()) as {
      choices: Array<{ finish_reason: string; message: { content: unknown } }>;
    };
    objectBody.choices[0]!.message.content = JSON.parse(
      String(objectBody.choices[0]!.message.content),
    );
    const objectAdapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl: async () => new Response(JSON.stringify(objectBody), { status: 200 }),
      priceTable: PRICE_TABLE,
    })!;
    await expect(objectAdapter.planner(INPUT, accountingOptions().options)).resolves.toMatchObject({
      plan: { edits: [{ path: "package.json" }] },
      usage: { totalTokens: 150 },
    });

    objectBody.choices[0]!.finish_reason = "length";
    const truncatedAccounting = accountingOptions();
    const truncatedAdapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl: async () => new Response(JSON.stringify(objectBody), { status: 200 }),
      priceTable: PRICE_TABLE,
    })!;
    await expect(truncatedAdapter.planner(INPUT, truncatedAccounting.options)).rejects.toThrow(
      "transformer_adaptive_model_response_invalid",
    );
    expect(truncatedAccounting.settlements).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "transformer_adaptive_model_response_invalid" }),
    ]);
  });

  it("fails before external execution when token or cost headroom cannot be guaranteed", async () => {
    const fetchImpl = vi.fn(async () => successfulResponse());
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      priceTable: PRICE_TABLE,
    })!;

    const { budget: _budget, ...withoutBudget } = INPUT;
    await expect(adapter.planner(withoutBudget, {})).rejects.toThrow(
      "transformer_adaptive_model_budget_missing",
    );
    await expect(adapter.planner({
      ...INPUT,
      budget: { ...INPUT.budget!, outputTokens: 0 },
    }, {})).rejects.toThrow("transformer_adaptive_model_budget_exhausted");
    await expect(adapter.planner({
      ...INPUT,
      budget: { ...INPUT.budget!, actualCostUsd: 0.000001 },
    }, {})).rejects.toThrow("transformer_adaptive_model_budget_exhausted");
    expect(fetchImpl).not.toHaveBeenCalled();

    const unknownPrice = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      priceTable: {},
    })!;
    await expect(unknownPrice.planner(INPUT, accountingOptions().options)).rejects.toThrow(
      "transformer_adaptive_model_price_unknown",
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    const zeroPrice = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      priceTable: { "model-a": { promptUsdPerMillion: 0, completionUsdPerMillion: 0 } },
    })!;
    await expect(zeroPrice.planner(INPUT, accountingOptions().options)).rejects.toThrow(
      "transformer_adaptive_model_price_unknown",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never calls the provider when the durable reservation checkpoint fails", async () => {
    const fetchImpl = vi.fn(async () => successfulResponse());
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      priceTable: PRICE_TABLE,
    })!;
    const settle = vi.fn();
    await expect(adapter.planner(INPUT, {
      externalModelAccounting: {
        executionScopeId: `sha256:${"2".repeat(64)}`,
        reserve: async () => { throw new Error("checkpoint_unavailable"); },
        settle,
      },
    })).rejects.toThrow("checkpoint_unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("keeps reservation replay stable within an attempt and separates identical requests across attempts", async () => {
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl: async () => successfulResponse(),
      priceTable: PRICE_TABLE,
    })!;
    const first = accountingOptions(undefined, `sha256:${"a".repeat(64)}`);
    const sameAttemptReplay = accountingOptions(undefined, `sha256:${"a".repeat(64)}`);
    const nextAttempt = accountingOptions(undefined, `sha256:${"b".repeat(64)}`);
    await adapter.planner(INPUT, first.options);
    await adapter.planner(INPUT, sameAttemptReplay.options);
    await adapter.planner(INPUT, nextAttempt.options);
    const firstId = (first.reservations[0] as { reservationId: string }).reservationId;
    const replayId = (sameAttemptReplay.reservations[0] as { reservationId: string }).reservationId;
    const nextId = (nextAttempt.reservations[0] as { reservationId: string }).reservationId;
    expect(replayId).toBe(firstId);
    expect(nextId).not.toBe(firstId);
  });

  it("fails closed on an invalid plan without exposing provider response content", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: "model-a",
      choices: [{ message: { content: JSON.stringify({
        plan: {
          edits: [{
            path: "not-allowed.ts",
            observedContentDigest: `sha256:${"b".repeat(64)}`,
            nextContent: "test-secret",
          }],
        },
      }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 }));
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      priceTable: PRICE_TABLE,
    })!;

    await expect(adapter.planner(INPUT, accountingOptions().options)).rejects.toThrow(
      "transformer_adaptive_model_response_invalid",
    );
    await adapter.planner(INPUT, accountingOptions().options).catch((error: unknown) => {
      expect(String(error)).not.toContain("test-secret");
    });
  });

  it("rejects live edits missing bounded semantic review metadata", async () => {
    const response = new Response(JSON.stringify({
      model: "model-a",
      choices: [{ message: { content: JSON.stringify({
        plan: { edits: [{
          path: "package.json",
          observedContentDigest: `sha256:${"b".repeat(64)}`,
          nextContent: "{}\n",
        }] },
      }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl: async () => response,
      priceTable: PRICE_TABLE,
    })!;
    await expect(adapter.planner(INPUT, accountingOptions().options)).rejects.toThrow(
      "transformer_adaptive_model_response_invalid",
    );
  });

  it("enforces request and response byte ceilings", async () => {
    const fetchImpl = vi.fn(async () => successfulResponse());
    const requestBound = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      maxRequestBytes: 128,
      priceTable: PRICE_TABLE,
    })!;
    await expect(requestBound.planner(INPUT, accountingOptions().options)).rejects.toThrow(
      "transformer_adaptive_model_request_too_large",
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    const responseBound = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      maxResponseBytes: 128,
      priceTable: PRICE_TABLE,
    })!;
    await expect(responseBound.planner(INPUT, accountingOptions().options)).rejects.toThrow(
      "transformer_adaptive_model_response_too_large",
    );
  });

  it("forwards caller cancellation to the provider request", async () => {
    let providerSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      providerSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl,
      priceTable: PRICE_TABLE,
    })!;
    const controller = new AbortController();
    const pending = adapter.planner(INPUT, accountingOptions(controller.signal).options);
    controller.abort("test-cancelled");

    await expect(pending).rejects.toThrow("transformer_adaptive_model_cancelled");
    expect(providerSignal === undefined || providerSignal.aborted).toBe(true);
  });

  it("settles a timed out reservation when the provider ignores cancellation", async () => {
    const accounting = accountingOptions();
    const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
      fetchImpl: () => new Promise<Response>(() => undefined),
      requestTimeoutMs: 100,
      priceTable: PRICE_TABLE,
    })!;
    const started = Date.now();

    await expect(adapter.planner(INPUT, accounting.options)).rejects.toThrow(
      "transformer_adaptive_model_timeout",
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(accounting.settlements).toHaveLength(1);
    expect(accounting.settlements[0]).toEqual(expect.objectContaining({
      status: "failed",
      errorCode: "transformer_adaptive_model_timeout",
    }));
  }, 1_000);

  it("persists a content-addressed model evidence record with exact provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-model-evidence-"));
    try {
      const adapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", enabledEnv(), {
        fetchImpl: async () => successfulResponse(),
        priceTable: PRICE_TABLE,
      })!;
      await adapter.planner(INPUT, accountingOptions().options);
      const summary = persistTransformerAdaptiveModelEvidence({
        evidenceRoot: root,
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        attemptId: "attempt-a",
        policy: adapter.policy,
        calls: adapter.provenance(),
      });

      expect(summary).toMatchObject({
        created: true,
        provider: "openai-compatible",
        model: "model-a",
        deployment: "us-central-primary",
        endpointHost: "models.example",
        endpointProtocol: "https:",
        bodyRequestIds: ["request-body-a"],
        headerRequestIds: ["request-header-a"],
        totalTokens: 150,
        costUsd: 0.00018,
      });
      expect(JSON.parse(readFileSync(summary.path, "utf8"))).toMatchObject({
        kind: "transformer.adaptive.model_evidence",
        policy: { policyDigest: adapter.policy.policyDigest },
        calls: [{ actualModel: "model-a", bodyRequestId: "request-body-a" }],
      });
      discardTransformerAdaptiveModelEvidence(root, summary);
      expect(existsSync(summary.path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
