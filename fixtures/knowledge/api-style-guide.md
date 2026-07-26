# Warden API style guide (seed)

- Version via `/vN/` or documented version header
- Mutating POST/PUT: document `Idempotency-Key`
- Lists: cursor or page+limit pagination
- Document 4xx with stable error codes
- Breaking renames: check consumer registry first
- Never auto-merge consumer PRs
