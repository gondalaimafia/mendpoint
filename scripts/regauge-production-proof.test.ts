import { describe, expect, it, vi } from "vitest";
import {
  observeRegaugeDraftCanary,
  observeRegaugeVerifierEvidence,
  runRegaugeReadinessSoak,
} from "./regauge-production-proof.js";

describe("Regauge production proof", () => {
  it("accepts only an exact tenant and campaign draft observation from GitHub", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: [{
        draft: {
          tenantId: "tenant-a",
          campaignId: "campaign-a",
          unitId: "unit-a",
          wave: 1,
          deliveryId: "delivery-a",
          pullRequestNumber: 17,
          pullRequestUrl: "https://github.com/acme/repo/pull/17",
          commitSha: "a".repeat(40),
          evidenceRefs: ["github:draft:17"],
        },
        target: { owner: "acme", repo: "repo" },
      }],
      serverTime: "2026-08-14T12:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const evidence = await observeRegaugeDraftCanary({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedOwner: "acme",
      expectedRepository: "repo",
      fetchImpl,
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      pullRequests: [{ number: 17, url: "https://github.com/acme/repo/pull/17" }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mendpoint-regauge-production.fly.dev/v1/regauge/attempt-coordinator/draft-observations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed on empty, foreign, or non GitHub draft evidence", async () => {
    const response = (result: unknown) => vi.fn(async () => new Response(
      JSON.stringify({ result, serverTime: "2026-08-14T12:00:00.000Z" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const input = {
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedOwner: "acme",
      expectedRepository: "repo",
    };
    await expect(observeRegaugeDraftCanary({ ...input, fetchImpl: response([]) }))
      .rejects.toThrow("regauge_production_draft_canary_missing");
    await expect(observeRegaugeDraftCanary({
      ...input,
      fetchImpl: response([{ draft: { tenantId: "tenant-b" }, target: {} }]),
    })).rejects.toThrow("regauge_production_draft_canary_invalid");
    await expect(observeRegaugeDraftCanary({
      ...input,
      expectedRepository: "other",
      fetchImpl: response([{
        draft: {
          tenantId: "tenant-a", campaignId: "campaign-a", unitId: "unit-a",
          pullRequestNumber: 17, pullRequestUrl: "https://github.com/acme/repo/pull/17",
          commitSha: "a".repeat(40), evidenceRefs: ["github:draft:17"],
        },
        target: { owner: "acme", repo: "repo" },
      }]),
    })).rejects.toThrow("regauge_production_draft_canary_invalid");
  });

  it("requires exact durable DeepSeek advisory provider evidence", async () => {
    const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: [{
        telemetryDigest: digest("a"), evidencePackDigest: digest("b"),
        provider: "deepseek", model: "deepseek-v4-flash", backendRevision: "deepseek-v4-flash-2026-08-24",
        observedAt: "2026-08-24T12:05:00.000Z", totalTokens: 44, estimatedCostUsd: 0.001,
        latencyMs: 320, scoreEvidenceDigests: [digest("c")], advisoryOnly: true, behaviorChanged: false,
      }],
      serverTime: "2026-08-24T12:05:01.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await observeRegaugeVerifierEvidence({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      fetchImpl,
    });
    expect(result.observation).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", advisoryOnly: true, behaviorChanged: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mendpoint-regauge-production.fly.dev/v1/regauge/attempt-coordinator/verifier-observations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("runs a bounded read only readiness soak against the exact deployment revision", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith("/version")
        ? { revision: "a".repeat(40) }
        : { status: "ok", checks: [{ name: "env", ok: true }] },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    const report = await runRegaugeReadinessSoak({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      expectedRevision: "a".repeat(40),
      durationSeconds: 3,
      intervalSeconds: 1,
      fetchImpl,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    expect(report).toMatchObject({ status: "completed", passed: true, samples: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({ method: "GET" });
    }
  });

  it("fails the soak when readiness or immutable revision drifts", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith("/version")
        ? { revision: "b".repeat(40) }
        : { status: "degraded", checks: [{ name: "storage", ok: false }] },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    const report = await runRegaugeReadinessSoak({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      expectedRevision: "a".repeat(40),
      durationSeconds: 1,
      intervalSeconds: 1,
      fetchImpl,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    expect(report).toMatchObject({ status: "failed", passed: false, samples: 1, failures: 1 });
  });
});
