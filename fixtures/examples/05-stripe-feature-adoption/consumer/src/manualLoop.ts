import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_KEY!);

/** Manual loop that could adopt listAutoPaging / autoPagingToArray. */
export async function loadCustomersManual() {
  const out: Stripe.Customer[] = [];
  let starting_after: string | undefined;
  do {
    const page = await stripe.customers.list({ limit: 50, starting_after });
    out.push(...page.data);
    starting_after = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (starting_after);
  return out;
}
