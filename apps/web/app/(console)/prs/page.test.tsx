import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => "/prs",
}));

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../../../lib/api", () => ({ apiGet }));

import PullRequestsPage from "./page";

describe("/prs page — a rejected /prs fetch renders unavailable, not empty", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("passes unavailable=true so the view does not certify a failure as 'none staged'", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs") throw new Error("API /prs returned 500");
      if (path === "/consumers") return [];
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(await PullRequestsPage());

    expect(html).toContain("Pull requests unavailable");
    expect(html).not.toContain("No pull requests staged yet.");
  });

  it("renders the honest empty state when the feed loads with no PRs", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs") return [];
      if (path === "/consumers") return [];
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(await PullRequestsPage());

    expect(html).toContain("No pull requests staged yet.");
    expect(html).not.toContain("Pull requests unavailable");
  });

  it("renders sealed Fettler delivery lineage without turning it into a customer mutation", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/consumers") return [];
      if (path === "/prs") return [{
        id: "candidate-a",
        changeId: "change-a",
        consumerId: "repo-a",
        title: "Replace the removed provider field",
        body: "The focused and regression checks passed.",
        branchName: "fettler/provider-change",
        status: "delivered",
        risk: "medium",
        patchUnified: "",
        githubPrNumber: 42,
        githubPrUrl: "https://github.com/customer/repo/pull/42",
        createdAt: "2026-08-31T13:00:00.000Z",
        source: "fettler_candidate",
        candidateDelivery: {
          source: "fettler_candidate",
          runId: "run-a",
          deliveryStatus: "delivered",
          outcome: null,
          repositoryId: "repo-a",
          snapshotId: "snapshot-a",
          baseBranch: "main",
          expectedBaseRevision: "a".repeat(40),
          deliveredBaseRevision: "a".repeat(40),
          deliveredCommitSha: "b".repeat(40),
          providerChange: {
            schemaVersion: 1,
            providerSlug: "stripe",
            changeId: "change-a",
            pipelineJobId: "pipeline-a",
            repositoryId: "repo-a",
            snapshotId: "snapshot-a",
            revision: "a".repeat(40),
            graphVersionId: "graph-a",
            graphContextArtifactId: "graph-context-a",
            impactEvidenceDigest: `sha256:${"c".repeat(64)}`,
            overallConfidence: "high",
            whatChanged: "The provider removed a field used by the client.",
            knownFacts: ["The removed field is read in src/client.ts."],
            unknowns: ["Runtime traffic volume is not observed."],
            whyAffected: "The repository reads the field removed by this version.",
          },
          proposedMigration: {
            summary: "Replace the removed provider field",
            edits: [{
              path: "src/client.ts",
              explanation: "Use the supported field.",
              risk: "medium",
              confidence: 0.95,
            }],
          },
          verification: {
            summary: "The focused and regression checks passed.",
            commands: [{ command: "npm test", outputSha256: `sha256:${"d".repeat(64)}` }],
          },
          changedPaths: ["src/client.ts"],
        },
      }];
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(await PullRequestsPage());

    expect(html).toContain("Fettler verified candidate");
    expect(html).toContain("Draft delivered");
    expect(html).toContain("What changed");
    expect(html).toContain("The provider removed a field used by the client.");
    expect(html).toContain("Change Graph");
    expect(html).toContain("graph-a");
    expect(html).toContain("graph-context-a");
    expect(html).toContain(`sha256:${"c".repeat(64)}`);
    expect(html).toContain("What we know");
    expect(html).toContain("What we do not know");
    expect(html).toContain("Proposed migration");
    expect(html).toContain("Replace the removed provider field");
    expect(html).toContain("Use the supported field.");
    expect(html).toContain("The focused and regression checks passed.");
    expect(html).toContain("npm test");
    expect(html).toContain("a".repeat(40));
    expect(html).toContain('href="https://github.com/customer/repo/pull/42"');
    expect(html).not.toContain('href="/prs/candidate-a"');
  });
});
