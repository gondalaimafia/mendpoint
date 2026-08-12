# Transformer runtime migration recipes

Transformer executes language and runtime upgrades as content-addressed, signed
provider-recipe artifacts, the same seam the SDK recipes
(`docs/TRANSFORMER_SDK_RECIPES.md`) and framework recipes
(`docs/TRANSFORMER_FRAMEWORK_RECIPES.md`) use. Each artifact binds to a
deterministic executable recipe that produces `replace_file` operations over an
allowlisted set of paths, runs objective verification, and can be rolled back by
inverse operations. This page states exactly what the shipped runtime recipes
support and where they abstain.

Nothing here changes the enablement gate. The gate
(`MENDPOINT_TRANSFORMER_GATE`) defaults to DENIED and the customer-warden
profile keeps Transformer off, so these recipes are unreachable in a default
deployment. Every migration is delivered as a human-reviewed draft PR with no
auto-merge.

## Catalog wiring

`packages/transformer/src/published-recipes.ts` is the single seam that
populates the run-path catalog. The runtime artifact sits alongside the SDK and
framework artifacts in `PUBLISHED_PROVIDER_RECIPE_ARTIFACTS`, is signed by the
offline recipe-signing key, and resolves to
`artifact.boundedEdits.implementationRecipe`, a `RecipeReference` the workspace
executor runs behind the gate. Signing keys are never embedded in the
repository. The artifact declares `change.target: "runtime"`, the change-target
value the runtime family uses.

## `node-runtime-20-to-22` (flagship)

Bumps the Node major-version pins from 20 to 22 across the config surface a
Node repository declares its runtime in
([Node.js 22 release notes](https://nodejs.org/en/blog/release/v22.0.0)). This is
a pin-bump recipe: it rewrites version declarations only and reuses the same
runtime precondition and transform kinds as the shipped `node-runtime-18-to-20`
recipe. It does not rewrite application source, so it makes no claim about
source-level Node 22 behavioral differences.

Executable recipe: `NODE_RUNTIME_20_TO_22_RECIPE` (`recipe.ts`).
Allowlisted paths: `.node-version`, `.nvmrc`, `Dockerfile`, `package.json`.

### Supported

- `package.json` `engines.node` equal to one of the recognized Node 20
  selectors (`20`, `20.x`, `^20.0.0`, `>=20 <21`), rewritten to `>=22 <23`.
- `.nvmrc` and `.node-version` whose major reads `20`, rewritten to `22`. Both
  files are optional; an absent file is left untouched.
- A `Dockerfile` with `FROM node:20...` base image tags, rewritten to
  `node:22...`. The file is optional.

### Out-of-scope (analysis abstains, status `unsupported`)

- A `package.json` `engines.node` value outside the recognized Node 20 selector
  set, for example an open-ended range such as `>=20` that cannot be narrowed to
  a Node 22 range without changing meaning.
- A `Dockerfile` base image pinned to any other major, for example `node:21`,
  which the recipe does not recognize as a Node 20 pin and will not rewrite.
- A repository whose pins are already inconsistent (some at 20 and some at 22),
  which is reported rather than merged into a single bump.

A repository whose recognized pins already read Node 22 classifies as
`already_applied`, and the recipe makes no edit.

### Known boundaries

- Paths are allowlisted by exact name (`.node-version`, `.nvmrc`, `Dockerfile`,
  `package.json`), mirroring the fixed-path model of the other recipe families. A
  repository that declares its runtime elsewhere (for example a CI workflow
  matrix) is a separate, future concern and is not part of this stage.
- The recipe bumps version pins only. Source-level Node 22 breaking changes are
  confirmed by the consumer's own tests during human review, not asserted by the
  recipe. No speculative source codemod is included.

### Verification and rollback

The executable recipe runs two allowlisted `node -e` verification commands in a
disposable workspace:

1. `runtime-declarations`: the optional `.nvmrc`, `.node-version`, and
   `Dockerfile` pins that are present all target Node 22.
2. `package-engine`: `package.json` declares `engines.node` at `>=22 <23`.

Rollback is by inverse operations, which restores the exact input digest.

### Fixtures and evals

- Synthetic before/after consumer fixtures:
  `fixtures/consumers/node-runtime-20-to-22/` (supported `before/`, deterministic
  `after/`, and an `out-of-scope/` case pinning the Dockerfile base image to an
  unexpected major).
- Unit coverage: `packages/transformer/src/recipe-node-runtime.test.ts` and
  `packages/transformer/src/published-recipes.test.ts`.
- Held-out contract-lane evals in
  `packages/eval/src/transformer-agent-eval.ts`:
  `transformer.execute.node_runtime_20_to_22.heldout` (publish, resolve, execute,
  verify, inverse-restore) and
  `transformer.analysis.node_runtime_20_to_22_abstain.heldout` (applies on
  supported pins, abstains on out-of-scope, reports already_applied on migrated
  pins). No live model is used in this stage.
