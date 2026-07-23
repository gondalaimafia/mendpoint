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
      accountLogin?: string;
      repos?: Array<{ owner: string; name: string }>;
    }
  | {
      type: "pull_request";
      action: string;
      owner: string;
      repo: string;
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
      | { id?: number; account?: { login?: string } }
      | undefined;
    const repos = (
      (payload.repositories as Array<{ name?: string; full_name?: string }> | undefined) ?? []
    ).map((r) => {
      const full = r.full_name ?? "";
      const [owner, name] = full.split("/");
      return { owner: owner ?? "", name: name ?? r.name ?? "" };
    });
    return {
      type: "installation",
      action: String(payload.action ?? ""),
      installationId: Number(inst?.id ?? 0),
      accountLogin: inst?.account?.login,
      repos,
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
      name?: string;
      owner?: { login?: string };
      full_name?: string;
    };
    const owner =
      repo?.owner?.login ?? (repo?.full_name ? repo.full_name.split("/")[0] : "") ?? "";
    return {
      type: "pull_request",
      action: String(payload.action ?? ""),
      owner,
      repo: repo?.name ?? "",
      number: Number(pr?.number ?? 0),
      merged: Boolean(pr?.merged),
      state: String(pr?.state ?? ""),
      title: String(pr?.title ?? ""),
      htmlUrl: String(pr?.html_url ?? ""),
      headRef: pr?.head?.ref,
      labels: (pr?.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
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
