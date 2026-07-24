/**
 * Broken client — insecure HTTP base URL.
 */
export const API_BASE = "http://api.example.com";

export function chargeUrl(path = "/v1/charges") {
  return `${API_BASE}${path}`;
}

export function createCharge(body) {
  return {
    url: chargeUrl("/v1/charges"),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
}
