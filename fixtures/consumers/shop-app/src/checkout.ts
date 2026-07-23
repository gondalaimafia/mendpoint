/** Service + controller layer — exercises call-graph reverse reachability. */
import { chargeCustomer, fetchReceipt } from "./payments.js";

/** Thin wrapper over Acme charge API (wrapper detection target). */
export function PaymentService_charge(orderTotalCents: number, currency: string) {
  return chargeCustomer(orderTotalCents, currency);
}

export function PaymentService_receipt(chargeId: string) {
  return fetchReceipt(chargeId);
}

/** Controller that would break if PaymentService_charge migrates. */
export async function handleCheckout(order: { totalCents: number; currency: string }) {
  const charge = await PaymentService_charge(order.totalCents, order.currency);
  return charge;
}
