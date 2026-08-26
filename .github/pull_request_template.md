## Objective

Closes #

## Author

- [ ] Claude Code
- [ ] OpenAI Codex
- [ ] Human

## What changed

Describe the implementation.

## Why

Explain the underlying problem/root cause.

## Scope

List the primary areas changed.


## Failure-mode checks

See `docs/agents/FAILURE_MODES.md`. Tick what applies; state N/A with a reason.

- [ ] **Delete-the-check run**: each new control was reverted, the suite went red, restored — output quoted
- [ ] No source-text scan (`readFileSync` + regex) stands in for behavioural coverage
- [ ] Every value answering a question about the world can express "not determined"; every `catch` and default fails **closed**
- [ ] Claimed capabilities have a **traced production call path** (not test-only callers)
- [ ] New DB columns are in **both** the `CREATE TABLE` and the additive-migration list
- [ ] `completeJob` / `failJob` returning `false` throws — a lost lease is never success
- [ ] New configuration is declared in `config/required-configuration.json` with its scope
- [ ] If this touches a scheduled or secret-bearing workflow: **dispatched post-merge and the run's conclusion read** (merge is not done; a green run is)

## Product impact

- [ ] Fettler
- [ ] ReGauge
- [ ] Shared platform
- [ ] Change Graph
- [ ] Model router
- [ ] Learning system
- [ ] Infrastructure
- [ ] No product behavior change

## Architecture impact

- [ ] No architecture change
- [ ] Existing ADR applies
- [ ] New ADR added
- [ ] Human architecture review required

## Verification

Commands/tests run:

```text
...
```

## Regression coverage

Describe new or existing regression coverage.

## Security / governance

Does this change affect authentication, authorization, tenant boundaries, secrets, residency, consent, training data, or external execution?

If yes, explain.

## Rollback

Explain how this change can be reverted or disabled.

## Known risks

List remaining risks.

## Peer reviewer

- Claude author → Codex
- Codex author → Claude

## Review state

- [ ] Peer review requested
- [ ] Peer review complete
- [ ] P0/P1 findings resolved
- [ ] P2 findings resolved or explicitly accepted/escalated
- [ ] CI green
- [ ] Ready for human merge
