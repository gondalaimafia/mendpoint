/**
 * Post CI-style check comments / status on migration PRs (Phase D).
 */
import { Octokit } from "@octokit/rest";
import type { GitHubDelivery } from "./index.js";

export type CiCheckInput = {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  /** harness results summary */
  harness?: {
    name: string;
    passed: boolean;
    recall?: number;
    threshold?: number;
    detail?: string;
  }[];
  risk?: string;
  findings?: number;
  policyNotes?: string[];
  /** Product name in header; defaults to Fettler */
  product?: string;
};

export function formatCiCheckComment(input: CiCheckInput): string {
  const product = input.product ?? "Fettler";
  const lines = [
    `### ${product} CI check (Mendpoint)`,
    "",
    input.risk ? `- **Change risk:** ${input.risk}` : null,
    input.findings != null ? `- **Impact findings:** ${input.findings}` : null,
    "",
  ].filter((x) => x !== null) as string[];

  if (input.harness?.length) {
    lines.push("#### Quality harnesses");
    for (const h of input.harness) {
      const mark = h.passed ? "✅" : "❌";
      const rec =
        h.recall != null && h.threshold != null
          ? ` recall=${(h.recall * 100).toFixed(0)}% (need ≥${(h.threshold * 100).toFixed(0)}%)`
          : "";
      lines.push(`- ${mark} **${h.name}**${rec}${h.detail ? ` — ${h.detail}` : ""}`);
    }
    lines.push("");
  }

  if (input.policyNotes?.length) {
    lines.push("#### Policy");
    for (const n of input.policyNotes) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push(
    `Opened by **${product}**. Never auto-merges. Human review required.`,
  );
  return lines.join("\n");
}

export interface PrCommenter {
  commentOnPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<{ id: number; url?: string }>;
}

export class MockPrCommenter implements PrCommenter {
  comments: Array<{ owner: string; repo: string; prNumber: number; body: string }> = [];

  async commentOnPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<{ id: number; url?: string }> {
    this.comments.push({ owner, repo, prNumber, body });
    return { id: this.comments.length, url: `mock://comment/${this.comments.length}` };
  }
}

export class OctokitPrCommenter implements PrCommenter {
  private octokit: Octokit;

  constructor(token?: string) {
    const t = token ?? process.env.GITHUB_TOKEN;
    if (!t) throw new Error("GITHUB_TOKEN required for PR comments");
    this.octokit = new Octokit({
      auth: t,
      userAgent: "mendpoint-api",
      request: { timeout: 15_000 },
    });
  }

  async commentOnPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<{ id: number; url?: string }> {
    const { data } = await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    return { id: data.id, url: data.html_url };
  }
}

export async function postCiCheck(
  commenter: PrCommenter,
  input: CiCheckInput,
): Promise<{ id: number; url?: string; body: string }> {
  const body = formatCiCheckComment(input);
  const res = await commenter.commentOnPullRequest(
    input.owner,
    input.repo,
    input.prNumber,
    body,
  );
  return { ...res, body };
}

/** Optional extension of delivery for CI comments after PR open. */
export async function maybeCommentCiOnPr(
  delivery: GitHubDelivery & { comment?: PrCommenter },
  input: CiCheckInput,
): Promise<void> {
  if (!delivery.comment && process.env.GITHUB_MODE !== "real") {
    return;
  }
  const commenter =
    delivery.comment ??
    (process.env.GITHUB_MODE === "real" ? new OctokitPrCommenter() : new MockPrCommenter());
  await postCiCheck(commenter, input);
}
