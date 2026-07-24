/**
 * Broken payments client — path typo.
 */
export function buildChargeUrl() {
  return "https://api.example.com/v1/chargess";
}

export function createCharge(amount, currency = "usd") {
  return {
    url: buildChargeUrl(),
    method: "POST",
    body: { amount, currency },
  };
}
