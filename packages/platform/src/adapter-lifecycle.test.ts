import { describe, expect, it } from "vitest";

import {
  AdapterLifecycleError,
  AdapterLifecycleRegistry,
  type AdapterLifecycleBindings,
  type AdapterLifecycleRecord,
  type AdapterLifecycleState,
  type RegisterAdapterInput,
} from "./adapter-lifecycle.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function registration(
  overrides: Partial<RegisterAdapterInput> = {},
): RegisterAdapterInput {
  return {
    tenantId: "tenant-a",
    adapterId: "payments-java-17",
    baseModel: {
      modelId: "base-model-1",
      license: "Apache-2.0",
      evidenceRef: "evidence://licenses/base-model-1",
    },
    artifactDigest: DIGEST_A,
    trainingDataset: {
      datasetId: "dataset-1",
      lineageRefs: ["lineage://dataset-1/source-manifest"],
      consent: {
        status: "granted",
        evidenceRefs: ["consent://tenant-a/dataset-1"],
      },
      sufficiency: {
        representative: true,
        sampleCount: 240,
        minimumSampleCount: 200,
        evidenceRefs: ["eval://dataset-1/representativeness"],
      },
    },
    actorId: "principal:trainer",
    occurredAt: "2026-08-02T07:00:00.000Z",
    evidenceRefs: ["run://training/run-1"],
    ...overrides,
  };
}

function promotionBindings(): AdapterLifecycleBindings {
  return {
    heldOutEvaluation: {
      reportRef: "eval://held-out/report-1",
      passed: true,
      successRate: 0.98,
      regressionRate: 0.005,
    },
    promotionThresholds: {
      minimumSuccessRate: 0.95,
      maximumRegressionRate: 0.01,
    },
    approvedInfrastructure: {
      approved: true,
      marker: "infra-approved:gpu-pool-a",
      evidenceRef: "approval://infra/gpu-pool-a",
    },
    servingRevision: "serving-revision-42",
    monitoringWindow: {
      startsAt: "2026-08-02T08:00:00.000Z",
      endsAt: "2026-08-09T08:00:00.000Z",
    },
    rollbackTarget: {
      servingRevision: "serving-revision-41",
      artifactDigest: DIGEST_B,
    },
    approver: {
      principalId: "principal:release-manager",
      approvedAt: "2026-08-02T07:55:00.000Z",
      evidenceRef: "approval://human/change-42",
    },
    canaryEvidence: {
      passed: true,
      observedAt: "2026-08-02T08:30:00.000Z",
      evidenceRefs: ["canary://serving-revision-42/report"],
    },
  };
}

function moveToCanary(
  registry: AdapterLifecycleRegistry,
  input: RegisterAdapterInput = registration(),
  bindings: Partial<ReturnType<typeof promotionBindings>> = {},
): AdapterLifecycleRecord {
  registry.register(input);
  registry.transition({
    tenantId: input.tenantId,
    adapterId: input.adapterId,
    to: "evaluated",
    actorId: "principal:evaluator",
    occurredAt: "2026-08-02T07:15:00.000Z",
    evidenceRefs: ["eval://held-out/report-1"],
  });
  registry.transition({
    tenantId: input.tenantId,
    adapterId: input.adapterId,
    to: "shadow",
    actorId: "principal:release-manager",
    occurredAt: "2026-08-02T07:30:00.000Z",
    evidenceRefs: ["shadow://serving-revision-42/report"],
  });
  return registry.transition({
    tenantId: input.tenantId,
    adapterId: input.adapterId,
    to: "canary",
    actorId: "principal:release-manager",
    occurredAt: "2026-08-02T08:00:00.000Z",
    evidenceRefs: ["change://canary/42"],
    bindings: { ...promotionBindings(), ...bindings },
  });
}

function expectLifecycleCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected lifecycle operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterLifecycleError);
    expect((error as AdapterLifecycleError).code).toBe(code);
  }
}

