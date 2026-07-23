/**
 * Phase A sample consumer — intentional legacy Acme Payments usage.
 * This file lives in the phase-a sandbox repo so a real PR can migrate it.
 */

const ACME_BASE = "https://api.acme-payments.example";

export async function chargeOrder(cents: number, currency: string) {
  const res = await fetch(`${ACME_BASE}/v1/charges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount_cents: cents,
      currency,
      description: "phase-a order",
    }),
  });
  if (!res.ok) throw new Error(`charge failed: ${res.status}`);
  return res.json() as Promise<{ id: string; amount_cents: number; status: string }>;
}

export async function getReceipt(chargeId: string) {
  const res = await fetch(`${ACME_BASE}/v1/charges/${chargeId}/receipt`);
  if (!res.ok) throw new Error(`receipt failed: ${res.status}`);
  return res.json() as Promise<{ url: string }>;
}

export function buildChargeBody(amount_cents: number, currency: string) {
  return { amount_cents, currency };
}
