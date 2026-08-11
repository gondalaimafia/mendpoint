const Stripe = require("stripe");

// setApiKey rewrites the constructor's first argument, which is outside the
// recipe's bounded surface. Analysis must report this file as out-of-scope and
// abstain rather than producing a wrong edit.
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
stripe.setApiKey(process.env.STRIPE_SECRET_KEY_FALLBACK);
stripe.setTimeout(20000);

module.exports = { stripe };
