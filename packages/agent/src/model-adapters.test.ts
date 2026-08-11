import { describe, expect, it } from "vitest";
import {
  buildNonOpenAiModelRequest,
  parseNonOpenAiModelResponse,
} from "./model-adapters.js";

const params = {
  model: "claude-3-5-sonnet-latest",
  system: "system rules",
  user: JSON.stringify({ goal: "inspect" }),
  maxOutputTokens: 512,
  temperature: 0.1,
  apiKey: "secret-key",
};

describe("Anthropic wire adapter", () => {
  it("translates the request to the Messages API shape with header auth", () => {
    const request = buildNonOpenAiModelRequest("anthropic", params);
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "secret-key",
      "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse(request.body);
    expect(body.model).toBe("claude-3-5-sonnet-latest");
    expect(body.max_tokens).toBe(512);
    expect(body.system).toBe("system rules");
    expect(body.messages).toEqual([{ role: "user", content: params.user }]);
    // The key must never leak into the body.
    expect(request.body).not.toContain("secret-key");
  });

  it("parses text content and normalizes token usage", () => {
    const parsed = parseNonOpenAiModelResponse("anthropic", {
      id: "msg-1",
      model: "claude-3-5-sonnet-latest",
      content: [
        { type: "text", text: '{"tool":"finish",' },
        { type: "text", text: '"args":{"ok":true}}' },
      ],
      usage: { input_tokens: 120, output_tokens: 45 },
    });
    expect(parsed.id).toBe("msg-1");
    expect(parsed.model).toBe("claude-3-5-sonnet-latest");
    expect(parsed.content).toBe('{"tool":"finish","args":{"ok":true}}');
    expect(parsed.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
    });
  });

  it("degrades safely on a malformed response", () => {
    const parsed = parseNonOpenAiModelResponse("anthropic", { unexpected: true });
    expect(parsed.content).toBe("");
    expect(parsed.model).toBe("");
    expect(parsed.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe("Gemini wire adapter", () => {
  it("translates the request to generateContent with x-goog-api-key header", () => {
    const request = buildNonOpenAiModelRequest("gemini", { ...params, model: "gemini-1.5-flash" });
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-goog-api-key": "secret-key",
    });
    const body = JSON.parse(request.body);
    expect(body.system_instruction).toEqual({ parts: [{ text: "system rules" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: params.user }] }]);
    expect(body.generationConfig).toMatchObject({
      temperature: 0.1,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
    });
    expect(request.body).not.toContain("secret-key");
  });

  it("parses candidate parts and usageMetadata", () => {
    const parsed = parseNonOpenAiModelResponse("gemini", {
      responseId: "resp-9",
      modelVersion: "gemini-1.5-flash-002",
      candidates: [
        { content: { parts: [{ text: '{"tool":"read_file",' }, { text: '"args":{"path":"a.js"}}' }] } },
      ],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, totalTokenCount: 360 },
    });
    expect(parsed.id).toBe("resp-9");
    expect(parsed.model).toBe("gemini-1.5-flash-002");
    expect(parsed.content).toBe('{"tool":"read_file","args":{"path":"a.js"}}');
    expect(parsed.usage).toEqual({
      prompt_tokens: 300,
      completion_tokens: 60,
      total_tokens: 360,
    });
  });

  it("derives total from prompt+completion when totalTokenCount is absent", () => {
    const parsed = parseNonOpenAiModelResponse("gemini", {
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
    });
    expect(parsed.usage.total_tokens).toBe(14);
  });
});
