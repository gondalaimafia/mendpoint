/**
 * Deliberate API bugs for the Mendpoint API Bug Agent:
 * 1) path typo: /v1/chargess
 * 2) field still amount_cents (should be amount)
 */
export function buildChargeRequest(amount_cents) {
  return {
    url: "https://api.example.com/v1/chargess",
    method: "POST",
    body: { amount_cents, currency: "usd" },
  };
}

export function normalizeChargeBody(input) {
  // Production API expects `amount` not amount_cents
  return { amount_cents: input.amount_cents, currency: input.currency ?? "usd" };
}
