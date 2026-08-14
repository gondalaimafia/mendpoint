/**
 * GitHub webhook verification + event normalization (Phase D).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubWebhookHeaders = {
  event: string;
  delivery?: string;
  signature256?: string;
};

export function parseWebhookHeaders(headers: Record<string, string | undefined>): GitHubWebhookHeaders {
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    event: lower["x-github-event"] ?? "",
    delivery: lower["x-github-delivery"],
    signature256: lower["x-hub-signature-256"],
  };
}

/**
 * Verify X-Hub-Signature-256. Returns true if secret unset (dev mode) unless requireSecret.
 */
export function verifyGitHubSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
  opts?: { requireSecret?: boolean },
): boolean {
  if (!secret) {
    return !opts?.requireSecret;
  }
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = signatureHeader.slice("sha256=".length);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(got, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type NormalizedWebhookAction =
  | {
      type: "installation";
      action: string;
      installationId: number;
      accountId?: number;
      accountLogin?: string;
      permissions?: Record<string, string>;
      repositorySelection?: "selected" | "all";
      repos?: Array<{ id?: number; owner: string; name: string }>;
      reposAdded?: Array<{ id?: number; owner: string; name: string }>;
      reposRemoved?: Array<{ id?: number; owner: string; name: string }>;
    }
  | {
      type: "pull_request";
      action: string;
      owner: string;
      repo: string;
      repositoryId?: number;
      accountId?: number;
      installationId?: number;
      number: number;
      merged: boolean;
      state: string;
      title: string;
      htmlUrl: string;
      headRef?: string;
      labels: string[];
    }
  | {
      type: "ping";
      zen?: string;
    }
  | {
      type: "pull_request_review";
      source: "review" | "comment";
      action: string;
      owner: string;
      repo: string;
      repositoryId?: number;
      accountId?: number;
      installationId?: number;
      pullRequestNumber: number;
      headSha: string;
      sourceId?: number;
    }
  | {
      type: "other";
      event: string;
      action?: string;
    };

export function normalizeGitHubEvent(
  event: string,
  payload: Record<string, unknown>,
): NormalizedWebhookAction {
  if (event === "ping") {
    return { type: "ping", zen: payload.zen as string | undefined };
  }

  if (event === "installation" || event === "installation_repositories") {
    const inst = payload.installation as
      | {
          id?: number;
          account?: { id?: number; login?: string };
          permissions?: Record<string, string>;
          repository_selection?: "selected" | "all";
        }
      | undefined;
    const normalizeRepos = (value: unknown) => (
      (value as Array<{ id?: number; name?: string; full_name?: string }> | undefined) ?? []
    ).map((r) => {
      const full = r.full_name ?? "";
      const [owner, name] = full.split("/");
      return {
        ...(Number.isSafeInteger(r.id) ? { id: r.id } : {}),
        owner: owner ?? "",
        name: name ?? r.name ?? "",
      };
    });
    const repos = normalizeRepos(payload.repositories);
    return {
      type: "installation",
      action: String(payload.action ?? ""),
      installationId: Number(inst?.id ?? 0),
      ...(Number.isSafeInteger(inst?.account?.id) && Number(inst?.account?.id) > 0
        ? { accountId: inst!.account!.id }
        : {}),
      accountLogin: inst?.account?.login,
      permissions: inst?.permissions,
      repositorySelection: inst?.repository_selection,
      repos,
      reposAdded: normalizeRepos(payload.repositories_added),
      reposRemoved: normalizeRepos(payload.repositories_removed),
    };
  }

  if (event === "pull_request") {
    const pr = payload.pull_request as {
      number?: number;
      merged?: boolean;
      state?: string;
      title?: string;
      html_url?: string;
      head?: { ref?: string };
      labels?: Array<{ name?: string }>;
    };
    const repo = payload.repository as {
      id?: number;
      name?: string;
      owner?: { id?: number; login?: string };
      full_name?: string;
    };
    const installation = payload.installation as { id?: number } | undefined;
    const owner =
      repo?.owner?.login ?? (repo?.full_name ? repo.full_name.split("/")[0] : "") ?? "";
    return {
      type: "pull_request",
      action: String(payload.action ?? ""),
      owner,
      repo: repo?.name ?? "",
      ...(Number.isSafeInteger(repo?.id) && Number(repo?.id) > 0
        ? { repositoryId: repo!.id }
        : {}),
      ...(Number.isSafeInteger(repo?.owner?.id) && Number(repo?.owner?.id) > 0
        ? { accountId: repo!.owner!.id }
        : {}),
      ...(Number.isSafeInteger(installation?.id) && Number(installation?.id) > 0
        ? { installationId: installation!.id }
        : {}),
      number: Number(pr?.number ?? 0),
      merged: Boolean(pr?.merged),
      state: String(pr?.state ?? ""),
      title: String(pr?.title ?? ""),
      htmlUrl: String(pr?.html_url ?? ""),
      headRef: pr?.head?.ref,
      labels: (pr?.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    };
  }

  if (event === "pull_request_review" || event === "pull_request_review_comment") {
    const pullRequest = payload.pull_request as { number?: number; head?: { sha?: string } } | undefined;
    const repository = payload.repository as {
      id?: number;
      name?: string;
      owner?: { id?: number; login?: string };
      full_name?: string;
    } | undefined;
    const installation = payload.installation as { id?: number } | undefined;
    const resource = (event === "pull_request_review" ? payload.review : payload.comment) as
      { id?: number } | undefined;
    const owner = repository?.owner?.login ??
      (repository?.full_name ? repository.full_name.split("/")[0] : "") ?? "";
    return {
      type: "pull_request_review",
      source: event === "pull_request_review" ? "review" : "comment",
      action: String(payload.action ?? ""),
      owner,
      repo: repository?.name ?? "",
      ...(Number.isSafeInteger(repository?.id) && Number(repository?.id) > 0
        ? { repositoryId: repository!.id }
        : {}),
      ...(Number.isSafeInteger(repository?.owner?.id) && Number(repository?.owner?.id) > 0
        ? { accountId: repository!.owner!.id }
        : {}),
      ...(Number.isSafeInteger(installation?.id) && Number(installation?.id) > 0
        ? { installationId: installation!.id }
        : {}),
      pullRequestNumber: Number(pullRequest?.number ?? 0),
      headSha: String(pullRequest?.head?.sha ?? ""),
      ...(Number.isSafeInteger(resource?.id) && Number(resource?.id) > 0
        ? { sourceId: resource!.id }
        : {}),
    };
  }

  return {
    type: "other",
    event,
    action: payload.action as string | undefined,
  };
}

/** Map PR close/merge to product feedback outcomes. */
export function prFeedbackFromWebhook(action: {
  type: "pull_request";
  action: string;
  merged: boolean;
}): "merged" | "closed" | null {
  if (action.action === "closed") {
    return action.merged ? "merged" : "closed";
  }
  return null;
}
