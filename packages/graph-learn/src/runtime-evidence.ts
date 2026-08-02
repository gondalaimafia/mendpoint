import {
  getNode,
  upsertEdge,
  upsertNode,
  type GraphLearnDb,
} from "./store.js";

export type RuntimeTraceEvidence = {
  type: "runtime_trace";
  id: string;
  observedAt: string;
  operation: string;
  status: "ok" | "error";
  durationMs?: number;
};

export type TestCoverageEvidence = {
  type: "test_coverage";
  id: string;
  observedAt: string;
  suite: string;
  linesPercent: number;
  branchesPercent: number;
  reportPath: string;
};

export type CodeownersEvidence = {
  type: "codeowners";
  id: string;
  observedAt: string;
  codeownersPath: string;
  owners: string[];
  matchedPaths: string[];
};

export type CiEvidence = {
  type: "ci";
  id: string;
  observedAt: string;
  provider: string;
  workflow: string;
  job: string;
  conclusion: "success" | "failure" | "cancelled" | "skipped";
  runId: string;
  runUrl?: string;
};

export type DeploymentEvidence = {
  type: "deployment";
  id: string;
  observedAt: string;
  environment: string;
  deploymentId: string;
  artifactSha256: string;
  status: "succeeded" | "failed" | "rolled_back";
};

export type CollectorEvidence = {
  type: "collector";
  id: string;
  observedAt: string;
  collectorId: string;
  collectorVersion: string;
  bindingKind: "runtime_trace" | "deployment";
  boundEvidenceId: string;
  payloadSha256: string;
};

export type RepositoryEvidence =
  | RuntimeTraceEvidence
  | TestCoverageEvidence
  | CodeownersEvidence
  | CiEvidence
  | DeploymentEvidence
  | CollectorEvidence;

export type RepositoryEvidenceType = RepositoryEvidence["type"];

export type IngestRepositoryEvidenceInput = {
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  exactCommit: string;
  capturedAt: string;
  evidence: RepositoryEvidence[];
};

function required(value: string, code: string): string {
  if (!value.trim()) throw new Error(code);
  return value;
}

function timestamp(value: string, code: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
  return new Date(value).toISOString();
}

function percent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function evidenceProps(evidence: RepositoryEvidence): Record<string, unknown> {
  const base = {
    evidence_id: required(evidence.id, "repository_evidence_id_required"),
    evidence_type: evidence.type,
    observed_at: timestamp(
      evidence.observedAt,
      "repository_evidence_observed_at_invalid",
    ),
  };
  switch (evidence.type) {
    case "runtime_trace":
      if (evidence.durationMs !== undefined && evidence.durationMs < 0) {
        throw new Error("repository_evidence_trace_duration_invalid");
      }
      return {
        ...base,
        operation: required(
          evidence.operation,
          "repository_evidence_trace_operation_required",
        ),
        status: evidence.status,
        duration_ms: evidence.durationMs,
      };
    case "test_coverage":
      if (
        !percent(evidence.linesPercent) ||
        !percent(evidence.branchesPercent)
      ) {
        throw new Error("repository_evidence_coverage_invalid");
      }
      return {
        ...base,
        suite: required(evidence.suite, "repository_evidence_suite_required"),
        lines_percent: evidence.linesPercent,
        branches_percent: evidence.branchesPercent,
        report_path: required(
          evidence.reportPath,
          "repository_evidence_report_path_required",
        ),
      };
    case "codeowners":
      if (!evidence.owners.length) {
        throw new Error("repository_evidence_codeowners_required");
      }
      return {
        ...base,
        codeowners_path: required(
          evidence.codeownersPath,
          "repository_evidence_codeowners_path_required",
        ),
        owners: [...evidence.owners],
        matched_paths: [...evidence.matchedPaths],
      };
    case "ci":
      return {
        ...base,
        provider: required(evidence.provider, "repository_evidence_ci_provider_required"),
        workflow: required(evidence.workflow, "repository_evidence_ci_workflow_required"),
        job: required(evidence.job, "repository_evidence_ci_job_required"),
        conclusion: evidence.conclusion,
        run_id: required(evidence.runId, "repository_evidence_ci_run_id_required"),
        run_url: evidence.runUrl,
      };
    case "deployment":
      if (!/^[a-f0-9]{64}$/i.test(evidence.artifactSha256)) {
        throw new Error("repository_evidence_deployment_hash_invalid");
      }
      return {
        ...base,
        environment: required(evidence.environment, "repository_evidence_deployment_environment_required"),
        deployment_id: required(evidence.deploymentId, "repository_evidence_deployment_id_required"),
        artifact_sha256: evidence.artifactSha256.toLowerCase(),
        status: evidence.status,
      };
    case "collector":
      if (!/^[a-f0-9]{64}$/i.test(evidence.payloadSha256)) {
        throw new Error("repository_evidence_collector_hash_invalid");
      }
      return {
        ...base,
        collector_id: required(evidence.collectorId, "repository_evidence_collector_id_required"),
        collector_version: required(evidence.collectorVersion, "repository_evidence_collector_version_required"),
        binding_kind: evidence.bindingKind,
        bound_evidence_id: required(evidence.boundEvidenceId, "repository_evidence_collector_binding_required"),
        payload_sha256: evidence.payloadSha256.toLowerCase(),
      };
  }
}

export function repositorySnapshotNodeId(
  tenantId: string,
  snapshotId: string,
): string {
  return `repository-snapshot:${tenantId}:${snapshotId}`;
}

