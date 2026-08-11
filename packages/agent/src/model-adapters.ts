/**
 * Wire-format adapters for the model gateway.
 *
 * The Warden agent loop speaks one internal shape: an OpenAI-compatible
 * /chat/completions request whose response carries `choices[].message.content`
 * plus a `usage` block. Providers in the OpenAI-compatible family (OpenAI,
 * xAI/Grok, and any OpenAI-compatible gateway or self-hosted endpoint) use that
 * shape directly, so the agent builds and parses those requests inline and no
 * adapter is involved.
 *
 * Providers with a DIFFERENT native wire format — Anthropic's Messages API and
 * Google's Gemini generateContent API — route through the thin adapters below.
 * Each adapter translates the outbound request (a system prompt plus a single
 * untrusted user turn) into the vendor's native body and headers, and parses the
 * vendor's native response back into the internal `ParsedModelResponse` shape
 * (JSON text content plus normalized OpenAI-style token usage) so the rest of
 * the loop — provenance, cost attribution, tool-call validation — is unchanged.
 *
 * Honesty note: these two adapters ask the model for JSON via each vendor's own
 * JSON mechanism (Anthropic: prompt-guided JSON in the system turn; Gemini:
 * `responseMimeType: "application/json"`), NOT OpenAI's strict `json_schema`
 * validator, which is an OpenAI-family feature. The OpenAI-compatible path keeps
 * strict `json_schema`.
 */

/** Non-OpenAI wire formats that require request/response translation. */
export type NonOpenAiWireFormat = "anthropic" | "gemini";

/** Normalized OpenAI-style token usage produced by every adapter. */
export type NormalizedModelUsage = Readonly<{
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}>;

/** Internal, provider-agnostic response shape the agent loop consumes. */
export type ParsedModelResponse = Readonly<{
  id: string | null;
  model: string;
  content: string;
  usage: NormalizedModelUsage;
}>;

/** A translated outbound request ready to hand to `fetch`. */
export type BuiltModelRequest = Readonly<{
  body: string;
  headers: Readonly<Record<string, string>>;
}>;

export type ModelRequestParams = Readonly<{
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
  apiKey: string;
}>;

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Anthropic Messages API translation. The system prompt maps to the top-level
 * `system` field; the untrusted user payload becomes a single user turn.
 */
function buildAnthropicRequest(params: ModelRequestParams): BuiltModelRequest {
  return Object.freeze({
    headers: Object.freeze({
      "Content-Type": "application/json",
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
    }),
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxOutputTokens,
      temperature: params.temperature,
      system: params.system,
      messages: [{ role: "user", content: params.user }],
    }),
  });
}

function parseAnthropicResponse(data: unknown): ParsedModelResponse {
  const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const content = Array.isArray(body.content)
    ? body.content
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const record = block as Record<string, unknown>;
          return record.type === "text" && typeof record.text === "string" ? record.text : "";
        })
        .join("")
    : "";
  const usage = (body.usage && typeof body.usage === "object" ? body.usage : {}) as Record<string, unknown>;
  const promptTokens = nonNegativeInteger(usage.input_tokens);
  const completionTokens = nonNegativeInteger(usage.output_tokens);
  return Object.freeze({
    id: stringOrNull(body.id),
    model: stringOrNull(body.model) ?? "",
    content,
    usage: Object.freeze({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    }),
  });
}

/**
 * Google Gemini generateContent translation. The system prompt maps to
 * `system_instruction`; the untrusted user payload becomes one user content
 * part. JSON output is requested via `responseMimeType`. The API key travels in
 * the `x-goog-api-key` header, never in the URL query string.
 */
function buildGeminiRequest(params: ModelRequestParams): BuiltModelRequest {
  return Object.freeze({
    headers: Object.freeze({
      "Content-Type": "application/json",
      "x-goog-api-key": params.apiKey,
    }),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: params.system }] },
      contents: [{ role: "user", parts: [{ text: params.user }] }],
      generationConfig: {
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens,
        responseMimeType: "application/json",
      },
    }),
  });
}

function parseGeminiResponse(data: unknown): ParsedModelResponse {
  const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const first = (candidates[0] && typeof candidates[0] === "object" ? candidates[0] : {}) as Record<string, unknown>;
  const candidateContent = (first.content && typeof first.content === "object" ? first.content : {}) as Record<string, unknown>;
  const parts = Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
  const content = parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
  const usage = (body.usageMetadata && typeof body.usageMetadata === "object" ? body.usageMetadata : {}) as Record<string, unknown>;
  const promptTokens = nonNegativeInteger(usage.promptTokenCount);
  const completionTokens = nonNegativeInteger(usage.candidatesTokenCount);
  const totalTokens = nonNegativeInteger(usage.totalTokenCount);
  return Object.freeze({
    id: stringOrNull(body.responseId),
    model: stringOrNull(body.modelVersion) ?? "",
    content,
    usage: Object.freeze({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens > 0 ? totalTokens : promptTokens + completionTokens,
    }),
  });
}

/** Build a translated outbound request for a non-OpenAI wire format. */
export function buildNonOpenAiModelRequest(
  wireFormat: NonOpenAiWireFormat,
  params: ModelRequestParams,
): BuiltModelRequest {
  return wireFormat === "anthropic"
    ? buildAnthropicRequest(params)
    : buildGeminiRequest(params);
}

/** Parse a non-OpenAI wire-format response into the internal shape. */
export function parseNonOpenAiModelResponse(
  wireFormat: NonOpenAiWireFormat,
  data: unknown,
): ParsedModelResponse {
  return wireFormat === "anthropic"
    ? parseAnthropicResponse(data)
    : parseGeminiResponse(data);
}
