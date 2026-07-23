/** Shop checkout — uses Acme Payments (v1 patterns). */

const ACME_BASE = "https://api.acme-payments.example";

export async function chargeCustomer(cents: number, currency: string) {
  const res = await fetch(`${ACME_BASE}/v1/charges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount_cents: cents,
      currency,
      description: "shop-app order",
    }),
  });
  if (!res.ok) throw new Error(`charge failed: ${res.status}`);
  return res.json() as Promise<{ id: string; amount_cents: number; status: string }>;
}

export async function fetchReceipt(chargeId: string) {
  const res = await fetch(`${ACME_BASE}/v1/charges/${chargeId}/receipt`);
  if (!res.ok) throw new Error(`receipt failed: ${res.status}`);
  return res.json() as Promise<{ url: string }>;
}

export function acmeChargesCreate(client: {
  charges: { create: (body: { amount_cents: number; currency: string }) => Promise<unknown> };
}, amount_cents: number, currency: string) {
  return client.charges.create({ amount_cents, currency });
}
