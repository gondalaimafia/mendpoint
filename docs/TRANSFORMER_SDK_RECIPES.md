# Regauge SDK migration recipes

Regauge executes SDK and runtime migrations as content-addressed, signed
provider-recipe artifacts. Each artifact binds to a deterministic executable
recipe that produces `replace_file` operations over an allowlisted set of paths,
runs objective verification, and can be rolled back by inverse operations. This
page states exactly what the shipped SDK recipes support and where they abstain.

Nothing here changes the enablement gate. The gate
(`MENDPOINT_REGAUGE_GATE`) defaults to DENIED and the customer-warden
profile keeps Regauge off, so these recipes are unreachable in a default
deployment.

Framework-upgrade recipes are documented separately in
`docs/TRANSFORMER_FRAMEWORK_RECIPES.md`; they share this catalog seam.

## Catalog wiring

`packages/transformer/src/published-recipes.ts` is the single seam that
populates the run-path catalog. It exports the canonical artifacts
(`PUBLISHED_PROVIDER_RECIPE_ARTIFACTS`), a signing helper
(`signPublishedProviderRecipes`), and a catalog builder
(`createPublishedProviderRecipeCatalog`).

Signing keys are never embedded in the repository. In production the offline
recipe-signing private key (held in a secret manager / KMS) signs the published
artifacts, and the deploy supplies the pre-signed artifacts plus the trusted
ed25519 public keys via configuration. The signing helper is used by that
trusted signing context (and by tests/evals with an ephemeral key); the catalog
builder consumes already-signed artifacts and trusted public keys.

Resolution returns `artifact.boundedEdits.implementationRecipe`, a
`RecipeReference` the workspace executor runs (behind the gate) exactly as the
Node runtime recipe does.

## `aws-sdk-js-v2-to-v3` (flagship)

Migrates a well-defined, mechanically-deterministic slice of AWS SDK for
JavaScript v2 to the modular v3 clients. It is intentionally bounded: anything
outside the supported surface is reported as out-of-scope by analysis and the
recipe abstains rather than producing a wrong edit. Every migration is delivered
as a human-reviewed draft PR with no auto-merge.

Executable recipe: `AWS_SDK_JS_V2_TO_V3_RECIPE` (`recipe.ts`).
Allowlisted paths: `package.json`, `src/s3.js`, `src/dynamo.js`.

### Supported

- Default `aws-sdk` namespace import, either
  `const AWS = require("aws-sdk")` (CommonJS) or `import AWS from "aws-sdk"`
  (ESM). The migrated imports match the source module system.
- Clients: `new AWS.S3(...)` becomes `new S3Client(...)`;
  `new AWS.DynamoDB.DocumentClient(...)` becomes
  `DynamoDBDocumentClient.from(new DynamoDBClient(...))`. An empty argument list
  becomes `{}`.
- Operations in `.<op>(<params>).promise()` call style, rewritten to
  `.send(new <Command>(<params>))`:
  - S3: `getObject`, `putObject`, `deleteObject`, `headObject`, `listObjectsV2`.
  - DynamoDB DocumentClient: `get`, `put`, `delete`, `query`, `update`, `scan`.
- Modular imports are emitted only for the commands and clients actually used,
  in a canonical order, from `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`,
  and `@aws-sdk/lib-dynamodb`.
- `package.json`: drops the `aws-sdk` dependency and adds the v3 client packages
  for the supported services.

### Out-of-scope (analysis abstains, status `unsupported`)

- Any other AWS service constructor (for example `new AWS.SQS(...)`,
  `new AWS.Lambda(...)`, or the low-level `new AWS.DynamoDB(...)`).
- Any other member access on the `AWS` namespace (for example
  `AWS.config.update(...)`).
- Client method calls in callback style, unsupported operations on a supported
  client, or `.promise()` operations whose parameters contain nested
  parentheses.
- Import forms other than the default `aws-sdk` namespace import (a different
  alias, or named/namespace imports).
- A migrated source that still contains any residual v2 surface after the
  transform.

### Known boundaries

- Paths are allowlisted by exact name (`package.json`, `src/s3.js`,
  `src/dynamo.js`), mirroring the framework's fixed-path model. Applying the
  recipe to a repository whose AWS usage lives at other paths is a separate,
  future concern (parameterized path allowlists) and is not part of this stage.
- The dependency swap provisions the v3 packages for both supported services;
  reviewers prune any unused package during PR review.
- Behavioral parity beyond the mechanical rewrite (runtime response shapes,
  pagination, streaming bodies) is confirmed by the consumer's own tests during
  human review, not asserted by the recipe.

### Verification and rollback

The executable recipe runs two allowlisted `node -e` verification commands in a
disposable workspace:

1. `aws-sdk-v3-source`: the migrated sources import `@aws-sdk` v3 modules and
   contain no `aws-sdk` import, no `new AWS.` client, and no `.promise()` usage.
2. `aws-sdk-v3-manifest`: `package.json` drops `aws-sdk` and declares the v3
   client packages.

Rollback is by inverse operations, which restores the exact input digest.

### Fixtures and evals

- Synthetic before/after consumer fixtures:
  `fixtures/consumers/aws-sdk-v2-to-v3/` (supported `before/`, deterministic
  `after/`, and an `out-of-scope/` case).
- Unit coverage: `packages/transformer/src/recipe-aws-sdk.test.ts` and
  `packages/transformer/src/published-recipes.test.ts`.
- Held-out contract-lane evals in
  `packages/eval/src/transformer-agent-eval.ts`:
  `transformer.execute.aws_sdk_v2_to_v3.heldout` (publish, resolve, execute,
  verify, inverse-restore) and `transformer.analysis.aws_sdk_abstain.heldout`
  (applies on supported sources, abstains on out-of-scope). No live model is
  used in this stage.

