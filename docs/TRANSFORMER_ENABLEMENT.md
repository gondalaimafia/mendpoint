# Regauge bounded-pilot enablement (Stage T5)

This runbook is the exact, explicit set of steps a human runs to enable
Regauge for ONE pilot tenant. It is the prove-then-enable flip: the config
is PREPARED in code, and a person deliberately applies it.

**Status: prepared, not applied.** Landing the T5 change sets no production
secret and changes production behavior by exactly zero. `MENDPOINT_TRANSFORMER_GATE`
stays unset, so `assessTransformerGate` stays fail-closed (denied) everywhere.
The customer-warden profile stays Regauge-off and still forbids any gate
config. Nothing enables Regauge until an operator runs the steps below.

## What is prepared

- Generator: `packages/ops/src/transformer-enablement.ts`
  (`generatePilotTransformerGateConfig`, `serializePilotTransformerGateConfig`,
  `samplePilotTransformerGateConfig`), exported from `@mendpoint/ops`.
- Tests: `packages/ops/src/transformer-enablement.test.ts`.
- Mechanism it configures (do not weaken): `packages/ops/src/transformer-gate.ts`
  (`assessTransformerGate`).
- Acceptance evidence: the passing end-to-end canary
  (`packages/eval/src/transformer-canary.ts`, `npm run eval:transformer:canary`).

The generator produces a valid `TransformerGateConfig` that grants exactly one
named pilot tenant in one named environment, for the requested boundaries
(`api_control_plane`, `worker_action`, `ui`, `delivery`), with
`acceptanceEvidenceRefs` pinned to the passing canary and, for a delivery grant
in production, a matching `productionDeliveryApprovalRefs`.

## Honest scope of the acceptance evidence

- The canary is SYNTHETIC. It runs against a MOCK SCM (mock GitHub and GitLab
  adapters) and synthetic fixtures, with no live model and no network. Its
  `passed` flag is the machine-checkable go/no-go signal for this flip.
- A real customer-repository proof is a separate step and is still PENDING. This
  runbook does not claim that proof exists. Do not overstate what the canary
  covers.
- The bounded pilot exists so a real repository can be exercised under a single,
  reversible grant while every other tenant, environment, and boundary stays
  denied.

## The sample (clearly-fake) config

`samplePilotTransformerGateConfig()` returns an example for docs and tests only.
It names the fake tenant `tenant-pilot-example` in `production`, grants all four
boundaries, and carries the sample delivery approval
`approval:transformer-pilot-delivery:example`. It is not a real customer and
must not be applied as-is.

## Flip: enable one pilot tenant

Do this only when the canary is green and a human has decided to proceed for a
specific pilot tenant.

1. Confirm the acceptance evidence is green.

   ```
   npm run eval:transformer:canary
   ```

   The command must print `Transformer canary PASS` and exit zero. If it does
   not, stop. Do not flip.

2. Generate the gate config value for the real pilot tenant and environment.
   Pass the real tenant id and environment explicitly; do not commit them. For a
   delivery grant in production, pass the external release approval reference(s).

   ```
   node --input-type=module -e "import { serializePilotTransformerGateConfig } from '@mendpoint/ops'; process.stdout.write(serializePilotTransformerGateConfig({ tenantId: process.env.PILOT_TENANT_ID, environment: process.env.PILOT_ENVIRONMENT, productionDeliveryApprovalRefs: (process.env.PILOT_DELIVERY_APPROVAL_REFS ?? '').split(',').filter(Boolean) }))"
   ```

   Set `PILOT_TENANT_ID`, `PILOT_ENVIRONMENT`, and (for production delivery)
   `PILOT_DELIVERY_APPROVAL_REFS` in your shell before running. To scope the
   grant to a subset of boundaries, add `boundaries: [...]` to the options
   object. The generator refuses to emit a production delivery grant that lacks
   an approval reference, so a dead grant cannot be produced by mistake.

3. Set the value as the pilot deployment's production secret. Do NOT set it on
   the customer-warden profile. Use your deployment's secret mechanism, for
   example:

   ```
   fly secrets set MENDPOINT_TRANSFORMER_GATE="$GATE_JSON" -a <pilot-app>
   ```

   If the pilot uses the adaptive or learning lanes, set the associated flags as
   production secrets in the same step per that lane's own runbook. Leave every
   other tenant and environment untouched.

4. Verify the flip on the running deployment before announcing it. Confirm the
   pilot tenant is allowed on its granted scope and everything else is still
   denied:

   ```
   node --input-type=module -e "import { assessTransformerGate } from '@mendpoint/ops'; const t=process.env.PILOT_TENANT_ID, e=process.env.PILOT_ENVIRONMENT; console.log('pilot allowed:', assessTransformerGate({ tenantId: t, environment: e, boundary: 'api_control_plane' }).allowed); console.log('other tenant denied:', assessTransformerGate({ tenantId: 'tenant-not-pilot', environment: e, boundary: 'api_control_plane' }).allowed === false)"
   ```

   Run this in the deployment where the secret is set so it reads the live
   `MENDPOINT_TRANSFORMER_GATE`. Expect `pilot allowed: true` and
   `other tenant denied: true`. For a production delivery grant, also confirm the
   delivery boundary is denied without the approval reference and allowed with
   it.

## Rollback: return to fail-closed

Rollback is a single action: remove the secret. With no config, the gate default
is denied, so Regauge is off again for everyone.

```
fly secrets unset MENDPOINT_TRANSFORMER_GATE -a <pilot-app>
```

Then re-verify that the gate is denied:

```
node --input-type=module -e "import { assessTransformerGate } from '@mendpoint/ops'; const d=assessTransformerGate({ tenantId: process.env.PILOT_TENANT_ID, environment: process.env.PILOT_ENVIRONMENT, boundary: 'api_control_plane' }); console.log('denied:', d.allowed === false, d.reasons)"
```

Expect `denied: true` with reason `transformer_gate_config_missing`. If you also
set adaptive or learning flags in step 3, unset those too.

## Invariants this runbook does not touch

- The gate default stays unset => denied; `assessTransformerGate` is not
  weakened.
- The customer-warden profile stays Regauge-off and still forbids
  `MENDPOINT_TRANSFORMER_GATE`. Do not enable Regauge on that profile.
- Security classification, mutation fencing, human review with no auto-merge,
  delivery guards, and learning-loop guards are unchanged. Delivery stays
  draft-only and never merges.
- The flip is a deliberate human action, per pilot tenant, and is reversible by
  unsetting one secret.
