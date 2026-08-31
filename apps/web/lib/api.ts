const API_URL =
  process.env.MENDPOINT_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001";

export function apiBase(): string {
  return API_URL;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export class ApiRequestError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(`API ${path} returned ${status}${requestId ? `, request ${requestId}` : ""}`);
    this.name = "ApiRequestError";
  }
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    const apiKey = process.env.MENDPOINT_API_KEY?.trim();
    if (apiKey && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    return await fetch(url, {
      ...init,
      headers,
      signal: ctrl.signal,
      cache: init?.cache ?? "no-store",
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`API timeout after ${timeoutMs}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function apiGet<T>(path: string, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(`${API_URL}${path}`, undefined, timeoutMs);
  if (!res.ok) {
    throw new ApiRequestError(path, res.status, res.headers.get("x-request-id"));
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(
    `${API_URL}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res.ok) {
    throw new ApiRequestError(path, res.status, res.headers.get("x-request-id"));
  }
  return res.json() as Promise<T>;
}

export type Provider = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  createdAt: string;
};

export type ChangeImpactCoverage = {
  impact: "impact" | "no_impact" | "unknown_impact";
  coverageBasis: "analyzed" | "partial" | "not_analyzed" | null;
  reason: string | null;
  findingCount: number;
  prCount: number;
  /** FET-018: present when impact analysis used the raw-retrieval path. */
  fallback?: "raw_retrieval" | null;
};

export type ApiChange = {
  id: string;
  providerId: string;
  risk: string;
  summary: string;
  createdAt: string;
};

export type MigrationPr = {
  id: string;
  changeId: string;
  consumerId: string;
  title: string;
  body: string;
  branchName: string;
  status: string;
  risk: string;
  patchUnified: string;
  githubPrNumber: number | null;
  githubPrUrl: string | null;
  createdAt: string;
  /**
   * Coverage/basis of the impact analysis behind this PR (§11.7, §12.4). Lets the
   * console distinguish "analyzed, no impact" (clean) from "analysis incomplete
   * or never ran" (unknown). Null for PRs recorded before this channel existed.
   */
  coverage?: {
    basis: "analyzed" | "partial" | "not_analyzed";
    reason?: string;
    gaps?: Array<{ reason: string; detail: string; count?: number }>;
    filesInspected?: number;
    filesInScope?: number;
    languagesSupported?: string[];
    languagesPresent?: string[];
  } | null;
  /** Identifies the durable delivery lane that produced this console row. */
  source?: "legacy_migration" | "fettler_candidate";
  /** Digest verified candidate authority. Present only for the Fettler lane. */
  candidateDelivery?: {
    source: "fettler_candidate";
    runId: string;
    deliveryStatus: "delivery_pending" | "delivered" | "delivery_failed";
    outcome: "merged" | "closed_unmerged" | "reverted" | null;
    repositoryId: string;
    snapshotId: string;
    baseBranch: string;
    expectedBaseRevision: string;
    deliveredBaseRevision: string | null;
    deliveredCommitSha: string | null;
    providerChange: {
      schemaVersion: 1;
      providerSlug: string;
      changeId: string;
      pipelineJobId: string;
      contentHash: string;
      fromVersionId: string;
      fromVersionLabel: string;
      toVersionId: string;
      toVersionLabel: string;
      repositoryId: string;
      snapshotId: string;
      revision: string;
      graphVersionId: string | null;
      graphContextArtifactId: string | null;
      impactEvidenceDigest: string;
      overallConfidence: "medium" | "high";
      whatChanged: string;
      knownFacts: readonly string[];
      unknowns: readonly string[];
      whyAffected: string;
    } | null;
    proposedMigration: {
      summary: string;
      edits: readonly {
        path: string;
        explanation: string;
        risk: "low" | "medium" | "high" | null;
        confidence: number | null;
      }[];
    };
    verification: {
      summary: string;
      commands: readonly { command: string; outputSha256: string }[];
    };
    changedPaths: readonly string[];
  };
};

export type MigrationPrReview = {
  id: string;
  subjectType: "migration_pr";
  subjectId: string;
  candidateArtifactId: string;
  reviewer: { subject: string; displayName: string };
  decision: "approve" | "reject" | "request_changes" | "regenerate";
  rationale: string;
  waiverExpiresAt: string | null;
  supersedesId: string | null;
  createdAt: string;
};

export type Consumer = {
  id: string;
  name: string;
  githubOwner: string;
  githubRepo: string;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
};
