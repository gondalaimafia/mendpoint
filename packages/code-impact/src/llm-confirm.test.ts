import { describe, expect, it, afterEach, vi } from "vitest";
import {
  createBudget,
  heuristicConfirm,
  llmConfirmLive,
  resolveLlmConfirmMode,
} from "./llm-confirm.js";
import type {
  ConfirmedImpact,
  ExpandedContext,
  ImpactableSurface,
} from "@mendpoint/shared";

const surfaces: ImpactableSurface[] = [
  {
    id: "s1",
    canonicalId: "x",
    kind: "request_field",
    op: "request_field_renamed",
    fromField: "amount_cents",
    toField: "amount",
    severity: "breaking",
    migrationStrategy: "rename amount_cents → amount",
    explanation: "rename",
    searchTokens: ["amount_cents", "amount"],
  },
];

function ctx(partial: Partial<ExpandedContext["candidate"]> & { slice?: string }): ExpandedContext {
  return {
    candidate: {
      filePath: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      symbol: "amount_cents",
      surfaceIds: ["s1"],
      sources: ["syntactic"],
      initialConfidence: "medium",
      evidence: "amount_cents: 10",
      ...partial,
    },
    callers: [],
    callees: [],
    slice: partial.slice ?? "const body = { amount_cents: 10 }",
    isTestFile: false,
    graphCallers: [],
    wrappers: [],
  };
}

describe("llm confirm", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("resolveLlmConfirmMode defaults off without keys", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.LLM_CONFIRM;
    delete process.env.LLM_CONFIRM_MODE;
    expect(resolveLlmConfirmMode()).toBe("off");
  });

  it("heuristic upgrades clear field hits to high", () => {
    const result = heuristicConfirm(ctx({}), surfaces, {
      filePath: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      symbol: "amount_cents",
      confidence: "medium",
      evidence: "amount_cents",
      impactType: "field_access",
      surfaceIds: ["s1"],
      relatedOps: ["request_field_renamed"],
      confirmationPath: "static",
    });
    expect(result?.confirmationPath).toBe("hybrid_llm");
    expect(result?.confidence).toBe("high");
  });

  it("budget tracks usage", () => {
    const b = createBudget(2);
    expect(b.maxCalls).toBe(2);
    b.used++;
    expect(b.used).toBe(1);
  });

  it("fails closed when a provider response exceeds the model evidence limit", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const staticResult: ConfirmedImpact = {
      filePath: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      symbol: "amount_cents",
      confidence: "medium",
      evidence: "amount_cents",
      impactType: "field_access",
      surfaceIds: ["s1"],
      relatedOps: ["request_field_renamed"],
      confirmationPath: "static",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        affected: false,
        confidence: "low",
        rationale: "not affected",
      }) } }],
      padding: "x".repeat(70_000),
    }))));

    const result = await llmConfirmLive(ctx({}), surfaces, staticResult, createBudget(1));
    expect(result).toEqual(staticResult);
  });

  it("does not enable live confirmation from an API key alone", () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.XAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_CONFIRM;
    delete process.env.LLM_CONFIRM_MODE;
    // A key without an explicit LLM_CONFIRM opt-in must stay off.
    expect(resolveLlmConfirmMode()).toBe("off");
    process.env.LLM_CONFIRM = "1";
    expect(resolveLlmConfirmMode()).toBe("live");
  });

  it("does not select live confirmation for an unsupported Anthropic-only credential", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.LLM_CONFIRM_MODE = "live";
    expect(resolveLlmConfirmMode()).toBe("heuristic");
  });

  it("redacts secret material from the outbound request body", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.LLM_CONFIRM_TIMEOUT_MS;
    const secretUrl = "postgres://user:supersecretpassword@db.example.com/prod";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        affected: true,
        confidence: "high",
        impactType: "field_access",
        rationale: "affected",
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    await llmConfirmLive(
      ctx({ slice: `const dsn = "${secretUrl}"; amount_cents` }),
      surfaces,
      null,
      createBudget(1),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("supersecretpassword");
    expect(body).not.toContain(secretUrl);
    expect(body).toContain("[REDACTED_DATABASE_URL]");
  });

  it("does not egress to the public OpenAI default under local_only", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MENDPOINT_MODEL_EGRESS = "local_only";
    delete process.env.OPENAI_API_BASE;
    delete process.env.XAI_API_KEY;
    const staticResult: ConfirmedImpact = {
      filePath: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      symbol: "amount_cents",
      confidence: "medium",
      evidence: "amount_cents",
      impactType: "field_access",
      surfaceIds: ["s1"],
      relatedOps: ["request_field_renamed"],
      confirmationPath: "static",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // The public api.openai.com default fails the egress check; the lane fails
    // closed to the static result without sending any slice.
    const result = await llmConfirmLive(ctx({}), surfaces, staticResult, createBudget(1));
    expect(result).toEqual(staticResult);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still calls a loopback base URL under local_only", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MENDPOINT_MODEL_EGRESS = "local_only";
    process.env.OPENAI_API_BASE = "http://127.0.0.1:9000/v1";
    delete process.env.XAI_API_KEY;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        affected: true,
        confidence: "high",
        impactType: "field_access",
        rationale: "affected",
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await llmConfirmLive(ctx({}), surfaces, null, createBudget(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.confirmationPath).toBe("hybrid_llm");
  });

  it("settles a noncooperative provider call at the configured timeout", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_CONFIRM_TIMEOUT_MS = "10";
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const started = Date.now();

    await expect(
      llmConfirmLive(ctx({}), surfaces, null, createBudget(1)),
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(250);
  }, 1_000);
});
