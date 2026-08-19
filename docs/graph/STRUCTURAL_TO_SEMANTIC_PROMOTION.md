# Structural to semantic promotion

## Ownership boundary

Graphify can observe structural calls, imports, inheritance, and references. It cannot assert that a symbol is a Stripe SDK method or that the method implements one provider endpoint. Mendpoint retains those semantic decisions.

## First Stripe vertical

The joined test builds this path:

```text
POST /v1/charges
→ stripe charges.create
→ createCharge
→ checkout
→ testCheckout
```

The direct Stripe SDK anchor comes from Mendpoint's provider-aware codebase index using package/import context and the explicit `charges.create` to `POST /v1/charges` binding. Graphify-derived structural calls expand from the anchored function to the wrapper and test. Symbol-name similarity alone cannot create `USES_ENDPOINT`.

The resulting immutable software-graph publication retains:

- provider/OpenAPI evidence on endpoint and SDK facts;
- exact source evidence on the direct SDK use;
- structural extraction digest and edge IDs on Graphify-derived wrapper/test relationships;
- Graphify extractor identity and Mendpoint confidence mapping;
- exact tenant, repository, repository snapshot, provider snapshot, and graph version.

## Promotion states

An observed Graphify edge is still structural evidence. Provider/package corroboration may promote it into an active semantic path. Inferred or ambiguous structural edges retain lower confidence and cannot be silently presented as deterministic exact facts. Runtime-only behavior remains incomplete until runtime evidence exists.

## Evidence path rule

User-facing Fettler paths are Mendpoint semantic paths, not Graphify shortest paths. Every hop resolves to its structural, provider, runtime, or test evidence. Communities and centrality may become risk features for Regauge, but never architecture truth without corroboration.
