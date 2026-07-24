# Warden / Mendpoint demo matrix

Quick reference for FDE demos and CI.  
Claims: [`WARDEN_CLAIMS.md`](./WARDEN_CLAIMS.md) · Partner path: [`DESIGN_PARTNER_PATH.md`](./DESIGN_PARTNER_PATH.md).

| Demo | Command / UI | Status |
|------|----------------|--------|
| Breaking before prod (OpenAPI → impact → mock PR) | `npm run demo` | ✅ |
| Multi-vendor migration examples | `npm run examples` | ✅ |
| Adopt / new capability sample | `npm run examples -- 05` | ✅ |
| TS impact harness | `npm run phase-a:harness` | ✅ |
| Python / Go / Java / Ruby harnesses | `npm run phase-c:python` … `phase-e:ruby` | ✅ |
| Feed poll once | `npm run worker:poll` | ✅ |
| Job drain | `npm run worker:jobs` | ✅ |
| Design-partner impact eval | `npm run eval:partners` | ✅ |
| Warden agent fixture demo | `npm run agent:demo` | ✅ |
| Warden unit tests | `npm run agent:test` | ✅ |
| **warden-bench (internal)** | `npm run eval:warden` | ✅ |
| Warden UI | `npm run dev:web` → `/agent` (+ `dev:api`) | ✅ |
| Real GitHub PR ship | `npm run phase-a` (needs `gh` auth) | ⚠️ env |

---

## Suggested 15-minute script

1. `npm run db:seed` (if fresh clone)  
2. `npm run demo` — show mock PR + findings  
3. `npm run agent:demo` — show Warden fix + report  
4. Open `/agent` if web is running  
5. Optionally `npm run eval:warden` and stress **internal-only** numbers  

---

## Docs map

| Doc | Use |
|-----|-----|
| [`WARDEN_CLAIMS.md`](./WARDEN_CLAIMS.md) | Public language |
| [`WARDEN_BENCH_INTERNAL.md`](./WARDEN_BENCH_INTERNAL.md) | Bench how-to + non-marketing |
| [`DESIGN_PARTNER_PATH.md`](./DESIGN_PARTNER_PATH.md) | Install → seed → poll → pipeline → PR → Warden |
| [`API_BUG_AGENT.md`](./API_BUG_AGENT.md) | Agent architecture |
| [`EXAMPLES.md`](./EXAMPLES.md) | Vendor fixtures |
