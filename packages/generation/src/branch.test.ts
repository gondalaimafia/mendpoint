/**
 * Branch-name safety for tenant-private providers (#704 follow-up).
 *
 * A tenant-private provider's stored slug is `<tenantId>~<requested>`. That must never flow
 * into a git branch name: `~` is forbidden by git check-ref-format (GitHub applies the same
 * rules) and the tenant id (an unsalted hash of issuer+email) must not land in a customer repo.
 * These tests prove the branch a private-provider run produces is a valid ref (verified with
 * the real `git check-ref-format` binary), carries no tenant id, and that shared-provider
 * branch names are byte-identical to today (no churn that would orphan an in-flight draft).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { generateMigration, isValidGitBranchName, refSafeBranchSegment } from "./index.js";
import type { GenerateInput } from "./index.js";

function gitAcceptsBranch(name: string): boolean {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const baseInput = (providerSlug: string): GenerateInput => ({
  providerName: "Example",
  providerSlug,
  change: {
    risk: "breaking",
    summary: "Rename customers.list cursor param",
    entries: [],
  } as unknown as GenerateInput["change"],
  findings: [],
  repoRoot: "/tmp/repo",
  mode: "migrate",
  idempotencyKey: "change-1:consumer-1",
});

describe("refSafeBranchSegment", () => {
  it("returns a shared/bare slug unchanged (no churn)", () => {
    expect(refSafeBranchSegment("stripe")).toBe("stripe");
    expect(refSafeBranchSegment("aws-sdk")).toBe("aws-sdk");
    expect(refSafeBranchSegment("payments-api")).toBe("payments-api");
  });

  it("strips the tenant namespace prefix (no tenant id in the result)", () => {
    expect(refSafeBranchSegment("tenant-a~my-internal-api")).toBe("my-internal-api");
    // Realistic self-serve tenant id: a 64-char sha256 hex, must not survive.
    const tenantId = createHash("sha256").update("issuer|user@example.com").digest("hex");
    const seg = refSafeBranchSegment(`${tenantId}~billing`);
    expect(seg).toBe("billing");
    expect(seg).not.toContain(tenantId);
  });
});

describe("isValidGitBranchName", () => {
  it("accepts a normal delivery branch", () => {
    expect(isValidGitBranchName("mendpoint/stripe-0123456789abcdef")).toBe(true);
  });
  it("rejects refs with forbidden characters or shapes", () => {
    expect(isValidGitBranchName("mendpoint/tenant-a~x-0123456789abcdef")).toBe(false);
    expect(isValidGitBranchName("mendpoint/x..y")).toBe(false);
    expect(isValidGitBranchName("mendpoint/x/")).toBe(false);
    expect(isValidGitBranchName("mendpoint/.hidden")).toBe(false);
    expect(isValidGitBranchName("")).toBe(false);
  });
});

describe("generateMigration branch names", () => {
  it("a private provider produces a ref-safe branch that git accepts and hides the tenant id", () => {
    const tenantId = "tenant-a";
    const draft = generateMigration(baseInput(`${tenantId}~my-internal-api`));
    expect(draft.branchName.startsWith("mendpoint/my-internal-api-")).toBe(true);
    expect(draft.branchName).not.toContain("~");
    expect(draft.branchName).not.toContain(tenantId);
    // Verified against the real binary GitHub mirrors.
    expect(gitAcceptsBranch(draft.branchName)).toBe(true);
  });

  it("a shared provider's branch name is byte-identical to the legacy formula", () => {
    const draft = generateMigration(baseInput("stripe"));
    const expectedHash = createHash("sha256").update("change-1:consumer-1", "utf8").digest("hex").slice(0, 16);
    expect(draft.branchName).toBe(`mendpoint/stripe-${expectedHash}`);
    expect(gitAcceptsBranch(draft.branchName)).toBe(true);
  });
});
