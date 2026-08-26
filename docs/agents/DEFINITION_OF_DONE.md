# Mendpoint Definition of Done

A coding task is not complete merely because the implementation exists.

A task is DONE only when:

- acceptance criteria are satisfied
- implementation is scoped to the issue
- relevant tests exist
- regression coverage exists where appropriate
- tests pass
- lint/typecheck/build pass where applicable
- the full diff has been inspected
- no secrets or accidental artifacts are present
- the product specification remains consistent
- an ADR is updated/created when required
- a PR exists
- an independent Claude reviewer completed peer review
- P0/P1 findings are resolved
- P2 findings are resolved or explicitly accepted/escalated
- peer review is rerun after substantive changes
- required PR CI is green
- rollback implications are understood
- known risks are documented
- the PR is merge-ready after independent Claude review: agent merge if closure contexts are green; operator merge if they are red. Codex-authored work stays human merge unless delegated
- production deploy is the `main` `deploy` job, not a second pipeline
