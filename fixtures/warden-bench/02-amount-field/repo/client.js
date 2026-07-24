/**
 * Broken payments client — amount_cents still used.
 */
export function normalizeChargeBody(input) {
  return {
    amount_cents: input.amount_cents,
    currency: input.currency ?? "usd",
  };
}

export function buildChargeRequest(amount_cents) {
  return {
    url: "https://api.example.com/v1/charges",
    method: "POST",
    body: normalizeChargeBody({ amount_cents, currency: "usd" }),
  };
}
