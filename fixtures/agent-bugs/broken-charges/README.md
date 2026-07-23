# Agent bug fixture — broken charges client

Intentional bugs:
1. Path typo `chargess`
2. Field `amount_cents` (should be `amount`)

Verify: `node check.mjs` (fails until agent fixes `client.js`).
