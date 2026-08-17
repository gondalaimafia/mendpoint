import { afterEach, describe, expect, it, vi } from "vitest";
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
});
