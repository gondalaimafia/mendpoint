# Deployment and operations

Run Mendpoint with role-specific readiness, durable state, recovery controls, audit evidence, backups, and bounded rollout procedures.

Status: Pilot evaluation
Availability: Docker Compose and Fly pilot deployment; the dedicated Regauge profile is implemented but no live Regauge deployment is claimed
Last verified: 2026-08-14

## Start here

Choose the Fettler, Regauge pilot, demo, or self-hosted profile and satisfy its complete startup contract before deployment.

1. Validate the exact configuration and secret names without exposing values.
2. Build and boot the production image against an existing-state database.
3. Deploy one canary instance and verify liveness, readiness, storage, integrations, and rollback.
4. Scale only after crash, response-loss, stale-fence, and restore drills pass.

## What it does

- Docker multi-stage images for API, web, worker, all-in-one Fly, and dedicated Regauge roles
- Fly Fettler production and dedicated Regauge coordinator/worker manifests
- Liveness, readiness, worker heartbeat, alerts, metrics, trajectories, and recovery summary
- Encrypted backup, restore, backup fencing, snapshots, disaster-recovery drill, and image rollback
- Lease-fenced jobs and checkpointed Fettler and Regauge execution

## When to use it

- An operator is preparing a new pilot environment.
- A release changes persistence, jobs, external effects, or readiness.
- A worker or process must be replaced without duplicating work.

## How it works

1. Profile validation turns configuration into an explicit authority contract.
2. Durable coordinators own leases and state; workers operate only under current fences.
3. Health endpoints separate process liveness from dependency readiness.
4. Deployments proceed through tests, production build, container smoke, canary, live checks, and recorded rollback.
5. Backups and terminal evidence retain recovery and audit authority.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| npm run ga:check | Command | Run specification, claim, action-pin, and GA checks. |
| npm run e2e:deployment | Command | Run the production deployment journey and crash recovery. |
| npm run dr:drill | Command | Exercise disaster recovery. |
| GET /live | API | API process liveness. |
| GET /ready | API | API dependency readiness. |
| GET /health | API | Detailed runtime health. |
| fly.transformer.toml | Configuration | Separate coordinator and stateless worker production pilot. |

## Evidence and verification

- Deployment E2E: `tests/e2e/deployment.spec.ts`
- Readiness: `packages/ops/src/readiness.test.ts`
- Backup and restore: `packages/ops/src/disaster-recovery.test.ts`
- Regauge profile contract: `apps/worker/src/transformer-production-profile.test.ts`

## Safety model

- A release is not complete until exact commit, image, health, and rollback evidence agree.
- Schema changes must boot against both fresh and pre-change databases.
- Coordinator and worker identities, storage, and fences must remain distinct across scale-out.
- Stopping workers preserves coordinator, volume, and immutable artifacts for evidence.

## Limitations

- Optional model and source control integrations can create network egress
- High availability and enterprise support are not included
- The hosted Fettler profile is a single Fly application, not a multi-region high-availability control plane.
- No dedicated Regauge deployment is claimed live until its app, secrets, volume, health, and canary evidence are independently verified.

## See also

- [Security and governance](./security-governance.md)
- [Billing and usage](./billing-usage.md)
- [Fettler — the first AI API Engineer](./fettler.md)
- [Regauge — the first AI Legacy Engineer](./regauge.md)
