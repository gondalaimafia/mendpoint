# stripe-charges-trimmed

A trimmed extract of Stripe's real published OpenAPI (`spec3.json`), reduced to
two operations plus the `charge` component schema they reference. It preserves
the two structural traits that broke the differ on real specs:

- request bodies are `application/x-www-form-urlencoded` (not `application/json`),
  exactly as Stripe models them; and
- the success response is a local `$ref` (`#/components/schemas/charge`), with
  further `$ref`s nested inside the `charge` schema.

`openapi-v1.json` is the baseline. `openapi-v2.json` applies a realistic
provider migration on top of it so the pair exercises field-level detection:

- request field `source` renamed to `payment_method` on `POST /v1/charges`
  (the actual Stripe-era rename), detected by schema equality since the two
  names share nothing lexically;
- required request field `capture` removed;
- optional request field `statement_descriptor` added;
- response field `disputed` removed from the `charge` schema (behind the `$ref`);
- response field `amount_authorized` added to the `charge` schema.

The full 8 MB Stripe pair on disk carries no field-level changes between the two
snapshots (they are the same API re-serialized plus 23 provider-only paths), so
this extract injects the change a real breaking release would contain. Property
schemas and descriptions are copied verbatim from the real spec.
