import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyAuthorityRotation,
  type AuthorityRotationFileChange,
  type AuthorityRotationLedger,
  type ClosureAuthorityPolicy,
} from "./production-closure-authority-rotation.js";

const BASE = "a".repeat(40);
const OBSERVED_AT = "2026-08-25T12:00:00.000Z";

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function policy(fileDigest = digest("base")): ClosureAuthorityPolicy {
  return {
    schemaVersion: 1,
    repositoryId: 1309389373,
    repository: "gondalaimafia/mendpoint",
    workflowPath: ".github/workflows/closure-authority.yml",
    requiredCiWorkflowPath: ".github/workflows/ci.yml",
    externalCheckName: "mendpoint-production-closure-authority",
    externalCheckAppId: 123,
    controllerCheckName: "mendpoint-production-closure-controller",
    controllerCheckAppId: 15368,
    protectionMode: "classic_branch",
    protectionBranch: "main",
    legacyBootstrapMatrixDigest: digest("legacy"),
    authorityRotationManifestPath: "config/production-closure-authority-rotation.json",
    authorityRotationAuxiliaryFiles: ["scripts/production-closure-authority-rotation.test.ts"],
    successor: null,
    trustedReviewers: {
      Claude: [{ login: "trusted-reviewer", userId: 42 }],
    },
    productionEvidenceAuthorities: [],
    protectedFiles: {
      ".github/workflows/closure-authority.yml": digest("workflow"),
      "scripts/a.ts": fileDigest,
    },
  };
}

function fixture() {
  const basePolicy = policy();
  const proposedPolicy = policy(digest("proposed"));
  const basePolicyBytes = Buffer.from(JSON.stringify(basePolicy));
  const proposedPolicyBytes = Buffer.from(JSON.stringify(proposedPolicy));
  const changes: AuthorityRotationFileChange[] = [
    {
      path: "config/production-closure-authority.json",
      fromSha256: digest(basePolicyBytes),
      toSha256: digest(proposedPolicyBytes),
      fromMode: "100644",
      toMode: "100644",
    },
    {
      path: "scripts/a.ts",
      fromSha256: digest("base"),
      toSha256: digest("proposed"),
      fromMode: "100644",
      toMode: "100644",
    },
  ];
  const baseLedger: AuthorityRotationLedger = { schemaVersion: 1, rotations: [] };
  const baseLedgerBytes = Buffer.from(JSON.stringify(baseLedger));
  const proposedLedger: AuthorityRotationLedger = {
    schemaVersion: 1,
    rotations: [{
      kind: "runtime",
      rotationId: "rotation-20260825-001",
      previousRotationId: null,
      baseRevision: BASE,
      issuedAt: "2026-08-25T11:00:00.000Z",
      expiresAt: "2026-08-26T11:00:00.000Z",
      baseLedgerSha256: digest(baseLedgerBytes),
      basePolicySha256: digest(basePolicyBytes),
      proposedPolicySha256: digest(proposedPolicyBytes),
      successor: null,
      changes: changes.map((change) => ({ ...change })),
    }],
  };
  const proposedFileContents = new Map<string, Buffer>([
    [".github/workflows/closure-authority.yml", Buffer.from("workflow")],
    ["scripts/a.ts", Buffer.from("proposed")],
  ]);
  return {
    basePolicy,
    proposedPolicy,
    basePolicyBytes,
    proposedPolicyBytes,
    baseLedgerBytes,
    baseLedger,
    proposedLedger,
    baseRevision: BASE,
    observedAt: OBSERVED_AT,
    changedFiles: changes,
    proposedFileDigests: new Map(
      [...proposedFileContents].map(([path, bytes]) => [path, digest(bytes)]),
    ),
    proposedFileContents,
    proposedPaths: new Set(proposedFileContents.keys()),
  };
}