/**
 * Preserve repository observations as immutable-snapshot evidence. Repeated
 * delivery of identical evidence is idempotent; conflicting reuse fails closed.
 */
export function ingestRepositoryEvidence(
  db: GraphLearnDb,
  input: IngestRepositoryEvidenceInput,
): { inserted: number; snapshotId: string } {
  const tenantId = required(input.tenantId, "repository_evidence_tenant_required");
  const repositoryId = required(
    input.repositoryId,
    "repository_evidence_repository_required",
  );
  const snapshotId = required(
    input.snapshotId,
    "repository_evidence_snapshot_required",
  );
  const exactCommit = required(
    input.exactCommit,
    "repository_evidence_commit_required",
  );
  const capturedAt = timestamp(
    input.capturedAt,
    "repository_evidence_captured_at_invalid",
  );
  const repoId = `${tenantId}:${repositoryId}`;
  const repositoryNodeId = `repository:${tenantId}:${repositoryId}`;
  const snapshotNodeId = repositorySnapshotNodeId(tenantId, snapshotId);
  const commitNodeId = `commit:${tenantId}:${repositoryId}:${exactCommit}`;

  const existingSnapshot = getNode(db, snapshotNodeId);
  if (
    existingSnapshot &&
    (existingSnapshot.props?.exact_commit !== exactCommit ||
      existingSnapshot.props?.repository_id !== repositoryId)
  ) {
    throw new Error("repository_evidence_snapshot_identity_mismatch");
  }

  const identities = new Set<string>();
  const prepared = input.evidence.map((evidence) => {
    const identity = `${evidence.type}:${evidence.id}`;
    if (identities.has(identity)) throw new Error("repository_evidence_duplicate");
    identities.add(identity);
    return { evidence, props: evidenceProps(evidence) };
  });
  const suppliedIds = new Set(input.evidence.map((evidence) => evidence.id));
  for (const evidence of input.evidence) {
    if (evidence.type === "collector" && !suppliedIds.has(evidence.boundEvidenceId)) {
      throw new Error("repository_evidence_collector_target_missing");
    }
    if (evidence.type === "collector") {
      const target = input.evidence.find((item) => item.id === evidence.boundEvidenceId);
      if (target?.type !== evidence.bindingKind) throw new Error("repository_evidence_collector_target_mismatch");
    }
  }

  upsertNode(db, {
    id: repositoryNodeId,
    kind: "Repository",
    label: repositoryId,
    repo_id: repoId,
    meta: { tenant_id: tenantId },
    props: { repository_id: repositoryId },
  });
  upsertNode(db, {
    id: commitNodeId,
    kind: "Commit",
    label: exactCommit,
    repo_id: repoId,
    meta: { tenant_id: tenantId },
    props: { repository_id: repositoryId, exact_commit: exactCommit },
  });
  upsertNode(db, {
    id: snapshotNodeId,
    kind: "RepositorySnapshot",
    label: `${repositoryId}@${exactCommit.slice(0, 12)}`,
    repo_id: repoId,
    first_seen: capturedAt,
    last_seen: capturedAt,
    meta: { tenant_id: tenantId },
    props: {
      repository_id: repositoryId,
      snapshot_id: snapshotId,
      exact_commit: exactCommit,
      captured_at: capturedAt,
    },
  });
  upsertEdge(db, {
    id: `VERSIONS:${snapshotNodeId}:${repositoryNodeId}`,
    kind: "VERSIONS",
    source: snapshotNodeId,
    target: repositoryNodeId,
    valid_from: capturedAt,
    source_system: "pipeline",
    confidence: 1,
  });
  upsertEdge(db, {
    id: `INCLUDES_COMMIT:${snapshotNodeId}:${commitNodeId}`,
    kind: "INCLUDES_COMMIT",
    source: snapshotNodeId,
    target: commitNodeId,
    valid_from: capturedAt,
    source_system: "git",
    confidence: 1,
  });

  for (const { evidence, props } of prepared) {
    const evidenceNodeId = `evidence:${tenantId}:${snapshotId}:${evidence.type}:${evidence.id}`;
    const storedProps = {
      ...props,
      repository_id: repositoryId,
      snapshot_id: snapshotId,
      exact_commit: exactCommit,
    };
    const existingEvidence = getNode(db, evidenceNodeId);
    if (
      existingEvidence &&
      JSON.stringify(existingEvidence.props) !== JSON.stringify(storedProps)
    ) {
      throw new Error("repository_evidence_identity_conflict");
    }
    upsertNode(db, {
      id: evidenceNodeId,
      kind: "Evidence",
      label: `${evidence.type}:${evidence.id}`,
      repo_id: repoId,
      first_seen: String(props.observed_at),
      last_seen: String(props.observed_at),
      meta: { tenant_id: tenantId },
      props: storedProps,
    });
    upsertEdge(db, {
      id: `EVIDENCES:${evidenceNodeId}:${snapshotNodeId}`,
      kind: "EVIDENCES",
      source: evidenceNodeId,
      target: snapshotNodeId,
      valid_from: String(props.observed_at),
      source_system:
        evidence.type === "runtime_trace"
          ? "runtime"
          : evidence.type === "deployment"
            ? "deployment"
            : evidence.type === "collector"
              ? "collector"
          : evidence.type === "ci"
            ? "ci"
            : "pipeline",
      confidence: 1,
      props: { evidence_type: evidence.type },
    });
  }

  return { inserted: prepared.length, snapshotId };
}
