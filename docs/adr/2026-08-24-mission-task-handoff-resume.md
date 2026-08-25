# Wire MissionTask into handoff and resume

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

#374 added the shared MissionTask state machine (spec §6.8). Handoff still wrote
only mission exceptions/decisions, and the worker loop compiled inherited context
via `buildMissionContext` without the resume standing (`resolveResumeContext`)
that keeps load failures distinct from "nothing to inherit."

## Decision

1. **Handoff.** `openTaskHandoff` / `resolveTaskHandoff` accept an optional
   `taskId`. When present, they transition the bound MissionTask in the same
   transaction: `agent_working → human_review_required` on open, and
   `human_* → agent_resume` on resolve. Absent `taskId` keeps the record-only
   path. Illegal task states fail closed (`task_handoff_task_not_agent_working` /
   `task_handoff_task_not_human_owned`).
2. **Resume.** The Fettler `agent.run` executor calls `resolveResumeContext`
   (still behind `MENDPOINT_INHERITED_CONTEXT`) so ownership, missing missions,
   and store-load failures never collapse into empty context.
3. **Composability.** `createMissionTask` / `transitionMissionTask` join an
   already-open transaction instead of always `BEGIN IMMEDIATE`.

## Alternatives considered

- **Always require a MissionTask.** Rejected: existing callers write exceptions
  without a task row; forcing one would break the current regenerate path.
- **Drop the inherited-context flag.** Rejected: enabling by default is a
  prompt-surface change and belongs to a separate rollout.

## Security impact

Task transitions remain tenant-scoped and revision-fenced. Resume fail-closed
standings prevent injecting empty context when a claimed mission did not load.

## Data and compatibility impact

No schema change. Optional `taskId` on existing handoff functions.

## Migration plan

1. Transaction-join the task engine.
2. Optional taskId on handoff.
3. Worker loop calls `resolveResumeContext`.

## Rollback

Revert the commit. Handoff is again record-only; the loop compiles via
`buildMissionContext`.

## Evaluation plan

Success is the handoff suite covering task transitions and fail-closed states,
plus the existing resume standing tests. Reconsideration is D3: bridge
`jobs`/`agent_runs` onto a MissionTask so every live run has a taskId.
