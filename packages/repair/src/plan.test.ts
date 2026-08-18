import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planRepairsWithLlm } from "./plan.js";

describe("LLM repair planning transport", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("uses an abortable transport and rejects oversized provider output", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_REPAIR_URL = "https://repair.example.com/v1";
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          actions: [{
            type: "replace_in_file",
            filePath: "src/a.ts",
            from: "old",
            to: "new",
            reason: "bounded test",
          }],
        }) } }],
        padding: "x".repeat(140_000),
      }));
    }));

    const result = await planRepairsWithLlm(
      [{ kind: "test_assert", message: "failed", raw: "old" }],
      [{ filePath: "src/a.ts", content: "old" }],
      { attempt: 1 },
    );
    expect(result).toBeNull();
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.redirect).toBe("error");
  });

  it("redacts secret material from the outbound request body", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_REPAIR_URL = "https://repair.example.com/v1";
    const secretUrl = "postgres://user:supersecretpassword@db.example.com/prod";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ actions: [] }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    await planRepairsWithLlm(
      [{ kind: "test_assert", message: "failed", raw: "old" }],
      [{ filePath: "src/a.ts", content: `const dsn = "${secretUrl}";` }],
      { attempt: 1 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("supersecretpassword");
    expect(body).not.toContain(secretUrl);
    expect(body).toContain("[REDACTED_DATABASE_URL]");
  });

  it("accounts for the call: records the model that answered and its token usage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_REPAIR_URL = "https://repair.example.com/v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      // The provider echoes the model it actually served, not the one requested.
      model: "gpt-4o-mini-2024-07-18",
      usage: { prompt_tokens: 321, completion_tokens: 44, total_tokens: 365 },
      choices: [{ message: { content: JSON.stringify({
        actions: [{
          type: "replace_in_file",
          filePath: "src/a.ts",
          from: "old",
          to: "new",
          reason: "bounded test",
        }],
      }) } }],
    }))));

    const result = await planRepairsWithLlm(
      [{ kind: "test_assert", message: "failed", raw: "old" }],
      [{ filePath: "src/a.ts", content: "old" }],
      { attempt: 1 },
    );
    expect(result?.strategy).toBe("llm");
    expect(result?.modelProvenance).toBeDefined();
    expect(result?.modelProvenance?.model).toBe("gpt-4o-mini-2024-07-18");
    expect(result?.modelProvenance?.host).toBe("repair.example.com");
    expect(result?.modelProvenance?.promptTokens).toBe(321);
    expect(result?.modelProvenance?.completionTokens).toBe(44);
    expect(result?.modelProvenance?.totalTokens).toBe(365);
    expect(result?.modelProvenance?.measured).toBe(true);
  });
});

describe("LLM repair planning egress enforcement", () => {
  const env = { ...process.env };
  const observations = [{ kind: "test_assert", message: "failed", raw: "old" }] as const;
  const slices = [{ filePath: "src/a.ts", content: "old" }];

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("refuses to send to a public LLM_REPAIR_URL under local_only", async () => {
    process.env.MENDPOINT_MODEL_EGRESS = "local_only";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_REPAIR_URL = "https://public-model.invalid";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      planRepairsWithLlm([...observations], slices, { attempt: 1 }),
    ).rejects.toThrow("model_egress_local_only_violation");
    // Fails closed before any bytes leave the process.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still calls a loopback LLM_REPAIR_URL under local_only", async () => {
    process.env.MENDPOINT_MODEL_EGRESS = "local_only";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_REPAIR_URL = "http://127.0.0.1:9000/v1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        actions: [{ type: "replace_in_file", filePath: "src/a.ts", from: "old", to: "new", reason: "ok" }],
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.actions).toHaveLength(1);
    expect(result?.actions[0]).toMatchObject({ filePath: "src/a.ts" });
  });

  it("still calls an allowlisted private LLM_REPAIR_URL under local_only", async () => {
    process.env.MENDPOINT_MODEL_EGRESS = "local_only";
    process.env.MENDPOINT_MODEL_LOCAL_HOSTS = "repair.internal";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_REPAIR_URL = "https://repair.internal/v1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        actions: [{ type: "replace_in_file", filePath: "src/a.ts", from: "old", to: "new", reason: "ok" }],
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.actions).toHaveLength(1);
  });
});

describe("LLM repair planning edit-path constraints", () => {
  const env = { ...process.env };
  const observations = [{ kind: "test_assert", message: "failed", raw: "old" }] as const;
  const slices = [{ filePath: "src/a.ts", content: "old" }];

  const stubActions = (actions: unknown[]) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ actions }) } }],
    }))));

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_REPAIR_URL = "https://repair.example.com/v1";
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("applies a legitimate in-slice edit", async () => {
    stubActions([{ type: "replace_in_file", filePath: "src/a.ts", from: "old", to: "new", reason: "ok" }]);
    const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
    expect(result?.actions).toHaveLength(1);
    expect(result?.actions[0]).toMatchObject({ filePath: "src/a.ts", from: "old", to: "new" });
  });

  it("rejects a proposal targeting a path outside the supplied slices", async () => {
    stubActions([{ type: "replace_in_file", filePath: "package.json", from: "test", to: "true", reason: "poison" }]);
    const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
    expect(result).toBeNull();
  });

  it("rejects absolute paths, traversal, and .git/ targets", async () => {
    for (const filePath of ["/etc/passwd", "../outside.ts", ".git/config", ".git/hooks/pre-commit"]) {
      stubActions([{ type: "replace_in_file", filePath, from: "a", to: "b", reason: "attack" }]);
      const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
      expect(result).toBeNull();
      vi.unstubAllGlobals();
    }
  });

  it("rejects a non-string or absent filePath", async () => {
    stubActions([
      { type: "replace_in_file", filePath: 123, from: "a", to: "b", reason: "non-string" },
      { type: "replace_in_file", from: "a", to: "b", reason: "missing" },
    ]);
    const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
    expect(result).toBeNull();
  });

  it("rejects malformed replacement values instead of passing them to the mutation layer", async () => {
    stubActions([
      { type: "replace_in_file", filePath: "src/a.ts", from: "", to: "new", reason: "empty source" },
      { type: "replace_in_file", filePath: "src/a.ts", from: { value: "old" }, to: "new", reason: "object source" },
      { type: "replace_in_file", filePath: "src/a.ts", from: "old", to: { value: "new" }, reason: "object target" },
      { type: "replace_in_file", filePath: "src/a.ts", from: "old", to: "new", global: "yes", reason: "bad flag" },
      { type: "replace_in_file", filePath: "src/a.ts", from: "old", to: "new", reason: { text: "bad reason" } },
      { type: "replace_in_file", filePath: "src/a.ts", from: "old", to: "new", global: false, reason: "valid" },
    ]);

    const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
    expect(result?.actions).toEqual([
      {
        type: "replace_in_file",
        filePath: "src/a.ts",
        from: "old",
        to: "new",
        global: false,
        reason: "valid",
      },
    ]);
  });

  it("keeps only the in-slice action when mixed with an out-of-slice attack", async () => {
    stubActions([
      { type: "replace_in_file", filePath: ".git/config", from: "a", to: "b", reason: "attack" },
      { type: "replace_in_file", filePath: "src/a.ts", from: "old", to: "new", reason: "ok" },
    ]);
    const result = await planRepairsWithLlm([...observations], slices, { attempt: 1 });
    expect(result?.actions).toHaveLength(1);
    expect(result?.actions[0]).toMatchObject({ filePath: "src/a.ts" });
  });
});
