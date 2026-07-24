/**
 * Broken payment client — POST without request idempotency header.
 */
export function createPayment(amount, currency = "usd") {
  return fetch("https://api.example.com/v1/charges", {
    method: "POST",
    headers: {
      Authorization: "Bearer sk_test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount, currency }),
  });
}
