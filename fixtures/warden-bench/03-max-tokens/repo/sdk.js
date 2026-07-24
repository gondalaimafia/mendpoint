/**
 * Broken OpenAI-style client — deprecated max_tokens.
 */
export function buildChatRequest(prompt, max = 256) {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: max,
  };
}

export const defaultOptions = {
  temperature: 0.2,
  max_tokens: 100,
};