describe("production closure authority rotation", () => {
  it("accepts an exact bounded runtime authority rotation", () => {
    expect(verifyAuthorityRotation(fixture())).toEqual([]);
  });

  it("rejects product changes and a non-exhaustive receipt", () => {
    const input = fixture();
    input.changedFiles = [
      ...input.changedFiles,
      {
        path: "apps/api/src/server.ts",
        fromSha256: digest("old"),
        toSha256: digest("new"),
        fromMode: "100644",
        toMode: "100644",
      },
    ];

    const codes = verifyAuthorityRotation(input).map((issue) => issue.code);
    expect(codes).toContain("AUTHORITY_ROTATION_SCOPE_INVALID");
    expect(codes).toContain("AUTHORITY_ROTATION_CHANGESET_MISMATCH");
  });

  it("rejects a proposed policy that widens protected authority into product code", () => {
    const input = fixture();
    input.proposedPolicy.protectedFiles["apps/api/src/server.ts"] = digest("new");
    input.proposedPolicyBytes = Buffer.from(JSON.stringify(input.proposedPolicy));
    input.proposedLedger.rotations.at(-1)!.proposedPolicySha256 = digest(input.proposedPolicyBytes);
    input.proposedFileContents.set("apps/api/src/server.ts", Buffer.from("new"));
    input.proposedFileDigests.set("apps/api/src/server.ts", digest("new"));
    (input.proposedPaths as Set<string>).add("apps/api/src/server.ts");

    expect(verifyAuthorityRotation(input).map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_PROTECTED_PATH_INVALID",
    );
  });

  it("rejects rewritten rotation history", () => {
    const input = fixture();
    input.baseLedger.rotations.push({ ...input.proposedLedger.rotations[0], rotationId: "rotation-20260824-001" });
    input.proposedLedger.rotations.unshift({ ...input.baseLedger.rotations[0], expiresAt: "2026-08-25T10:00:00.000Z" });
    expect(verifyAuthorityRotation(input).map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_RECEIPT_INVALID",
    );
  });

  it("binds Git modes in the exhaustive rotation receipt", () => {
    const input = fixture();
    input.changedFiles[1] = { ...input.changedFiles[1], toMode: "100755" };

    expect(verifyAuthorityRotation(input).map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_CHANGESET_MISMATCH",
    );
  });

  it("rejects removal of every base-trusted reviewer", () => {
    const input = fixture();
    input.proposedPolicy.trustedReviewers = {
      Cursor: [{ login: "new-reviewer", userId: 99 }],
    };
    input.proposedPolicyBytes = Buffer.from(JSON.stringify(input.proposedPolicy));
    input.proposedLedger.rotations.at(-1)!.proposedPolicySha256 = digest(input.proposedPolicyBytes);

    expect(verifyAuthorityRotation(input).map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_REVIEWER_CONTINUITY_REQUIRED",
    );
  });

  it("rejects direct replacement of the active controller workflow", () => {
    const input = fixture();
    input.changedFiles.push({
      path: input.basePolicy.workflowPath,
      fromSha256: digest("workflow"),
      toSha256: digest("new workflow"),
      fromMode: "100644",
      toMode: "100644",
    });
    input.proposedLedger.rotations.at(-1)!.changes = input.changedFiles;

    expect(verifyAuthorityRotation(input).map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_WORKFLOW_SUCCESSOR_REQUIRED",
    );
  });

  it("rejects unpinned relative imports in the proposed authority closure", () => {
    const input = fixture();
    const source = Buffer.from('import { value } from "./dependency.js";\nexport { value };\n');
    input.proposedPolicy.protectedFiles["scripts/a.ts"] = digest(source);
    input.proposedPolicyBytes = Buffer.from(JSON.stringify(input.proposedPolicy));
    input.proposedLedger.rotations.at(-1)!.proposedPolicySha256 = digest(input.proposedPolicyBytes);
    input.proposedFileContents.set("scripts/a.ts", source);
    input.proposedFileContents.set("scripts/dependency.ts", Buffer.from("export const value = 1;\n"));
    (input.proposedPaths as Set<string>).add("scripts/dependency.ts");
    input.proposedFileDigests.set("scripts/a.ts", digest(source));

    expect(verifyAuthorityRotation(input).map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_IMPORT_CLOSURE_INCOMPLETE",
    );
  });

  it("rejects an expired or overlong rotation window", () => {
    const input = fixture();
    input.proposedLedger.rotations.at(-1)!.issuedAt = "2026-08-01T00:00:00.000Z";
    input.proposedLedger.rotations.at(-1)!.expiresAt = "2026-08-20T00:00:00.000Z";

    expect(verifyAuthorityRotation(input).map((issue) => issue.code)).toContain(
      "AUTHORITY_ROTATION_RECEIPT_INVALID",
    );
  });

  it("stages a distinct pinned successor without changing the active authority", () => {
    const input = fixture();
    const receipt = input.proposedLedger.rotations.at(-1)!;
    const successorBytes = Buffer.from("name: successor\n");
    const successor = {
      workflowPath: ".github/workflows/closure-authority-v2.yml",
      workflowSha256: digest(successorBytes),
      externalCheckName: "mendpoint-production-closure-authority-v2",
      externalCheckAppId: 123,
      controllerCheckName: "mendpoint-production-closure-controller-v2",
      controllerCheckAppId: 15368,
      activationDeadline: receipt.expiresAt,
    };
    receipt.kind = "stage_successor";
    receipt.successor = successor;
    input.proposedPolicy = structuredClone(input.basePolicy);
    input.proposedPolicy.successor = {
      phase: "staged",
      stagedByRotationId: receipt.rotationId,
      activatedByRotationId: null,
      ...successor,
    };
    input.proposedPolicy.protectedFiles[successor.workflowPath] = successor.workflowSha256;
    input.proposedPolicyBytes = Buffer.from(JSON.stringify(input.proposedPolicy));
    receipt.proposedPolicySha256 = digest(input.proposedPolicyBytes);
    const policyChange = input.changedFiles[0];
    policyChange.toSha256 = digest(input.proposedPolicyBytes);
    input.changedFiles = [
      policyChange,
      {
        path: successor.workflowPath,
        fromSha256: null,
        toSha256: successor.workflowSha256,
        fromMode: null,
        toMode: "100644",
      },
    ];
    receipt.changes = input.changedFiles.map((change) => ({ ...change }));
    input.proposedFileContents.set(successor.workflowPath, successorBytes);
    input.proposedFileDigests.set(successor.workflowPath, successor.workflowSha256);
    input.proposedFileContents.set("scripts/a.ts", Buffer.from("base"));
    input.proposedFileDigests.set("scripts/a.ts", digest("base"));
    (input.proposedPaths as Set<string>).add(successor.workflowPath);

    expect(verifyAuthorityRotation(input)).toEqual([]);
  });

  it("rejects a staged successor that changes the active workflow or reuses a context", () => {
    const input = fixture();
    const receipt = input.proposedLedger.rotations.at(-1)!;
    receipt.kind = "stage_successor";
    receipt.successor = {
      workflowPath: ".github/workflows/closure-authority-v2.yml",
      workflowSha256: digest("successor"),
      externalCheckName: input.basePolicy.externalCheckName,
      externalCheckAppId: 123,
      controllerCheckName: "mendpoint-production-closure-controller-v2",
      controllerCheckAppId: 15368,
      activationDeadline: receipt.expiresAt,
    };
    input.proposedPolicy.workflowPath = ".github/workflows/closure-authority-replaced.yml";
    input.proposedPolicy.successor = {
      phase: "staged",
      stagedByRotationId: receipt.rotationId,
      activatedByRotationId: null,
      ...receipt.successor,
    };
    input.proposedPolicy.protectedFiles[receipt.successor.workflowPath] = receipt.successor.workflowSha256;
    input.proposedPolicyBytes = Buffer.from(JSON.stringify(input.proposedPolicy));
    receipt.proposedPolicySha256 = digest(input.proposedPolicyBytes);

    const codes = verifyAuthorityRotation(input).map((issue) => issue.code);
    expect(codes).toContain("AUTHORITY_SUCCESSOR_STAGE_ACTIVE_DRIFT");
    expect(codes).toContain("AUTHORITY_SUCCESSOR_CONTEXT_COLLISION");
  });

  it("fails closed on malformed successor data and cross-context collisions", () => {
    const malformed = fixture();
    const malformedReceipt = malformed.proposedLedger.rotations.at(-1)!;
    malformedReceipt.kind = "stage_successor";
    malformedReceipt.successor = {
      workflowPath: ".github/workflows/closure-authority-v2.yml",
      workflowSha256: digest("successor"),
      externalCheckName: undefined as unknown as string,
      externalCheckAppId: 123,
      controllerCheckName: "mendpoint-production-closure-controller-v2",
      controllerCheckAppId: 15368,
      activationDeadline: malformedReceipt.expiresAt,
    };
    expect(() => verifyAuthorityRotation(malformed)).not.toThrow();
    expect(verifyAuthorityRotation(malformed).map((issue) => issue.code)).toContain(
      "AUTHORITY_SUCCESSOR_TUPLE_INVALID",
    );

    const collision = fixture();
    const collisionReceipt = collision.proposedLedger.rotations.at(-1)!;
    collisionReceipt.kind = "stage_successor";
    collisionReceipt.successor = {
      workflowPath: ".github/workflows/closure-authority-v2.yml",
      workflowSha256: digest("successor"),
      externalCheckName: collision.basePolicy.controllerCheckName,
      externalCheckAppId: 123,
      controllerCheckName: "mendpoint-production-closure-controller-v2",
      controllerCheckAppId: 15368,
      activationDeadline: collisionReceipt.expiresAt,
    };
    collision.proposedPolicy.successor = {
      phase: "staged",
      stagedByRotationId: collisionReceipt.rotationId,
      activatedByRotationId: null,
      ...collisionReceipt.successor,
    };
    collision.proposedPolicy.protectedFiles[collisionReceipt.successor.workflowPath] =
      collisionReceipt.successor.workflowSha256;
    collision.proposedPolicyBytes = Buffer.from(JSON.stringify(collision.proposedPolicy));
    collisionReceipt.proposedPolicySha256 = digest(collision.proposedPolicyBytes);

    expect(verifyAuthorityRotation(collision).map((issue) => issue.code)).toContain(
      "AUTHORITY_SUCCESSOR_CONTEXT_COLLISION",
    );
  });

  it("activates only the unchanged staged successor while retaining both workflows", () => {
    const input = fixture();
    const successorBytes = Buffer.from("name: successor\n");
    const successor = {
      workflowPath: ".github/workflows/closure-authority-v2.yml",
      workflowSha256: digest(successorBytes),
      externalCheckName: "mendpoint-production-closure-authority-v2",
      externalCheckAppId: 123,
      controllerCheckName: "mendpoint-production-closure-controller-v2",
      controllerCheckAppId: 15368,
      activationDeadline: "2026-08-26T12:00:00.000Z",
    };
    input.basePolicy.successor = {
      phase: "staged",
      stagedByRotationId: "rotation-20260824-stage",
      activatedByRotationId: null,
      ...successor,
    };
    input.basePolicy.protectedFiles[successor.workflowPath] = successor.workflowSha256;
    input.basePolicyBytes = Buffer.from(JSON.stringify(input.basePolicy));
    input.baseLedger = {
      schemaVersion: 1,
      rotations: [{
        ...input.proposedLedger.rotations[0],
        kind: "stage_successor",
        rotationId: "rotation-20260824-stage",
        previousRotationId: null,
        basePolicySha256: digest("pre-stage-policy"),
        proposedPolicySha256: digest(input.basePolicyBytes),
        successor,
      }],
    };
    input.baseLedgerBytes = Buffer.from(JSON.stringify(input.baseLedger));
    input.proposedPolicy = structuredClone(input.basePolicy);
    input.proposedPolicy.workflowPath = successor.workflowPath;
    input.proposedPolicy.externalCheckName = successor.externalCheckName;
    input.proposedPolicy.externalCheckAppId = successor.externalCheckAppId;
    input.proposedPolicy.controllerCheckName = successor.controllerCheckName;
    input.proposedPolicy.controllerCheckAppId = successor.controllerCheckAppId;
    input.proposedPolicy.successor = {
      ...input.basePolicy.successor,
      phase: "active",
      activatedByRotationId: "rotation-20260825-activate",
    };
    input.proposedPolicyBytes = Buffer.from(JSON.stringify(input.proposedPolicy));
    input.changedFiles = [{
      path: "config/production-closure-authority.json",
      fromSha256: digest(input.basePolicyBytes),
      toSha256: digest(input.proposedPolicyBytes),
      fromMode: "100644",
      toMode: "100644",
    }];
    input.proposedLedger = {
      schemaVersion: 1,
      rotations: [
        ...input.baseLedger.rotations,
        {
          kind: "activate_successor",
          rotationId: "rotation-20260825-activate",
          previousRotationId: "rotation-20260824-stage",
          baseRevision: BASE,
          issuedAt: "2026-08-25T11:00:00.000Z",
          expiresAt: "2026-08-25T13:00:00.000Z",
          baseLedgerSha256: digest(input.baseLedgerBytes),
          basePolicySha256: digest(input.basePolicyBytes),
          proposedPolicySha256: digest(input.proposedPolicyBytes),
          successor,
          changes: input.changedFiles,
        },
      ],
    };
    input.proposedFileContents.set(successor.workflowPath, successorBytes);
    input.proposedFileDigests.set(successor.workflowPath, successor.workflowSha256);
    input.proposedFileContents.set("scripts/a.ts", Buffer.from("base"));
    input.proposedFileDigests.set("scripts/a.ts", digest("base"));
    (input.proposedPaths as Set<string>).add(successor.workflowPath);

    expect(verifyAuthorityRotation(input)).toEqual([]);
  });

  it("rejects activation after the deadline or with staged workflow drift or predecessor removal", () => {
    const input = fixture();
    const successor = {
      workflowPath: ".github/workflows/closure-authority-v2.yml",
      workflowSha256: digest("staged-successor"),
      externalCheckName: "mendpoint-production-closure-authority-v2",
      externalCheckAppId: 123,
      controllerCheckName: "mendpoint-production-closure-controller-v2",
      controllerCheckAppId: 15368,
      activationDeadline: "2026-08-25T11:30:00.000Z",
    };
    input.basePolicy.successor = {
      phase: "staged",
      stagedByRotationId: "rotation-20260824-stage",
      activatedByRotationId: null,
      ...successor,
    };
    input.basePolicy.protectedFiles[successor.workflowPath] = successor.workflowSha256;
    input.basePolicyBytes = Buffer.from(JSON.stringify(input.basePolicy));
    input.baseLedger = {
      schemaVersion: 1,
      rotations: [{
        ...input.proposedLedger.rotations[0],
        kind: "stage_successor",
        rotationId: "rotation-20260824-stage",
        previousRotationId: null,
        successor,
      }],
    };
    input.baseLedgerBytes = Buffer.from(JSON.stringify(input.baseLedger));
    input.proposedPolicy = structuredClone(input.basePolicy);
    input.proposedPolicy.workflowPath = successor.workflowPath;
    delete input.proposedPolicy.protectedFiles[input.basePolicy.workflowPath];
    input.proposedPolicy.protectedFiles[successor.workflowPath] = digest("drifted-successor");
    input.proposedPolicy.successor = {
      ...input.basePolicy.successor,
      phase: "active",
      activatedByRotationId: "rotation-20260825-activate",
    };
    input.proposedPolicyBytes = Buffer.from(JSON.stringify(input.proposedPolicy));
    const receipt = input.proposedLedger.rotations.at(-1)!;
    receipt.kind = "activate_successor";
    receipt.rotationId = "rotation-20260825-activate";
    receipt.previousRotationId = "rotation-20260824-stage";
    receipt.baseLedgerSha256 = digest(input.baseLedgerBytes);
    receipt.basePolicySha256 = digest(input.basePolicyBytes);
    receipt.proposedPolicySha256 = digest(input.proposedPolicyBytes);
    receipt.successor = successor;
    input.proposedLedger.rotations = [...input.baseLedger.rotations, receipt];

    const codes = verifyAuthorityRotation(input).map((issue) => issue.code);
    expect(codes).toContain("AUTHORITY_SUCCESSOR_ACTIVATION_EXPIRED");
    expect(codes).toContain("AUTHORITY_SUCCESSOR_STAGED_BYTES_DRIFT");
    expect(codes).toContain("AUTHORITY_SUCCESSOR_PREDECESSOR_NOT_RETAINED");
  });
});
