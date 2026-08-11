const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2019-08-08",
  timeout: 20000,
  maxNetworkRetries: 2,
});

async function createCustomer(email) {
  const customer = await stripe.customers.create({ email });
  return customer.id;
}

module.exports = { createCustomer };
