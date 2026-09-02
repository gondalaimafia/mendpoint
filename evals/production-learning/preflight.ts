import {
  validateExecutionReceipt,
  validateRepositoryProvenance,
  type LearningCase,
  type ProductionExecutionReceipt,
  type RepositoryProvenance,
} from "./schema.js";
import { fixtureManifestDigest, validateFixtureManifest, type FixtureManifest } from "./fixture.js";
import {
  revalidateSignedAuthorityContext,
  signedAuthorityEnvelopeDigest,
  verifySignedAuthorityEnvelope,
  type SignedAuthorityEnvelope,
  type VerifiedAuthorityContext,
} from "./authority.js";

export interface ProductionLearningAuthorityPayload {
  caseId: string;
  product: LearningCase["product"];
  productionRevision: string;
  tenantId: string;
  repositoryId: string;
  repositoryCommit: string;
  snapshotDigest: string;
  fixtureManifestDigest: string;
  graphVersion: string;
  policyVersion: string;
  modelProvider: string;
  modelId: string;
  routerVersion: string;
  recipeVersion: string | null;
  consentEvidenceRef: string;
  authorizationRef: string;
  sandboxReceiptDigest: string;
  executionDigest: string;
}

const VERIFIED_PRODUCTION_AUTHORITY: unique symbol = Symbol("verified-production-learning-authority");
const verifiedProductionAuthorities = new WeakSet<object>();
const productionAuthorityContexts = new WeakMap<object, VerifiedAuthorityContext>();
export type VerifiedProductionLearningAuthority = Readonly<ProductionLearningAuthorityPayload> & {
  readonly authorityEnvelopeDigest: string;
  readonly [VERIFIED_PRODUCTION_AUTHORITY]: true;
};

export function verifyProductionLearningAuthority(
  envelope: SignedAuthorityEnvelope<ProductionLearningAuthorityPayload>,
): VerifiedProductionLearningAuthority {
  const verifiedEnvelope = verifySignedAuthorityEnvelope(envelope, "production_learning");
  const payload = verifiedEnvelope.payload;
  const errors: string[] = [];
  const sha256 = /^[0-9a-f]{64}$/;
  const gitSha = /^[0-9a-f]{40}$/;
  if (!(payload.product === "fettler" || payload.product === "regauge")) errors.push("authority product is invalid");
  if (!gitSha.test(payload.productionRevision) || !gitSha.test(payload.repositoryCommit)) errors.push("authority revisions must be git shas");
  for (const [field, value] of [
    ["snapshotDigest", payload.snapshotDigest],
    ["fixtureManifestDigest", payload.fixtureManifestDigest],
    ["sandboxReceiptDigest", payload.sandboxReceiptDigest],
    ["executionDigest", payload.executionDigest],
  ] as const) if (!sha256.test(value)) errors.push(`authority ${field} must be sha256`);
  for (const [field, value] of Object.entries(payload)) {
    if (field !== "recipeVersion" && typeof value === "string" && value.trim().length === 0) errors.push(`authority ${field} must be non-empty`);
  }
  if (errors.length > 0) throw new Error(`production_learning_authority_invalid:${errors.join("|")}`);
  const token = Object.freeze({
    ...payload,
    authorityEnvelopeDigest: signedAuthorityEnvelopeDigest(envelope),
    [VERIFIED_PRODUCTION_AUTHORITY]: true,
  }) as VerifiedProductionLearningAuthority;
  verifiedProductionAuthorities.add(token);
  productionAuthorityContexts.set(token, verifiedEnvelope.context);
  return token;
}

export function requireVerifiedProductionLearningAuthority(
  authority: VerifiedProductionLearningAuthority,
): VerifiedProductionLearningAuthority {
  if (!verifiedProductionAuthorities.has(authority)) throw new Error("production_learning_authority_not_verified");
  const context = productionAuthorityContexts.get(authority);
  if (context === undefined) throw new Error("production_learning_authority_context_missing");
  revalidateSignedAuthorityContext(context);
  return authority;
}

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
    authorityEnvelopeDigest: string;
  };
}

export function evaluateProductionLearningPreflight(input: {
  learningCase: LearningCase;
  repository: RepositoryProvenance;
  fixture: FixtureManifest;
  receipt: ProductionExecutionReceipt;
  authority: VerifiedProductionLearningAuthority;
}): ProductionLearningPreflight {
  const { learningCase, repository, fixture, receipt, authority } = input;
  const errors = [
    ...validateRepositoryProvenance(repository),
    ...validateFixtureManifest(fixture, learningCase, repository),
    ...validateExecutionReceipt(receipt),
  ];
  try {
    requireVerifiedProductionLearningAuthority(authority);
  } catch {
    errors.push("trusted production authority must be signature verified and current");
  }
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
  const computedManifestDigest = fixtureManifestDigest(fixture);
  if (receipt.fixtureManifestDigest !== computedManifestDigest) {
    errors.push("receipt fixtureManifestDigest must match the complete fixture manifest");
  }
  if (!receipt.tenantId.startsWith("benchmark-tenant-")) {
    errors.push("receipt tenantId must identify a dedicated benchmark tenant");
  }
  const authorityBindings: Array<[string, unknown, unknown]> = [
    ["caseId", receipt.caseId, authority.caseId],
    ["product", receipt.product, authority.product],
    ["productionRevision", receipt.productionRevision, authority.productionRevision],
    ["tenantId", receipt.tenantId, authority.tenantId],
    ["repositoryId", receipt.repositoryId, authority.repositoryId],
    ["repositoryCommit", receipt.repositoryCommit, authority.repositoryCommit],
    ["snapshotDigest", receipt.snapshotDigest, authority.snapshotDigest],
    ["fixtureManifestDigest", receipt.fixtureManifestDigest, authority.fixtureManifestDigest],
    ["graphVersion", receipt.graphVersion, authority.graphVersion],
    ["policyVersion", receipt.policyVersion, authority.policyVersion],
    ["model.provider", receipt.model.provider, authority.modelProvider],
    ["model.modelId", receipt.model.modelId, authority.modelId],
    ["routerVersion", receipt.routerVersion, authority.routerVersion],
    ["recipeVersion", receipt.recipeVersion, authority.recipeVersion],
    ["consent.evidenceRef", receipt.consent.evidenceRef, authority.consentEvidenceRef],
    ["authorizationRef", receipt.authorizationRef, authority.authorizationRef],
    ["sandbox.receiptDigest", receipt.sandbox.receiptDigest, authority.sandboxReceiptDigest],
    ["executionDigest", receipt.executionDigest, authority.executionDigest],
  ];
  for (const [field, actual, expected] of authorityBindings) {
    if (actual !== expected) errors.push(`receipt ${field} must match trusted production authority`);
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
      authorityEnvelopeDigest: authority.authorityEnvelopeDigest,
    },
  };
}
