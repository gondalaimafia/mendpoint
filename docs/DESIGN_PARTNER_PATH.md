# Design-partner path (FDE)

Zero-dependency onboarding checklist for a design partner trial of **Mendpoint / Fettler**.  
Claim-safe language: [`WARDEN_CLAIMS.md`](./WARDEN_CLAIMS.md).

---

## Steps

### 1. Install

```bash
git clone https://github.com/gondalaimafia/mendpoint.git
cd mendpoint
npm install
```

Requires Node ≥ 20.

### 2. Seed

```bash
npm run db:seed
```

Loads local SQLite control plane (`data/mendpoint.sqlite`) with demo providers/consumers.

### 3. Poll (optional feed loop)

```bash
npm run worker:poll      # one-shot OpenAPI / feed poll
npm run worker:jobs      # drain fan-out job queue
```

### 4. Pipeline (impact → migration PR mock)

```bash
npm run demo             # Acme OpenAPI diff → shop-app impact → PR candidate halted at delivery gates (fail-closed, no PR opened)
npm run examples         # multi-vendor migration fixtures
```

Artifacts under `.mendpoint/mock-github/` and example runs under `.mendpoint/example-runs/`.

### 5. PR delivery (real GitHub, optional)

```bash
# requires gh auth + env for the phase-a ship path
npm run phase-a
```

Policy: **never auto-merge by default**. Human review always.

### 6. Optional Fettler (on-demand API debug)

```bash
npm run agent:demo       # fixture path-typo + field rename
npm run agent:test       # unit + heuristic agent tests
npm run eval:warden      # internal warden-bench (not for marketing)
```

UI (when stack is up):

```bash
npm run dev:api          # :3001
npm run dev:web          # :3000  · /agent
```

Fettler accepts a natural-language goal + optional `verifyCommand`. If verify is omitted, `discoverVerifyCommand(repoRoot)` can infer `npm test`, `node check.mjs`, `pytest`, or `go test ./...`.

---

## Quality bars (internal)

| Check | Command |
|-------|---------|
| Unit / workspace tests | `npm test` |
| Design-partner impact recall | `npm run eval:partners` |
| Fettler fixture bench | `npm run eval:warden` |
| Language harnesses | `npm run phase-a:harness`, `phase-c:python`, … |

---

## What to show the partner

1. **Breaking before prod** — `npm run demo`  
2. **Vendor examples** — `npm run examples`  
3. **Fettler on a ticket-style goal** — `npm run agent:demo` or `/agent`  
4. **Reviewable PR** — mock or real; no auto-merge  

Avoid claiming continuous changelog-RSS forever, unprompted silent-drift hunting, audited $ savings, or published bench leadership. See [`WARDEN_CLAIMS.md`](./WARDEN_CLAIMS.md).
