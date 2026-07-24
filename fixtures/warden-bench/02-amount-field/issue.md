# Charges API rejects amount_cents

The vendor deprecated the request field `amount_cents`. Create-charge now returns a validation error: the field is not allowed / unknown.

Please rename the payload field to **`amount`** (integer in the smallest currency unit) so charges succeed again. Currency handling can stay as-is.
