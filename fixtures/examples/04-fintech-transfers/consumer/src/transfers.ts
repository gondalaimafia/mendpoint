import { apiClient } from "./apiClient.js";

const BASE = "https://payments.internal.example";

export async function createTransfer(
  key: string,
  amount: number,
  currency: string,
  destination: string,
) {
  const { headers } = apiClient(key);
  await fetch(`${BASE}/v2/transfers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amount, currency, destination }),
  });
}

export async function createTransferRaw(key: string, amount: number) {
  await fetch(`${BASE}/v2/transfers`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ amount, currency: "usd", destination: "acct_1" }),
  });
}
