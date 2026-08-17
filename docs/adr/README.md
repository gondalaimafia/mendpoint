# Architecture Decision Records

This directory holds Mendpoint's Architecture Decision Records (ADRs). An ADR captures one significant architectural or product-contract decision, the context that forced it, the alternatives that were weighed, and the consequences that follow.

ADRs are authority rank #2 in the source-of-truth hierarchy defined in `docs/agents/OPERATING_PROTOCOL.md` §4, above repository interfaces and task acceptance criteria, and below the canonical product specification. Both coding agents must read the relevant ADRs before authoring a task (OPERATING_PROTOCOL.md §3) and must record an ADR when a change materially affects the areas listed in §6.

## Path convention

- One ADR per file, in this directory: `docs/adr/`.
- File name: `NNNN-short-kebab-title.md`, where `NNNN` is a zero-padded four-digit number.
- `docs/adr/0000-template.md` is the template. Copy it to the next available number to start a new ADR. Never edit `0000-template.md` as if it were a real decision.

## Numbering

- Numbers are assigned sequentially in order of creation and never reused, even if an ADR is later rejected or superseded.
- The next ADR takes the lowest unused four-digit number (the first real ADR is `0001`).
- Numbering reflects creation order, not importance.

## Status lifecycle

Every ADR carries a `Status` field. Allowed values:

- **Proposed** — drafted and under review; not yet binding.
- **Accepted** — approved and binding. Accepted ADRs govern implementation per OPERATING_PROTOCOL.md §4.
- **Rejected** — considered and declined. Kept for the historical record.
- **Superseded by ADR-NNNN** — replaced by a later decision. Link the successor.
- **Deprecated** — no longer applicable, with no direct replacement.

Transitions:

`Proposed → Accepted → (Superseded | Deprecated)` or `Proposed → Rejected`.

Once an ADR is Accepted, do not edit its decision in place. Record a change by writing a new ADR that supersedes it and updating the older ADR's status to `Superseded by ADR-NNNN`.
