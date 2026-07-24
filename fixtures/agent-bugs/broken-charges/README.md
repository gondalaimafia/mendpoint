# Welder fixture — broken charges client

Intentional bugs for **Welder** (API debug agent):
1. Path typo `chargess`
2. Field `amount_cents` (should be `amount`)

Verify: `node check.mjs` (fails until Welder fixes `client.js`).
