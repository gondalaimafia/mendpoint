# Pilot repos (Day-15 style dogfood targets)

Internal dogfood uses **in-repo fixtures** until external pilots are attached.

| Agent | Pilot | Path | Notes |
|-------|-------|------|--------|
| **Fettler** | Acme payments + shop-app | `fixtures/providers/acme-payments`, `fixtures/consumers/shop-app` | OpenAPI v1→v2, impact PRs |
| **Fettler** | Flagship offline packs | `fixtures/providers/*-flagship` | Stripe/OpenAI/Twilio/AWS/Plaid shapes |
| **Fettler** | API debug | `fixtures/warden-bench/*`, `fixtures/agent-bugs/broken-charges` | Contract/agent loops |
| **Regauge** | Campaign scaffold | synthetic via `POST /transformer/campaigns` | BSG/DAG multi-repo plan |

### Baseline metrics (capture on first dogfood)

- Time to `npm run demo` green  
- `npm run eval:warden` pass rate  
- Graph-learn nodes/edges after one pipeline run (`GET /graph-learn/stats`)  

### External pilot checklist

1. Grant PR permissions to install App / token  
2. `POST /consumers` + monitor + local clone path  
3. Record baseline: open findings count, feed poll time  
4. File tickets only against pilot for first 30 runs  