describe("AdapterLifecycleRegistry", () => {
  it("copies caller supplied bindings before freezing retained evidence", () => {
    const registry = new AdapterLifecycleRegistry();
    const input = registration();
    const record = registry.register(input);

    expect(() => {
      (input.trainingDataset.lineageRefs as string[]).push("lineage://caller/new");
    }).not.toThrow();
    expect(record.trainingDataset.lineageRefs).toEqual([
      "lineage://dataset-1/source-manifest",
    ]);
  });

  it("closes the registered to retired lifecycle with immutable bound evidence", () => {
    const registry = new AdapterLifecycleRegistry();
    const canary = moveToCanary(registry);

    expect(canary.state).toBe("canary");
    expect(canary.baseModel.license).toBe("Apache-2.0");
    expect(canary.artifactDigest).toBe(DIGEST_A);
    expect(canary.trainingDataset.lineageRefs).toEqual([
      "lineage://dataset-1/source-manifest",
    ]);
    expect(canary.heldOutEvaluation?.reportRef).toBe(
      "eval://held-out/report-1",
    );
    expect(canary.promotionThresholds?.minimumSuccessRate).toBe(0.95);
    expect(canary.servingRevision).toBe("serving-revision-42");
    expect(canary.monitoringWindow?.endsAt).toBe(
      "2026-08-09T08:00:00.000Z",
    );
    expect(canary.rollbackTarget?.servingRevision).toBe("serving-revision-41");
    expect(canary.approver?.principalId).toBe("principal:release-manager");
    expect(canary.canaryEvidence?.evidenceRefs).toEqual([
      "canary://serving-revision-42/report",
    ]);

    const promoted = registry.transition({
      tenantId: "tenant-a",
      adapterId: "payments-java-17",
      to: "promoted",
      actorId: "principal:release-manager",
      occurredAt: "2026-08-02T09:00:00.000Z",
      evidenceRefs: ["decision://promotion/42"],
    });
    expect(promoted.state).toBe("promoted");

    const monitored = registry.transition({
      tenantId: "tenant-a",
      adapterId: "payments-java-17",
      to: "monitored",
      actorId: "principal:operator",
      occurredAt: "2026-08-03T09:00:00.000Z",
      evidenceRefs: ["monitor://serving-revision-42/day-1"],
    });
    expect(monitored.state).toBe("monitored");

    const rolledBack = registry.transition({
      tenantId: "tenant-a",
      adapterId: "payments-java-17",
      to: "rolled_back",
      actorId: "principal:operator",
      occurredAt: "2026-08-03T10:00:00.000Z",
      evidenceRefs: ["incident://serving-revision-42/rollback"],
    });
    expect(rolledBack.state).toBe("rolled_back");

    const retired = registry.transition({
      tenantId: "tenant-a",
      adapterId: "payments-java-17",
      to: "retired",
      actorId: "principal:release-manager",
      occurredAt: "2026-08-03T11:00:00.000Z",
      evidenceRefs: ["decision://retire/42"],
    });
    expect(retired.state).toBe("retired");
    expect(retired.revision).toBe(8);
    expect(retired.history.map((event) => event.to)).toEqual([
      "registered",
      "evaluated",
      "shadow",
      "canary",
      "promoted",
      "monitored",
      "rolled_back",
      "retired",
    ]);

    expectLifecycleCode(
      () =>
        registry.transition({
          tenantId: "tenant-a",
          adapterId: "payments-java-17",
          to: "evaluated",
          actorId: "principal:evaluator",
          occurredAt: "2026-08-03T12:00:00.000Z",
          evidenceRefs: ["eval://retry"],
        }),
      "adapter_lifecycle_terminal",
    );

    expect(() => {
      (retired.history as unknown as Array<unknown>).push({});
    }).toThrow();
  });

  it("isolates adapter identities and listings by tenant", () => {
    const registry = new AdapterLifecycleRegistry();
    registry.register(registration());
    registry.register(
      registration({
        tenantId: "tenant-b",
        artifactDigest: DIGEST_B,
        actorId: "principal:tenant-b-trainer",
      }),
    );

    expect(registry.get("tenant-a", "payments-java-17")?.artifactDigest).toBe(
      DIGEST_A,
    );
    expect(registry.get("tenant-b", "payments-java-17")?.artifactDigest).toBe(
      DIGEST_B,
    );
    expect(registry.list("tenant-a")).toHaveLength(1);
    expect(registry.list("tenant-b")).toHaveLength(1);
    expect(registry.get("tenant-c", "payments-java-17")).toBeUndefined();
    expectLifecycleCode(
      () =>
        registry.transition({
          tenantId: "tenant-c",
          adapterId: "payments-java-17",
          to: "evaluated",
          actorId: "principal:tenant-c",
          occurredAt: "2026-08-02T08:00:00.000Z",
          evidenceRefs: ["eval://tenant-c"],
        }),
      "adapter_lifecycle_not_found",
    );
  });

  it("rejects duplicate registration and skipped or unsafe transitions", () => {
    const registry = new AdapterLifecycleRegistry();
    registry.register(registration());

    expectLifecycleCode(
      () => registry.register(registration()),
      "adapter_lifecycle_conflict",
    );
    expectLifecycleCode(
      () =>
        registry.transition({
          tenantId: "tenant-a",
          adapterId: "payments-java-17",
          to: "canary",
          actorId: "principal:release-manager",
          occurredAt: "2026-08-02T08:00:00.000Z",
          evidenceRefs: ["change://canary/42"],
        }),
      "adapter_lifecycle_transition_denied",
    );
  });

  it.each([
    [
      "consent",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(
          registry,
          registration({
            trainingDataset: {
              ...registration().trainingDataset,
              consent: { status: "missing" as const, evidenceRefs: [] },
            },
          }),
        ),
      "adapter_promotion_consent_required",
    ],
    [
      "representative data",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(
          registry,
          registration({
            trainingDataset: {
              ...registration().trainingDataset,
              sufficiency: {
                ...registration().trainingDataset.sufficiency,
                representative: false,
              },
            },
          }),
        ),
      "adapter_promotion_representative_data_required",
    ],
    [
      "approved infrastructure",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(registry, registration(), {
        approvedInfrastructure: {
          approved: false,
          marker: "infra-pending:gpu-pool-a",
          evidenceRef: "approval://infra/pending",
        },
        }),
      "adapter_promotion_infrastructure_approval_required",
    ],
    [
      "passing held out evaluation",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(registry, registration(), {
        heldOutEvaluation: {
          reportRef: "eval://held-out/report-1",
          passed: false,
          successRate: 0.98,
          regressionRate: 0.005,
        },
        }),
      "adapter_promotion_evaluation_failed",
    ],
    [
      "human approval",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(registry, registration(), { approver: undefined }),
      "adapter_promotion_human_approval_required",
    ],
    [
      "canary evidence",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(registry, registration(), {
        canaryEvidence: {
          passed: false,
          observedAt: "2026-08-02T08:30:00.000Z",
          evidenceRefs: ["canary://serving-revision-42/failed"],
        },
        }),
      "adapter_promotion_canary_evidence_required",
    ],
    [
      "serving revision",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(registry, registration(), { servingRevision: undefined }),
      "adapter_promotion_serving_revision_required",
    ],
    [
      "monitoring window",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(registry, registration(), { monitoringWindow: undefined }),
      "adapter_promotion_monitoring_window_required",
    ],
    [
      "rollback target",
      (registry: AdapterLifecycleRegistry) =>
        moveToCanary(registry, registration(), { rollbackTarget: undefined }),
      "adapter_promotion_rollback_target_required",
    ],
  ])("fails promotion closed without %s", (_name, arrange, expectedCode) => {
    const registry = new AdapterLifecycleRegistry();
    arrange(registry);

    expectLifecycleCode(
      () =>
        registry.transition({
          tenantId: "tenant-a",
          adapterId: "payments-java-17",
          to: "promoted",
          actorId: "principal:release-manager",
          occurredAt: "2026-08-02T09:00:00.000Z",
          evidenceRefs: ["decision://promotion/42"],
        }),
      expectedCode,
    );
    const unchanged = registry.get("tenant-a", "payments-java-17")!;
    expect(unchanged.state).toBe("canary");
    expect(unchanged.revision).toBe(4);
    expect(unchanged.evidenceRefs).not.toContain("decision://promotion/42");
  });

  it("enforces the recorded thresholds rather than trusting a pass flag", () => {
    const registry = new AdapterLifecycleRegistry();
    const passingEvaluation = promotionBindings().heldOutEvaluation!;
    moveToCanary(registry, registration(), {
      heldOutEvaluation: {
        ...passingEvaluation,
        successRate: 0.94,
      },
    });

    expectLifecycleCode(
      () =>
        registry.transition({
          tenantId: "tenant-a",
          adapterId: "payments-java-17",
          to: "promoted",
          actorId: "principal:release-manager",
          occurredAt: "2026-08-02T09:00:00.000Z",
          evidenceRefs: ["decision://promotion/42"],
        }),
      "adapter_promotion_threshold_not_met",
    );
  });

  it("rejects malformed artifact, evidence, dataset, and time bindings", () => {
    const registry = new AdapterLifecycleRegistry();
    expectLifecycleCode(
      () => registry.register(registration({ artifactDigest: "latest" })),
      "adapter_lifecycle_artifact_digest_invalid",
    );
    expectLifecycleCode(
      () => registry.register(registration({ evidenceRefs: [] })),
      "adapter_lifecycle_evidence_required",
    );
    expectLifecycleCode(
      () =>
        registry.register(
          registration({
            trainingDataset: {
              ...registration().trainingDataset,
              lineageRefs: [],
            },
          }),
        ),
      "adapter_lifecycle_dataset_lineage_required",
    );
    expectLifecycleCode(
      () => registry.register(registration({ occurredAt: "not-a-time" })),
      "adapter_lifecycle_time_invalid",
    );
  });

  it("supports deliberate retirement of inactive candidates but requires rollback for active ones", () => {
    const inactiveStates: AdapterLifecycleState[] = [
      "registered",
      "evaluated",
      "shadow",
    ];

    for (const state of inactiveStates) {
      const registry = new AdapterLifecycleRegistry();
      registry.register(registration({ adapterId: `adapter-${state}` }));
      if (state !== "registered") {
        registry.transition({
          tenantId: "tenant-a",
          adapterId: `adapter-${state}`,
          to: "evaluated",
          actorId: "principal:evaluator",
          occurredAt: "2026-08-02T07:15:00.000Z",
          evidenceRefs: ["eval://candidate"],
        });
      }
      if (state === "shadow") {
        registry.transition({
          tenantId: "tenant-a",
          adapterId: `adapter-${state}`,
          to: "shadow",
          actorId: "principal:release-manager",
          occurredAt: "2026-08-02T07:30:00.000Z",
          evidenceRefs: ["shadow://candidate"],
        });
      }
      expect(
        registry.transition({
          tenantId: "tenant-a",
          adapterId: `adapter-${state}`,
          to: "retired",
          actorId: "principal:release-manager",
          occurredAt: "2026-08-02T10:00:00.000Z",
          evidenceRefs: ["decision://retire/candidate"],
        }).state,
      ).toBe("retired");
    }

    const active = new AdapterLifecycleRegistry();
    moveToCanary(active);
    expectLifecycleCode(
      () =>
        active.transition({
          tenantId: "tenant-a",
          adapterId: "payments-java-17",
          to: "retired",
          actorId: "principal:release-manager",
          occurredAt: "2026-08-02T10:00:00.000Z",
          evidenceRefs: ["decision://retire/active"],
        }),
      "adapter_lifecycle_transition_denied",
    );
  });
});
