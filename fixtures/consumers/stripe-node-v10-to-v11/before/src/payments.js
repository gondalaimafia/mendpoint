const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
stripe.setApiVersion("2019-08-08");
stripe.setTimeout(20000);
stripe.setMaxNetworkRetries(2);

async function createCustomer(email) {
  const customer = await stripe.customers.create({ email });
  return customer.id;
}

module.exports = { createCustomer };