## `stripe-node-v10-to-v11`

Migrates the mechanically-deterministic slice of the stripe-node v10 to v11
major bump. v11 removed the deprecated client configuration setter methods
([migration guide for v11](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v11));
the supported values move into the options object passed as the second argument
to the Stripe constructor. Anything outside the supported surface is reported as
out-of-scope and the recipe abstains. Every migration is delivered as a
human-reviewed draft PR with no auto-merge.

Executable recipe: `STRIPE_NODE_V10_TO_V11_RECIPE` (`recipe.ts`).
Allowlisted paths: `package.json`, `src/payments.js`.

### Supported

- Exactly one client construction that binds a variable:
  `const <var> = Stripe(<key>)`, `const <var> = new Stripe(<key>)`, or
  `const <var> = require("stripe")(<key>)`. The `<key>` argument must be a single
  expression with no nested parentheses, comma, or object literal.
- Setter calls `<var>.<setter>(<value>)` in single-statement style with no
  nested parentheses in `<value>`, folded into the constructor options object in
  source order. Supported setters and their option keys: `setApiVersion` ->
  `apiVersion`, `setTimeout` -> `timeout`, `setHost` -> `host`, `setPort` ->
  `port`, `setProtocol` -> `protocol`, `setMaxNetworkRetries` ->
  `maxNetworkRetries`, `setTelemetryEnabled` -> `telemetry`, `setAppInfo` ->
  `appInfo`, `setHttpAgent` -> `httpAgent`.
- `package.json`: bumps the existing `stripe` dependency range to `^11.0.0`.

### Out-of-scope (analysis abstains, status `unsupported`)

- `setApiKey`, which rewrites the constructor's first argument rather than the
  options object.
- Any unrecognized `<var>.setX(...)` call, callback or nested-parenthesis call
  styles, or setter calls that cannot be anchored to the client variable.
- A construction that already carries an options object while setter calls
  remain, missing constructions, or more than one construction.

### Verification and rollback

The executable recipe runs two allowlisted `node -e` verification commands in a
disposable workspace:

1. `stripe-v11-source`: the migrated source contains no removed config setter
   calls.
2. `stripe-v11-manifest`: `package.json` declares the `stripe` dependency at v11.

Rollback is by inverse operations, which restores the exact input digest.

### Fixtures and evals

- Synthetic before/after consumer fixtures:
  `fixtures/consumers/stripe-node-v10-to-v11/` (supported `before/`,
  deterministic `after/`, and an `out-of-scope/` case using `setApiKey`).
- Unit coverage: `packages/transformer/src/recipe-stripe-node.test.ts` and
  `packages/transformer/src/published-recipes.test.ts`.
- Held-out contract-lane evals in
  `packages/eval/src/transformer-agent-eval.ts`:
  `transformer.execute.stripe_node_v10_to_v11.heldout` and
  `transformer.analysis.stripe_node_v10_to_v11_abstain.heldout`.

## `googleapis-v25-to-v26`

Migrates the mechanically-deterministic import change of the googleapis v25 to
v26 major bump. v26.0.0 optimized the package for es6 modules and made the
default import a breaking change: `const google = require("googleapis")` must
become the named import `const {google} = require("googleapis")`
([v26.0.0 release notes](https://github.com/googleapis/google-api-nodejs-client/releases/tag/v26.0.0)).
Consumer `google.*` usage is byte identical before and after, so only the import
line changes. Anything outside the supported surface is reported as out-of-scope
and the recipe abstains. Every migration is delivered as a human-reviewed draft
PR with no auto-merge.

Executable recipe: `GOOGLEAPIS_V25_TO_V26_RECIPE` (`recipe.ts`).
Allowlisted paths: `package.json`, `src/client.js`.

### Supported

- CommonJS default require bound to an identifier:
  `const <id> = require("googleapis")` becomes
  `const { google } = require("googleapis")` when `<id>` is `google`, or
  `const { google: <id> } = require("googleapis")` otherwise.
- ESM default import: `import <id> from "googleapis"` becomes
  `import { google } from "googleapis"` (or `import { google as <id> }`). The
  original declaration keyword (`const`/`let`/`var`) is preserved.
- `package.json`: bumps the existing `googleapis` dependency range to `^26.0.0`.

### Out-of-scope (analysis abstains, status `unsupported`)

- Namespace imports (`import * as x from "googleapis"`) or any googleapis
  reference that is not a recognized default or named import.
- A default binding whose usage already reads `<id>.google` (the v26 manual
  form), which would be double-migrated.

### Verification and rollback

The executable recipe runs two allowlisted `node -e` verification commands in a
disposable workspace:

1. `googleapis-v26-source`: the migrated source uses the named `google` import
   and contains no default `googleapis` import.
2. `googleapis-v26-manifest`: `package.json` declares the `googleapis`
   dependency at v26.

Rollback is by inverse operations, which restores the exact input digest.

### Fixtures and evals

- Synthetic before/after consumer fixtures:
  `fixtures/consumers/googleapis-v25-to-v26/` (supported `before/`,
  deterministic `after/`, and an `out-of-scope/` namespace-import case).
- Unit coverage: `packages/transformer/src/recipe-googleapis.test.ts` and
  `packages/transformer/src/published-recipes.test.ts`.
- Held-out contract-lane evals in
  `packages/eval/src/transformer-agent-eval.ts`:
  `transformer.execute.googleapis_v25_to_v26.heldout` and
  `transformer.analysis.googleapis_v25_to_v26_abstain.heldout`.
