import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  type AppDb,
} from "@mendpoint/db";
import { parseLearningCorpusArgs, sealGovernedLearningCorpus } from "./learning-corpus-cli.js";

const CREATED_AT = "2026-08-14T20:00:00.000Z";
const CUTOFF_AT = "2026-08-14T19:30:00.000Z";
const PURPOSE = "governed-adapter-training";
const dbs: AppDb[] = [];
const roots: string[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-learning-corpus-cli-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: CREATED_AT });
  insertPrincipal(db, {
    id: "human-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "reviewer-a",
    displayName: "Reviewer A",
    createdAt: CREATED_AT,
  });
  return db;
}

describe("parseLearningCorpusArgs", () => {
  it("requires tenant, purpose, cutoff, actor, and idempotency key", () => {
    expect(() => parseLearningCorpusArgs([], {})).toThrow("learning_corpus_tenant_required");
    expect(() => parseLearningCorpusArgs(["--tenant", "tenant-a"], {})).toThrow("learning_corpus_purpose_required");
    expect(() => parseLearningCorpusArgs(
      ["--tenant", "tenant-a", "--purpose", PURPOSE],
      {},
    )).toThrow("learning_corpus_cutoff_required");
    expect(() => parseLearningCorpusArgs(
      ["--tenant", "tenant-a", "--purpose", PURPOSE, "--cutoff", CUTOFF_AT],
      {},
    )).toThrow("learning_corpus_actor_required");
    expect(() => parseLearningCorpusArgs(
      ["--tenant", "tenant-a", "--purpose", PURPOSE, "--cutoff", CUTOFF_AT, "--actor", "human-a"],
      {},
    )).toThrow("learning_corpus_idempotency_key_required");
  });

  it("rejects a non-ISO cutoff and reads tenant from the environment", () => {
    expect(() => parseLearningCorpusArgs(
      ["--purpose", PURPOSE, "--cutoff", "yesterday", "--actor", "human-a", "--idempotency-key", "k1"],
      { MENDPOINT_TENANT_ID: "tenant-a" },
    )).toThrow("learning_corpus_cutoff_invalid");
    const parsed = parseLearningCorpusArgs(
      ["--purpose", PURPOSE, "--cutoff", CUTOFF_AT, "--actor", "human-a", "--idempotency-key", "k1", "--created-at", CREATED_AT],
      { MENDPOINT_TENANT_ID: "tenant-a" },
    );
    expect(parsed).toEqual({
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "k1",
      createdAt: CREATED_AT,
    });
  });
});

describe("sealGovernedLearningCorpus", () => {
  it("fails closed without active consent, and refuses to seal an empty corpus", () => {
    const db = fixture();
    const input = {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-cli-a",
      createdAt: CREATED_AT,
    };
    expect(() => sealGovernedLearningCorpus(db, input)).toThrow("learning_corpus_active_consent_required");
    grantLearningConsent(db, {
      id: "consent-a",
      tenantId: "tenant-a",
      consentVersion: 1,
      purpose: PURPOSE,
      residencyRegion: "us-central",
      authorizedByPrincipalId: "human-a",
      effectiveAt: "2026-08-14T18:00:00.000Z",
      reason: "Seal governed adapter training under consent.",
      idempotencyKey: "consent-a",
      createdAt: CREATED_AT,
    });
    // The sealer itself refuses an empty dataset. Reaching this error means the
    // worker command called the real pipeline operation, not a stub.
    expect(() => sealGovernedLearningCorpus(db, input)).toThrow("learning_dataset_empty");
  });
});
