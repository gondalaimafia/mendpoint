# Regauge internal / custom API-refactor recipes

The internal API-refactor family is the fourth Regauge family, alongside the
SDK (`docs/TRANSFORMER_SDK_RECIPES.md`), framework
(`docs/TRANSFORMER_FRAMEWORK_RECIPES.md`), and runtime
(`docs/TRANSFORMER_RUNTIME_RECIPES.md`) families. It shares the same catalog
seam: each recipe is a content-addressed, signed provider-recipe artifact that
binds to a deterministic executable recipe producing `replace_file` operations
over an allowlisted set of paths, runs objective verification, and can be rolled
back by inverse operations.

Unlike the other three families, there is no universal "internal API." A
third-party SDK or the Node runtime has one well-defined version transition; a
customer's internal refactor does not. This family is therefore config/spec
driven and built honestly as such. It is NOT a general semantic refactorer. It
carries exactly one mechanically-safe operation for v1, and everything outside
that narrow surface is reported out-of-scope by analysis so the recipe abstains
rather than editing customer code it cannot prove is the exact target.

Nothing here changes the enablement gate. The gate
(`MENDPOINT_TRANSFORMER_GATE`) defaults to DENIED and the customer-warden
profile keeps Regauge off, so these recipes are unreachable in a default
deployment. Every migration is delivered as a human-reviewed draft PR with no
auto-merge.

## Spec-driven model

A refactor is described by a spec (data), and the factory
`createInternalApiRenameRecipe(spec)` produces a deterministic executable recipe
from it. The spec is:

```ts
type InternalApiRenameSpec = {
  recipeId: string;
  version: number;
  title: string;
  source: string;
  target: string;
  module: string;   // the internal module specifier, e.g. "@acme/user-service"
  from: string;     // the exported binding to rename, e.g. "getUser"
  to: string;       // the new name, e.g. "fetchUser"
  paths: string[];  // the allowlisted consumer source files
};
```

The spec rides on the recipe's preconditions and transforms
(`internal_api_rename_source` / `internal_api_rename`), which are folded into the
recipe's content-addressed digest. Two specs that differ only in their data
produce different digests, so each instantiation is a distinct, independently
signed artifact. This is exactly how the family is wired end-to-end through the
catalog, the same as the other three families.

## The single supported operation: rename an imported binding and its call sites

Given a spec `{ module, from, to }`, the recipe renames a named import `from`
(imported from exactly `module`) to `to` and rewrites every bare-identifier call
site `from(...)` to `to(...)`. The import specifier and call sites are located
with a string-, comment-, template-, and regex-aware scanner, never a naive
regex, so strings, comments, template-literal text, regex literals, and
unrelated identifiers are never corrupted.

### Supported

- Exactly one supported import of `from` from `module`, either an ESM named
  import `import { from } from "module"` or a CommonJS destructure
  `const { from } = require("module")`. Additional named specifiers on the same
  statement are preserved byte-for-byte.
- Every non-import reference to the `from` identifier is a bare call site
  `from(...)` in value position. Member calls on other objects
  (`obj.from(...)`) belong to a different binding and are left untouched.

### Out-of-scope (analysis abstains, status `unsupported`)

- The same identifier imported from a DIFFERENT module (the classic
  false-positive trap): `recipe_internal_api_binding_unresolved`. It is far
  better to abstain than to rename an unrelated symbol.
- An aliased import (`from as x`): `recipe_internal_api_aliased_import`.
- The binding imported from `module` on more than one statement:
  `recipe_internal_api_multiple_imports`.
- Any non-call reference to the binding, including a value reference, a spread
  (`...from`), a member access on the binding (`from.field`), a local
  declaration or shadow (`const from`, `function from`), an object/class method
  definition named `from`, or a computed/dynamic call form:
  `recipe_internal_api_unsupported_reference`.
- A repository where the target name `to` already appears as a code identifier:
  `recipe_internal_api_target_conflict`.

A repository whose import already reads `to` with no remaining `from` binding
classifies as already applied.

## Worked example: `internal-api-acme-user-getuser-to-fetchuser`

The published worked example instantiates the factory with a realistic internal
refactor: the internal team renamed the exported binding `getUser` to
`fetchUser` in the internal package `@acme/user-service`, and consumers must
update their imports and call sites.

- Provider: `acme-internal-user-api` (category `identity`). This honestly
  represents an internal API, not a third-party vendor.
- Change target: `api`. From version `1` to version `2`.
- Executable recipe: `INTERNAL_API_ACME_USER_RENAME_RECIPE` (`recipe.ts`),
  produced by `createInternalApiRenameRecipe`.
- Allowlisted paths: `src/profile.ts`, `src/settings.ts`.
- Spec: `{ module: "@acme/user-service", from: "getUser", to: "fetchUser" }`.

Verification runs two objective checks in a disposable workspace: the migrated
consumer sources contain no `getUser` call sites, and they call `fetchUser` in
at least one file. Rollback restores the exact input via inverse operations.

Consumer fixtures live in
`fixtures/consumers/internal-api-acme-user-rename/` (before / after /
out-of-scope, LF-pinned). The `after/` tree is the exact deterministic output of
the transform and is asserted byte-for-byte in
`packages/transformer/src/recipe-internal-api.test.ts`. The `out-of-scope/` tree
is the false-positive trap: both files call `getUser` and both import from the
target module, but `getUser` is bound to a different module
(`@acme/admin-service`), so the recipe abstains.

## Catalog wiring

`packages/transformer/src/published-recipes.ts` publishes
`INTERNAL_API_ACME_USER_RENAME_ARTIFACT` into `PUBLISHED_PROVIDER_RECIPE_ARTIFACTS`
alongside the SDK, framework, and runtime artifacts. Signing and resolution work
exactly as for the other families: the offline signing key signs the artifact,
the deploy supplies the pre-signed artifact and trusted public keys, and
resolution returns `artifact.boundedEdits.implementationRecipe`, the
`RecipeReference` the workspace executor runs behind the gate.

## Adding another internal refactor

Author a new spec, call `createInternalApiRenameRecipe(spec)`, register the
returned recipe in `RECIPE_REGISTRY` and `SIGNED_NODE_RECIPES`, add a matching
signed artifact with `change.target: "api"`, and add before / after /
out-of-scope fixtures plus a byte-exact recipe test. Keep the operation within
the supported surface above; if a refactor needs anything beyond the single
rename operation, it is out of scope for v1 and should abstain rather than force
an edit.
