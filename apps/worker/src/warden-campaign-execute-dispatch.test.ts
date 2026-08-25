import { describe, expect, it } from "vitest";
import type { AppDb } from "@mendpoint/db";
import {
  WardenCampaignExecutionError,
  type WardenCampaignExecutionDependencies,
} from "@mendpoint/pipeline";
import {
  runWardenCampaignExecuteTarget,
  parseWardenCampaignExecuteJob,
  type WardenCampaignExecuteJob,
  type WardenCampaignExecutor,
} from "./warden-campaign-execute-dispatch.js";

const db = {} as unknown as AppDb;
const dependencies = {} as unknown as WardenCampaignExecutionDependencies;

function validPayload(): Record<string, unknown> {
  return {
    campaignId: "camp-1",
    targetId: "tgt-1",
    rolloutDecisionId: "rd-1",
    actorPrincipalId: "p-1",
    runId: "run-1",
    createdAt: "2026-01-02T00:00:00.000Z",
    source: { sourceArtifactId: "src-1" },
    rolloutApproval: { decisionSha256: "a".repeat(64), approvedByPrincipalId: "p-2", approvedAt: "2026-01-01T00:00:00.000Z" },
    ownerApproval: { ownerPrincipalId: "p-3", ownerHandle: "owner", approvedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function job(payload: unknown): WardenCampaignExecuteJob {
  return { id: "job-1", tenant_id: "t-1", type: "warden.campaign.execute-target", payload_json: JSON.stringify(payload) };
}

describe("parseWardenCampaignExecuteJob", () => {
  it("parses a well-formed payload", () => {
    const parsed = parseWardenCampaignExecuteJob(job(validPayload()));
    expect(parsed.campaignId).toBe("camp-1");
    expect(parsed.rolloutApproval.decisionSha256).toBe("a".repeat(64));
    expect(parsed.ownerApproval.ownerHandle).toBe("owner");
  });

  it("throws on malformed JSON and on a missing field", () => {
    expect(() => parseWardenCampaignExecuteJob({ ...job({}), payload_json: "not json" }))
      .toThrow("warden_campaign_execute_payload_invalid");
    const missing = validPayload();
    delete missing.campaignId;
    expect(() => parseWardenCampaignExecuteJob(job(missing)))
      .toThrow("warden_campaign_execute_payload_campaignId_invalid");
    const badRollout = validPayload();
    (badRollout.rolloutApproval as Record<string, unknown>).decisionSha256 = 123;
    expect(() => parseWardenCampaignExecuteJob(job(badRollout)))
      .toThrow("warden_campaign_execute_payload_decisionSha256_invalid");
  });
});

describe("runWardenCampaignExecuteTarget", () => {
  it("returns executed with the review stage and passes the parsed authority through", async () => {
    let received: Parameters<WardenCampaignExecutor>[0] | null = null;
    const execute = (async (input) => {
      received = input;
      return { stage: "review" } as Awaited<ReturnType<WardenCampaignExecutor>>;
    }) as WardenCampaignExecutor;
    const outcome = await runWardenCampaignExecuteTarget({ db, job: job(validPayload()), resolveDependencies: () => dependencies, execute });
    expect(outcome).toEqual({ status: "executed", stage: "review" });
    expect(received!.tenantId).toBe("t-1");
    expect(received!.campaignId).toBe("camp-1");
    expect(received!.rolloutApproval.approvedByPrincipalId).toBe("p-2");
    expect(received!.dependencies).toBe(dependencies);
  });

  it("parses payload renames and threads them into resolveDependencies", async () => {
    const payload = { ...validPayload(), renames: [{ from: "amount", to: "amount_cents" }] };
    let seen: readonly { from: string; to: string }[] | null = null;
    const execute = (async () => ({ stage: "review" } as Awaited<ReturnType<WardenCampaignExecutor>>)) as WardenCampaignExecutor;
    await runWardenCampaignExecuteTarget({
      db,
      job: job(payload),
      resolveDependencies: (renames) => {
        seen = renames;
        return dependencies;
      },
      execute,
    });
    expect(seen).toEqual([{ from: "amount", to: "amount_cents" }]);
  });

  it("defaults renames to an empty list when the payload omits them", async () => {
    let seen: readonly { from: string; to: string }[] | null = null;
    const execute = (async () => ({ stage: "review" } as Awaited<ReturnType<WardenCampaignExecutor>>)) as WardenCampaignExecutor;
    await runWardenCampaignExecuteTarget({
      db,
      job: job(validPayload()),
      resolveDependencies: (renames) => {
        seen = renames;
        return dependencies;
      },
      execute,
    });
    expect(seen).toEqual([]);
  });

  it("reschedules on a retryable executor error", async () => {
    const execute = (async () => {
      throw new WardenCampaignExecutionError("warden_target_not_ready", true);
    }) as WardenCampaignExecutor;
    const outcome = await runWardenCampaignExecuteTarget({ db, job: job(validPayload()), resolveDependencies: () => dependencies, execute });
    expect(outcome).toEqual({ status: "retry_scheduled", code: "warden_target_not_ready" });
  });

  it("fails terminally on a non-retryable executor error", async () => {
    const execute = (async () => {
      throw new WardenCampaignExecutionError("warden_owner_approval_mismatch", false);
    }) as WardenCampaignExecutor;
    const outcome = await runWardenCampaignExecuteTarget({ db, job: job(validPayload()), resolveDependencies: () => dependencies, execute });
    expect(outcome).toEqual({ status: "failed", code: "warden_owner_approval_mismatch" });
  });

  it("fails closed on a malformed payload without invoking the executor", async () => {
    let called = false;
    const execute = (async () => {
      called = true;
      return { stage: "review" } as Awaited<ReturnType<WardenCampaignExecutor>>;
    }) as WardenCampaignExecutor;
    const outcome = await runWardenCampaignExecuteTarget({
      db, job: { ...job({}), payload_json: "not json" }, resolveDependencies: () => dependencies, execute,
    });
    expect(outcome).toEqual({ status: "failed", code: "warden_campaign_execute_payload_invalid" });
    expect(called).toBe(false);
  });

  it("rethrows an unexpected (non-executor) error for the loop's generic handler", async () => {
    const execute = (async () => {
      throw new Error("kaboom");
    }) as WardenCampaignExecutor;
    await expect(runWardenCampaignExecuteTarget({ db, job: job(validPayload()), resolveDependencies: () => dependencies, execute }))
      .rejects.toThrow("kaboom");
  });
});
