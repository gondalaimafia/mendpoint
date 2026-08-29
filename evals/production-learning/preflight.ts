import {
  validateExecutionReceipt,
  validateRepositoryProvenance,
  type LearningCase,
  type ProductionExecutionReceipt,
  type RepositoryProvenance,
} from "./schema.js";
import { validateFixtureManifest, type FixtureManifest } from "./fixture.js";

export interface ProductionLearningPreflight {
  allowed: boolean;
  errors: string[];
  bindings: {
    caseId: string;
    productionRevision: string;
    tenantId: string;
    repositoryId: string;
    repositoryCommit: string;
    executionDigest: string;
  };
}

export function evaluateProductionLearningPreflight(input: {
  learningCase: LearningCase;
  repository: RepositoryProvenance;
  fixture: FixtureManifest;
  receipt: ProductionExecutionReceipt;
}): ProductionLearningPreflight {
  const { learningCase, repository, fixture, receipt } = input;
  const errors = [
    ...validateRepositoryProvenance(repository),
    ...validateFixtureManifest(fixture, learningCase, repository),
    ...validateExecutionReceipt(receipt),
  ];
  if (receipt.caseId !== learningCase.id) errors.push("receipt caseId must match the learning case");
  if (receipt.product !== learningCase.product) errors.push("receipt product must match the learning case");
  if (receipt.repositoryId !== repository.id) errors.push("receipt repositoryId must match provenance");
  if (receipt.repositoryCommit !== repository.immutableCommit) {
    errors.push("receipt repositoryCommit must match provenance");
  }
  if (receipt.repositoryCommit !== fixture.repository.immutableCommit) {
    errors.push("receipt repositoryCommit must match fixture snapshot");
  }
  if (receipt.snapshotDigest !== fixture.repository.pristineSnapshotSha256) {
    errors.push("receipt snapshotDigest must match fixture snapshot");
  }
  if (!receipt.tenantId.startsWith("benchmark-tenant-")) {
    errors.push("receipt tenantId must identify a dedicated benchmark tenant");
  }
  return {
    allowed: errors.length === 0,
    errors,
    bindings: {
      caseId: receipt.caseId,
      productionRevision: receipt.productionRevision,
      tenantId: receipt.tenantId,
      repositoryId: receipt.repositoryId,
      repositoryCommit: receipt.repositoryCommit,
      executionDigest: receipt.executionDigest,
    },
  };
}
