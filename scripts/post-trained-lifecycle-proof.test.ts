import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executePostTrainedLifecycleProof,
  postTrainedLifecycleProofInputDigest,
  persistPostTrainedLifecycleProof,
  POST_TRAINED_PROOF_VERSION,
  runPostTrainedLifecycleProofCli,
  type PostTrainedLifecycleProofInput,
} from "./post-trained-lifecycle-proof.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PROOF_SIGNING_KEY = Buffer.alloc(32, 7).toString("base64");
const PROOF_SIGNING_KEY_ID = "adapter-proof-test-key";
const roots: string[] = [];

function proofDependencies(fetch: typeof globalThis.fetch, apiKey = "secret") {
  return {
    apiKey,
    apiBaseUrl: "https://mendpoint.example/",
    proofSigningKeyBase64: PROOF_SIGNING_KEY,
    proofSigningKeyId: PROOF_SIGNING_KEY_ID,
    fetch,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).filter((name) => item[name] !== undefined).sort()
    .map((name) => `${JSON.stringify(name)}:${canonicalJson(item[name])}`).join(",")}}`;
}

function proofInput(): PostTrainedLifecycleProofInput {
  return {
    version: POST_TRAINED_PROOF_VERSION,
    apiBaseUrl: "https://mendpoint.example/",
    timeoutMs: 1_000,
    training: { idempotencyKey: "train-1", body: {
      jobId: "job-1", adapterId: "adapter-1", baseModelId: "base-1", datasetId: "dataset-1",
      purpose: "adapter_training", residencyRegion: "us", trainingCorpusArtifactIds: ["corpus-1"],
      validationArtifactId: "validation-1", holdoutArtifactId: "holdout-1",
      splitManifestDigest: `sha256:${"b".repeat(64)}`, recipe: { epochs: 1, maximumExamples: 10, seed: 7 },
    } },
    evaluation: { idempotencyKey: "evaluate-1", body: {
      evaluationId: "evaluation-1", trainingJobId: "job-1", adapterId: "adapter-1",
      baseline: { executorId: "baseline", revision: "c".repeat(40) },
      evaluator: { harnessVersion: "harness-1", graderVersion: "grader-1" },
      policy: { minimumSuccessRate: 0.9, maximumRegressionRate: 0.02, maximumSecurityRegressions: 0 },
    } },
    canary: { idempotencyKey: "canary-1", body: {
      canaryId: "canary-1", trainingJobId: "job-1", evaluationId: "evaluation-1", adapterId: "adapter-1",
    } },
    registration: { idempotencyKey: "register-1", body: {
      adapterId: "adapter-1", trainingJobId: "job-1",
      lifecycle: {
        tenantId: "tenant-1", adapterId: "adapter-1", state: "monitored", revision: 7,
        baseModel: { modelId: "base-1", license: "commercial", evidenceRef: "evidence://base" },
        artifactDigest: DIGEST,
        trainingDataset: { datasetId: "dataset-1", lineageRefs: ["lineage://1"],
          consent: { status: "granted", evidenceRefs: ["consent://train"] },
          sufficiency: { representative: true, sampleCount: 1000, minimumSampleCount: 500, evidenceRefs: ["eval://data"] } },
        heldOutEvaluation: { reportRef: "placeholder", passed: true, successRate: 0.96, regressionRate: 0.01 },
        promotionThresholds: { minimumSuccessRate: 0.9, maximumRegressionRate: 0.02 },
        approvedInfrastructure: { approved: true, marker: "gpu-a", evidenceRef: "infra://approved" },
        servingRevision: "serve-7",
        monitoringWindow: { startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z" },
        rollbackTarget: { servingRevision: "serve-6", artifactDigest: `sha256:${"d".repeat(64)}` },
        approver: { principalId: "human-1", approvedAt: "2026-08-01T00:00:00.000Z", evidenceRef: "approval://1" },
        canaryEvidence: { passed: true, observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["placeholder"] },
        evidenceRefs: ["lifecycle://7"], history: [],
      },
      consent: { tenantId: "tenant-1", datasetId: "dataset-1", revision: 1,
        status: "active", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z",
        evidenceRefs: ["consent://serving"] },
      descriptor: {
        executorId: "adapter-1", providerId: "tenant-private", kind: "adapter", version: "serve-7",
        deployment: "internal", capabilities: ["migration"], tools: ["repo-read"], regions: ["us"],
        price: { version: "p1", currency: "USD", effectiveAt: "2026-08-01T00:00:00.000Z" },
        limits: { maximumInputTokens: 4_000, maximumOutputTokens: 2_000, maximumConcurrentTasks: 1 },
        health: { status: "healthy", checkedAt: "2026-08-01T00:00:00.000Z", evidenceRef: "health://1" },
        license: { id: "commercial", commercialUse: true, redistribution: "restricted" },
        maximumDataClassification: "internal", maximumRisk: "low", qualityScore: 0.95,
        estimatedLatencyMs: 1_000, estimatedCostUsd: 0.2,
      },
    } },
    eligibility: { body: { task: {
      taskId: "task-1", tenantId: "tenant-1", kind: "migration", goal: "Verify adapter eligibility",
      idempotencyKey: "task-1", inputArtifactIds: [], requiredCapabilities: ["migration"], allowedTools: ["repo-read"],
      context: { estimatedInputTokens: 100, maximumOutputTokens: 100 },
      verification: { requiredChecks: [], requireAll: true, onFailure: "human_handoff" },
      fallbackPolicy: { enabled: false, maxAttempts: 1, sameExecutorRetries: 0, retryableFailures: [], fallbackFailures: [] },
      privacy: { classification: "internal", requiredRegion: "us" }, risk: "low",
      quality: { minimumScore: 0.9 }, latency: { maximumMs: 5_000 }, budget: { maximumUsd: 1 },
    } } },
    rollback: { idempotencyKey: "rollback-1", reason: "Bounded lifecycle rollback drill" },
  };
}

function successfulBodies(): Record<string, unknown>[] {
  const input = proofInput();
  const rollbackRequest = { expectedArtifactDigest: DIGEST, reason: input.rollback.reason, idempotencyKey: input.rollback.idempotencyKey };
  const sha = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
  return [
    { tenantId: "tenant-1", jobId: "job-1", adapterId: "adapter-1", status: "completed", adapterDigest: DIGEST },
    { tenantId: "tenant-1", evaluationId: "evaluation-1", trainingJobId: "job-1", adapterId: "adapter-1", status: "passed",
      reportArtifactId: "evaluation-artifact", successRate: 0.96, regressionRate: 0.01, overlapCount: 0 },
    { tenantId: "tenant-1", canaryId: "canary-1", adapterId: "adapter-1", status: "passed", servingRevision: "serve-7",
      observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["canary://passed"] },
    { tenantId: "tenant-1", adapterId: "adapter-1", trainingJobId: "job-1", lifecycle: {
      state: "monitored", revision: 7, artifactDigest: DIGEST, servingRevision: "serve-7",
      heldOutEvaluation: { reportRef: "evaluation-artifact", passed: true, successRate: 0.96, regressionRate: 0.01 },
      canaryEvidence: { passed: true, observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["canary://passed"] },
    } },
    { adapterId: "adapter-1", eligible: true, inputDigest: inputDigest(input), eligibilityRequestDigest: sha(input.eligibility.body), rollbackRequestDigest: sha(rollbackRequest), eligibilityObservationDigest: `sha256:${"e".repeat(64)}`, eventId: "event-proof", eventHash: "f".repeat(64), eventSequence: 5, observedAt: "2026-08-01T00:00:00.000Z" },
    { tenantId: "tenant-1", adapterId: "adapter-1", lifecycle: { state: "rolled_back", revision: 8, artifactDigest: DIGEST } },
    { adapterId: "adapter-1", eligible: false, reason: "lifecycle_not_servable" },
  ];
}

function inputDigest(input = proofInput()): string { return postTrainedLifecycleProofInputDigest(input); }

function transport(bodies = successfulBodies()) {
  let index = 0;
  return vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(JSON.stringify(bodies[index++]!), {
    status: 200, headers: { "content-type": "application/json" },
  }));
}

function fixture(value: unknown = proofInput()) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-adapter-lifecycle-proof-"));
  roots.push(root);
  const inputPath = join(root, "input.json");
  const outputPath = join(root, "report.json");
  writeFileSync(inputPath, `${JSON.stringify(value)}\n`);
  return { root, inputPath, outputPath };
}

afterEach(() => {
  vi.useRealTimers();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("post-trained adapter lifecycle production proof", () => {
  it("runs the exact lifecycle and publishes a credential-free bound report", async () => {
    const item = fixture();
    const fetch = transport();
    const report = await persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(fetch, "top-secret"));
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(fetch.mock.calls.every((call) => (call[1] as RequestInit).headers &&
      ((call[1] as RequestInit).headers as Record<string, string>).authorization === "Bearer top-secret")).toBe(true);
    expect(fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("idempotency-key")))
      .toEqual(["train-1", "evaluate-1", "canary-1", "register-1", "rollback-1", "rollback-1", null]);
    expect(report).toMatchObject({ adapterId: "adapter-1", eligibleBeforeRollback: true,
      rolledBack: true, eligibleAfterRollback: false, rollbackReason: "lifecycle_not_servable" });
    const output = readFileSync(item.outputPath, "utf8");
    expect(output).not.toContain("top-secret");
    expect(output).not.toContain(PROOF_SIGNING_KEY);
    expect(JSON.parse(output).proofDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("replays an exact retained report without repeating provider work", async () => {
    const item = fixture();
    await persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(transport()));
    const fetch = transport();
    const replay = await persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(replay.rolledBack).toBe(true);
  });

  it.each(["https://attacker.example/", "https://127.0.0.1/"])(
    "refuses an artifact-controlled API destination %s before sending the protected credential",
    async (apiBaseUrl) => {
      const item = fixture({ ...proofInput(), apiBaseUrl });
      const fetch = transport();
      await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(fetch)))
        .rejects.toThrow("post_trained_api_url_untrusted");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a locally recomputed digest that lacks the protected evidence authentication", async () => {
    const item = fixture();
    await persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(transport()));
    const retained = JSON.parse(readFileSync(item.outputPath, "utf8")) as Record<string, unknown>;
    retained.adapterId = "forged-adapter";
    const { proofDigest: ignored, proofMac: ignoredMac, ...body } = retained;
    void ignored;
    void ignoredMac;
    retained.proofDigest = `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
    writeFileSync(item.outputPath, JSON.stringify(retained));
    const fetch = transport();
    await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(fetch)))
      .rejects.toThrow("post_trained_output_conflict");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses exact server reconciliation keys after an interrupted run", async () => {
    const item = fixture();
    const firstBodies = successfulBodies();
    let firstIndex = 0;
    const interrupted = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (firstIndex === 1) throw new Error("connection_lost");
      return new Response(JSON.stringify(firstBodies[firstIndex++]!), { headers: { "content-type": "application/json" } });
    });
    await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath,
      proofDependencies(interrupted))).rejects.toThrow("post_trained_request_failed");
    expect(existsSync(item.outputPath)).toBe(false);

    const resumed = transport();
    await persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(resumed));
    expect(new Headers(interrupted.mock.calls[0]![1]?.headers).get("idempotency-key")).toBe("train-1");
    expect(new Headers(resumed.mock.calls[0]![1]?.headers).get("idempotency-key")).toBe("train-1");
  });

  it.each([5, 6])("resumes the exact already-rolled-back lifecycle after response loss at stage %i", async (lostStage) => {
    const item = fixture();
    const firstBodies = successfulBodies();
    let firstIndex = 0;
    const interrupted = vi.fn(async () => {
      const index = firstIndex++;
      if (index === lostStage) throw new Error("connection_lost");
      return new Response(JSON.stringify(firstBodies[index]!), { headers: { "content-type": "application/json" } });
    });
    await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(interrupted)))
      .rejects.toThrow("post_trained_request_failed");

    const bodies = successfulBodies();
    const registered = bodies[3] as { lifecycle: Record<string, unknown> };
    const resumedBodies = [bodies[0], bodies[1], bodies[2], {
      ...registered,
      lifecycle: { ...registered.lifecycle, state: "rolled_back", revision: 8 },
    }, bodies[4], bodies[5], bodies[6]] as Record<string, unknown>[];
    const resumed = transport(resumedBodies);
    const report = await persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(resumed));
    expect(report).toMatchObject({ lifecycleRevision: 7, rollbackLifecycleRevision: 8, rolledBack: true });
    expect(resumed).toHaveBeenCalledTimes(7);
    expect(new Headers(resumed.mock.calls[4]![1]?.headers).get("idempotency-key")).toBe("rollback-1");
  });

  it("refuses changed input and tampered retained evidence", async () => {
    const item = fixture();
    await persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(transport()));
    writeFileSync(item.inputPath, `${JSON.stringify({ ...proofInput(), timeoutMs: 2_000 })}\n`);
    await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath,
      proofDependencies(transport()))).rejects.toThrow("post_trained_output_conflict");

    writeFileSync(item.inputPath, `${JSON.stringify(proofInput())}\n`);
    const retained = JSON.parse(readFileSync(item.outputPath, "utf8"));
    retained.adapterId = "substituted";
    writeFileSync(item.outputPath, JSON.stringify(retained));
    await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath,
      proofDependencies(transport()))).rejects.toThrow("post_trained_output_conflict");
  });

  it.each([
    [0, { jobId: "other" }, "post_trained_stage_binding_mismatch", 1],
    [1, { status: "failed" }, "post_trained_evaluation_not_passed", 2],
    [2, { status: "failed" }, "post_trained_canary_not_passed", 3],
    [3, { lifecycle: { state: "monitored", revision: 7, artifactDigest: `sha256:${"f".repeat(64)}` } }, "post_trained_stage_binding_mismatch", 4],
    [4, { eligible: false }, "post_trained_adapter_not_eligible", 5],
    [5, { lifecycle: { state: "monitored", revision: 8, artifactDigest: DIGEST } }, "post_trained_rollback_not_applied", 6],
    [5, { lifecycle: { state: "rolled_back", revision: 7, artifactDigest: DIGEST } }, "post_trained_rollback_revision_invalid", 6],
    [6, { eligible: true, reason: "allowed" }, "post_trained_rollback_not_enforced", 7],
  ])("fails closed at stage %i and does not execute later work", async (stage, patch, code, calls) => {
    const bodies = successfulBodies();
    bodies[stage] = { ...bodies[stage], ...patch };
    const fetch = transport(bodies);
    await expect(executePostTrainedLifecycleProof(proofInput(), inputDigest(), proofDependencies(fetch)))
      .rejects.toThrow(code as string);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("rejects credential material in the evidence input before network access", async () => {
    const input = proofInput();
    const item = fixture({ ...input, training: { ...input.training, body: { ...input.training.body, apiKey: "forbidden" } } });
    const fetch = transport();
    await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(fetch)))
      .rejects.toThrow("post_trained_input_contains_credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["accessToken", "client_secret", "privateKey", "authorizationHeader", "github_token"])(
    "rejects normalized compound secret field %s before network access",
    async (field) => {
      const input = proofInput();
      const item = fixture({ ...input, training: { ...input.training, body: { ...input.training.body, [field]: "forbidden" } } });
      const fetch = transport();
      await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(fetch)))
        .rejects.toThrow("post_trained_input_contains_credentials");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["token", "secret"])("rejects bare normalized credential field %s before network access", async (field) => {
    const input = proofInput();
    const task = input.eligibility.body.task as Record<string, unknown>;
    const item = fixture({ ...input, eligibility: { body: { task: { ...task, inputArtifactIds: [{ [field]: "forbidden" }] } } } });
    const fetch = transport();
    await expect(persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(fetch)))
      .rejects.toThrow("post_trained_input_contains_credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong version", { version: "wrong" }, "post_trained_version_invalid"],
    ["out of range timeout", { timeoutMs: 0 }, "post_trained_timeout_invalid"],
    ["invalid idempotency", { training: { ...proofInput().training, idempotencyKey: "bad\nkey" } }, "post_trained_idempotency_invalid"],
    ["invalid rollback reason", { rollback: { ...proofInput().rollback, reason: "bad\nreason" } }, "post_trained_rollback_reason_invalid"],
  ])("validates %s on the exported path before network access", async (_name, patch, code) => {
    const invalid = { ...proofInput(), ...patch } as PostTrainedLifecycleProofInput;
    const fetch = transport();
    await expect(executePostTrainedLifecycleProof(invalid, inputDigest(), proofDependencies(fetch))).rejects.toThrow(code as string);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects every invalid nested array element and a substituted input digest before network access", async () => {
    const input = proofInput();
    const invalid = { ...input, training: { ...input.training, body: { ...input.training.body, trainingCorpusArtifactIds: ["corpus-1", 7] } } } as unknown as PostTrainedLifecycleProofInput;
    const fetch = transport();
    await expect(executePostTrainedLifecycleProof(invalid, inputDigest(), proofDependencies(fetch))).rejects.toThrow("post_trained_stage_schema_invalid");
    await expect(executePostTrainedLifecycleProof(input, `sha256:${"0".repeat(64)}`, proofDependencies(fetch))).rejects.toThrow("post_trained_input_digest_mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when an already rolled-back registration has no authenticated eligibility checkpoint", async () => {
    const bodies = successfulBodies();
    const registered = bodies[3] as { lifecycle: Record<string, unknown> };
    bodies[3] = { ...registered, lifecycle: { ...registered.lifecycle, state: "rolled_back", revision: 8 } };
    bodies[4] = { error: "post_trained_adapter_not_eligible" };
    let index = 0;
    const fetch = vi.fn(async () => new Response(JSON.stringify(bodies[index]!), { status: index++ === 4 ? 409 : 200, headers: { "content-type": "application/json" } }));
    await expect(executePostTrainedLifecycleProof(proofInput(), inputDigest(), proofDependencies(fetch)))
      .rejects.toThrow("post_trained_http_409:post_trained_adapter_not_eligible");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("applies the same closed credential schema to direct programmatic execution", async () => {
    const input = proofInput();
    const fetch = transport();
    await expect(executePostTrainedLifecycleProof({
      ...input,
      registration: { ...input.registration, body: { ...input.registration.body, clientSecret: "forbidden" } },
    }, inputDigest(input), proofDependencies(fetch))).rejects.toThrow("post_trained_input_contains_credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("converges concurrent identical create-only publication on the same authenticated report", async () => {
    const item = fixture();
    let finalArrivals = 0;
    let releaseFinal!: () => void;
    const finalBarrier = new Promise<void>((resolve) => { releaseFinal = resolve; });
    const synchronizedTransport = () => {
      const bodies = successfulBodies();
      let index = 0;
      return vi.fn(async () => {
        const current = index++;
        if (current === 6) {
          finalArrivals += 1;
          if (finalArrivals === 2) releaseFinal();
          await finalBarrier;
        }
        return new Response(JSON.stringify(bodies[current]!), { headers: { "content-type": "application/json" } });
      });
    };
    const [first, second] = await Promise.all([
      persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(synchronizedTransport())),
      persistPostTrainedLifecycleProof(item.inputPath, item.outputPath, proofDependencies(synchronizedTransport())),
    ]);
    expect(second).toEqual(first);
    expect(JSON.parse(readFileSync(item.outputPath, "utf8"))).toEqual(first);
  });

  it.each([0, 1, 2, 3, 5])("rejects cross-tenant stage evidence at response %i", async (stage) => {
    const bodies = successfulBodies();
    bodies[stage] = { ...bodies[stage], tenantId: "tenant-other" };
    const fetch = transport(bodies);
    await expect(executePostTrainedLifecycleProof(proofInput(), inputDigest(), proofDependencies(fetch)))
      .rejects.toThrow("post_trained_stage_binding_mismatch");
    expect(fetch).toHaveBeenCalledTimes(stage + 1);
  });

  it("rejects a cross-tenant eligibility request before network access", async () => {
    const input = proofInput();
    const fetch = transport();
    await expect(executePostTrainedLifecycleProof({ ...input,
      eligibility: { body: { task: { ...(input.eligibility.body.task as Record<string, unknown>), tenantId: "tenant-other" } } },
    }, inputDigest({ ...input, eligibility: { body: { task: { ...(input.eligibility.body.task as Record<string, unknown>), tenantId: "tenant-other" } } } }), proofDependencies(fetch))).rejects.toThrow("post_trained_stage_binding_mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses external plaintext HTTP and redirects", async () => {
    await expect(executePostTrainedLifecycleProof({ ...proofInput(), apiBaseUrl: "http://mendpoint.example" },
      inputDigest({ ...proofInput(), apiBaseUrl: "http://mendpoint.example" }), proofDependencies(transport()))).rejects.toThrow("post_trained_api_url_invalid");
    const redirected = vi.fn(async () => new Response("{}", { status: 302, headers: { location: "https://other.example" } }));
    await expect(executePostTrainedLifecycleProof(proofInput(), inputDigest(), proofDependencies(redirected)))
      .rejects.toThrow("post_trained_redirect_refused");
  });

  it("bounds streamed response bytes and body time", async () => {
    const oversized = vi.fn(async () => new Response("x", { headers: { "content-length": "1048577" } }));
    await expect(executePostTrainedLifecycleProof(proofInput(), inputDigest(), proofDependencies(oversized)))
      .rejects.toThrow("post_trained_response_too_large");

    vi.useFakeTimers();
    const hanging = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const timeoutInput = { ...proofInput(), timeoutMs: 10 } as PostTrainedLifecycleProofInput;
    const pending = executePostTrainedLifecycleProof(timeoutInput, inputDigest(timeoutInput),
      proofDependencies(hanging));
    const rejected = expect(pending).rejects.toThrow("post_trained_request_failed");
    await vi.advanceTimersByTimeAsync(11);
    await rejected;

    const stalledBody = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    const bodyPending = executePostTrainedLifecycleProof(timeoutInput, inputDigest(timeoutInput),
      proofDependencies(stalledBody));
    const bodyRejected = expect(bodyPending).rejects.toThrow("post_trained_request_failed");
    await vi.advanceTimersByTimeAsync(11);
    await bodyRejected;
  });

  it("returns deterministic CLI failures without leaking the API key", async () => {
    const item = fixture({ ...proofInput(), apiBaseUrl: "http://external.example" });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runPostTrainedLifecycleProofCli([
      `--input=${item.inputPath}`, `--output=${item.outputPath}`,
    ], { MENDPOINT_API_KEY: "do-not-print" }, {
      stdout: (value) => { stdout.push(value); }, stderr: (value) => { stderr.push(value); },
    });
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")) .not.toContain("do-not-print");
    expect(JSON.parse(stderr.join(""))).toEqual({ ok: false, error: "post_trained_api_url_invalid" });
  });
});
