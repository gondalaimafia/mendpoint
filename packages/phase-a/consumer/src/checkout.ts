import { chargeOrder, getReceipt } from "./payments.js";

/** Wrapper layer — call-graph should surface this as upstream of chargeOrder. */
export async function checkout(totalCents: number) {
  const charge = await chargeOrder(totalCents, "usd");
  try {
    const receipt = await getReceipt(charge.id);
    return { chargeId: charge.id, receiptUrl: receipt.url };
  } catch {
    return { chargeId: charge.id, receiptUrl: null as string | null };
  }
}
