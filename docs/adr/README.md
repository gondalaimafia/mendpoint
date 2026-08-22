# Architecture Decision Records

This directory holds Mendpoint's Architecture Decision Records (ADRs). An ADR captures one significant architectural or product-contract decision, the context that forced it, the alternatives that were weighed, and the consequences that follow.

ADRs are authority rank #2 in the source-of-truth hierarchy defined in `docs/agents/OPERATING_PROTOCOL.md` §4, above repository interfaces and task acceptance criteria, and below the canonical product specification. Both coding agents must read the relevant ADRs before authoring a task (OPERATING_PROTOCOL.md §3) and must record an ADR when a change materially affects the areas listed in §6.

## Path convention

- One ADR per file, in this directory: `docs/adr/`.
- File name for a **new** ADR: `YYYY-MM-DD-short-kebab-title.md`, where `YYYY-MM-DD` is the date the ADR is authored and the title is a short kebab-case summary (for example `2026-08-22-change-graph-authority.md`).
- `docs/adr/0000-template.md` is the template. Copy it to `<today>-<your-title>.md` to start a new ADR. Never edit `0000-template.md` as if it were a real decision.

## Numbering

Sequential four-digit numbering (`NNNN-short-kebab-title.md`) was the original scheme. Under parallel authorship it produced repeated collisions: two agents each correctly computed "the next free number is N" at the same time and both wrote `NNNN`. Because the two files had different titles, git kept both, and one silently lost every cross-reference pointing at `ADR-NNNN`. The number was derived from shared repository state, so "pick the next free number" was a race both authors could win.

New ADRs are identified by **authoring date plus title** instead:

- The identifier is the whole filename, `YYYY-MM-DD-short-kebab-title.md`. It is derived from the author's own date and chosen title, not from a scan of the sibling files, so two authors never read and increment the same counter.
- A genuine collision would require two files with the identical date **and** title — that is, two identical paths, which git cannot represent. The second author gets a path conflict to resolve rather than a silent overwrite, so collisions cannot merge silently.
- Cross-references to a new ADR use its full identifier (for example "superseded by ADR `2026-08-22-change-graph-authority`").

The existing sequential ADRs `0000`–`0013` are **grandfathered**: they keep their numbers and are never renumbered, because those numbers are referenced from code comments, PR bodies, and `tasks/todo.md`. The sequential range is closed at `0013` — no new four-digit ADR may be added, which is what removes the racing scheme.

`npm run adr:check` (part of `ga:check`) enforces this: every ADR must match either the dated scheme or a grandfathered sequential number at or below the boundary, dated ADRs must carry a real calendar date, and no two ADRs may claim the same identifier. The boundary lives in `scripts/adr-numbering-check.ts` as `LAST_SEQUENTIAL_ADR`.

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
