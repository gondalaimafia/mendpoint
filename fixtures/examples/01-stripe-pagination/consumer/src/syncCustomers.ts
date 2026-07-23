import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: "2023-10-16" });

/** Manual offset/cursor hybrid loop — impacted by pagination migration. */
export async function fetchAllCustomers() {
  const all: Stripe.Customer[] = [];
  let lastCustomerId: string | undefined;

  for (;;) {
    const customers = await stripe.customers.list({
      limit: 100,
      starting_after: lastCustomerId,
    });
    all.push(...customers.data);
    if (!customers.has_more || customers.data.length === 0) break;
    lastCustomerId = customers.data[customers.data.length - 1]!.id;
  }
  return all;
}

export async function syncCustomersOnce() {
  // Direct call site (line-oriented for impact demo)
  const customers = await stripe.customers.list({
    limit: 100,
    starting_after: undefined as unknown as string,
  });
  return customers.data.map((c) => c.id);
}
