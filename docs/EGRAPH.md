# E-Graph Algorithms for Mendpoint

E-graphs (equivalence graphs) compactly represent a large set of terms together with a **congruence** relation. They power **equality saturation**—non-destructive rewriting used in optimizers and synthesizers.

In Mendpoint they are **not** a call-graph replacement. They sit in the **migration / rewrite** stage after impact analysis has localized sites:

- Represent multiple equivalent API usage patterns at once  
- Explore migration rewrites without phase-ordering damage  
- Extract the “best” variant under a cost function  
- Carry e-class analyses (facts) such as “touches breaking field”

## 1. Core structure

| Piece | Role |
|-------|------|
| **E-node** | Operator + children as e-class ids, e.g. `field(c₁)` |
| **E-class** | Set of e-nodes known equivalent |
| **Union-find** | Partition of class ids (path compression + union-by-rank) |
| **Hash-cons / memo** | Canonical e-node → e-class (structural sharing) |

Children point to **classes**, so one e-node stands for exponentially many ground terms. Congruence: if `a ≡ b` then `f(a) ≡ f(b)`.

## 2. Algorithms (implemented in `@mendpoint/egraph`)

| Algorithm | Module |
|-----------|--------|
| Add term (bottom-up + hash-cons) | `EGraph.add` |
| Union / merge | `EGraph.union` |
| E-matching (patterns with `?vars`) | `EGraph.ematch` |
| Deferred **rebuild** (egg-style) | `EGraph.rebuild` |
| Equality saturation loop | `saturate()` |
| Extraction (greedy size DP) | `extract` / `extractOne` |
| E-class analyses (facts map) | `setFact` / `getFact` |
| API migration rules | `migration.ts` |

### Equality saturation

```
egraph ← make(initial_term)
while not saturated and under limits:
    for each rewrite rule:
        for each match of lhs:
            add(rhs[subst]); union(matched_class, new)
    rebuild()   # restore congruence in bulk
extract best term
```

Rewrites are **non-destructive**: old and new forms remain, linked by equivalence.

### Rebuild

Matching is a read phase; unions are a write phase. **Rebuild** amortizes congruence repair on a dirty worklist at phase boundaries (egg insight), instead of repairing after every merge.

## 3. Relevance to the product pipeline

```
ImpactReport (call graph + confirmation)
        ↓
localized code/API fragment as Term
        ↓
e-graph + migration rewrite rules
        ↓
extract preferred form → generation patch hints
```

Examples of rules:

- `field(amount_cents) ≡ field(amount)`  
- page pagination ≡ cursor pagination  
- `sdk(charges.create, body)` with field renames  

`migrateFromFixHint` bridges impact `fixHint` strings into saturation.

## 4. Versioned / persistent connection

Full **versioned e-graphs** (hierarchy of equivalence relations over a shared term space) align with our persistent call-graph store, but are a later upgrade. Today:

- `compareMigrationStrategies` runs separate e-graphs (A/B rule sets)  
- Call-graph persistence remains the multi-version backbone for **structure**  
- E-graphs handle **local rewrite search** on fragments  

## 5. Practical limits

- Growth control: `maxIterations`, `nodeLimit`  
- Apply to **impacted slices**, not whole repos  
- Cost functions are domain knobs (`migrationCost`, `astSizeCost`)  
- Production systems often use **egg** (Rust); this package is a TS-native MVP for the monorepo  

## 6. API sketch

```ts
import {
  EGraph, app, lit, saturate, defaultApiMigrationRules,
  exploreMigration, migrateFromFixHint,
} from "@mendpoint/egraph";

const eg = new EGraph();
const root = eg.add(app("field", lit("amount_cents")));
saturate(eg, defaultApiMigrationRules());
eg.extractOne(root);

exploreMigration(app("sdk", lit("charges.create"), app("field", lit("amount_cents"))));
migrateFromFixHint("amount_cents → amount");
```

## 7. Summary

E-graphs maintain congruence closure, e-match modulo equivalence, rebuild amortizes invariant restoration, equality saturation explores rewrites non-destructively, and extraction picks a representative. In Mendpoint they are most powerful **after** call-graph impact localization, as the backend for migration strategy search and PR-quality rewrites.
