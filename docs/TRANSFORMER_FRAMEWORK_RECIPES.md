# Transformer framework migration recipes

Transformer executes framework upgrades as content-addressed, signed
provider-recipe artifacts, the same seam the SDK recipes use (see
`docs/TRANSFORMER_SDK_RECIPES.md`). Each artifact binds to a deterministic
executable recipe that produces `replace_file` operations over an allowlisted
set of paths, runs objective verification, and can be rolled back by inverse
operations. This page states exactly what the shipped framework recipes support
and where they abstain.

Nothing here changes the enablement gate. The gate
(`MENDPOINT_TRANSFORMER_GATE`) defaults to DENIED and the customer-warden
profile keeps Transformer off, so these recipes are unreachable in a default
deployment. Every migration is delivered as a human-reviewed draft PR with no
auto-merge.

## Catalog wiring

`packages/transformer/src/published-recipes.ts` is the single seam that
populates the run-path catalog. The framework artifacts sit alongside the SDK
artifacts in `PUBLISHED_PROVIDER_RECIPE_ARTIFACTS`, are signed by the offline
recipe-signing key, and resolve to `artifact.boundedEdits.implementationRecipe`,
a `RecipeReference` the workspace executor runs behind the gate exactly as the
Node runtime recipe does. Signing keys are never embedded in the repository.

## `react-dom-17-to-18` (flagship)

Migrates the mechanically-deterministic slice of the React 17 to 18 client-render
change. React 18 replaced the legacy `ReactDOM.render`/`ReactDOM.hydrate` entry
points with the `react-dom/client` root API
([React 18 upgrade guide](https://react.dev/blog/2022/03/08/react-18-upgrade-guide)).
Anything outside the supported surface is reported as out-of-scope by analysis
and the recipe abstains rather than producing a wrong edit.

Executable recipe: `REACT_DOM_17_TO_18_RECIPE` (`recipe.ts`).
Allowlisted paths: `package.json`, `src/index.jsx`, `src/index.tsx`.

### Supported

- A default `react-dom` import bound to an identifier, either
  `const <id> = require("react-dom")` (CommonJS) or
  `import <id> from "react-dom"` (ESM), on its own single line. The migrated
  import keeps the source module system and emits only the symbols actually used
  (`createRoot`, `hydrateRoot`) from `react-dom/client`.
- `<id>.render(<element>, <container>)` becomes
  `createRoot(<container>).render(<element>)`.
- `<id>.hydrate(<element>, <container>)` becomes
  `hydrateRoot(<container>, <element>)`.
- Arguments are split on top-level commas with balanced-delimiter and string
  scanning, so JSX elements and container expressions such as
  `document.getElementById("root")` are relocated byte-for-byte.
- `package.json`: bumps the existing `react` and `react-dom` dependency ranges to
  `^18.2.0`.

### Out-of-scope (analysis abstains, status `unsupported`)

- `unmountComponentAtNode`, which cannot be rewritten deterministically without
  the root handle the new API returns.
- Any other member access on the `react-dom` binding (for example
  `<id>.findDOMNode` or `<id>.createPortal`).
- The removed third callback argument on `render`/`hydrate`, or any argument
  count other than two.
- More than one `render`/`hydrate` call that shares the same container
  expression.
- Non-default `react-dom` import forms (named imports, namespace imports, or any
  unrecognized form).
- A migrated source that still carries any legacy react-dom surface after the
  transform.

### Known boundaries

- Paths are allowlisted by exact name (`package.json`, `src/index.jsx`,
  `src/index.tsx`), mirroring the framework's fixed-path model. A repository whose
  React entry point lives elsewhere is a separate, future concern (parameterized
  path allowlists) and is not part of this stage.
- The recipe migrates the client-render entry point only. Concurrent-feature
  adoption, `StrictMode` behavior changes, and other React 18 runtime differences
  are confirmed by the consumer's own tests during human review, not asserted by
  the recipe.

### Verification and rollback

The executable recipe runs two allowlisted `node -e` verification commands in a
disposable workspace:

1. `react-dom-18-source`: the migrated source imports from `react-dom/client` and
   contains no legacy `react-dom` import or require.
2. `react-dom-18-manifest`: `package.json` declares the `react` and `react-dom`
   dependencies at v18.

Rollback is by inverse operations, which restores the exact input digest.

### Fixtures and evals

- Synthetic before/after consumer fixtures:
  `fixtures/consumers/react-dom-17-to-18/` (supported `before/`, deterministic
  `after/`, and an `out-of-scope/` case using the removed render callback).
- Unit coverage: `packages/transformer/src/recipe-react-dom.test.ts` and
  `packages/transformer/src/published-recipes.test.ts`.
- Held-out contract-lane evals in
  `packages/eval/src/transformer-agent-eval.ts`:
  `transformer.execute.react_dom_17_to_18.heldout` (publish, resolve, execute,
  verify, inverse-restore) and
  `transformer.analysis.react_dom_17_to_18_abstain.heldout` (applies on supported
  sources, abstains on out-of-scope, reports already_applied on migrated
  sources). No live model is used in this stage.
