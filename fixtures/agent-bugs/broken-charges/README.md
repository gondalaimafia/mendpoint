# Fettler fixture — broken charges client

Intentional bugs for **Fettler** (API debug agent):
1. Path typo `chargess`
2. Field `amount_cents` (should be `amount`)

Verify: `node check.mjs` (fails until Fettler fixes `client.js`).
