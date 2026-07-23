import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createBudget,
  heuristicConfirm,
  resolveLlmConfirmMode,
} from "./llm-confirm.js";
import type { ExpandedContext, ImpactableSurface } from "@mendpoint/shared";

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
});
