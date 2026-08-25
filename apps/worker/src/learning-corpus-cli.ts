/**
 * Live worker entry for sealing a governed learning dataset version (H3).
 *
 * `materializeGovernedLearningCorpus` already exists in the pipeline and is
 * what actually admits records, writes split artifacts, and seals the version.
 * Nothing in the worker CLI called it, so the sealer was latent. This module
 * is that caller. It does not train, does not invent `organization_memory`
 * routing, and does not fabricate verification — it only seals what consent
 * and the existing eligibility gate already allow.
 */
import { materializeGovernedLearningCorpus, type MaterializeGovernedLearningCorpusInput } from "@mendpoint/pipeline";
import { nowIso } from "@mendpoint/shared";
import type { AppDb } from "@mendpoint/db";

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredFlag(argv: string[], name: string, envValue: string | undefined, code: string): string {
  const value = (flag(argv, name) ?? envValue ?? "").trim();
  if (!value) throw new Error(code);
  return value;
}

function isoTimestamp(value: string, code: string): string {
  try {
    if (new Date(value).toISOString() === value) return value;
  } catch {
    /* invalid */
  }
  throw new Error(code);
}

/** Parse `worker learning-corpus` flags. Missing required flags fail closed. */
export function parseLearningCorpusArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): MaterializeGovernedLearningCorpusInput {
  return {
    tenantId: requiredFlag(argv, "--tenant", env.MENDPOINT_TENANT_ID, "learning_corpus_tenant_required"),
    purpose: requiredFlag(argv, "--purpose", undefined, "learning_corpus_purpose_required"),
    temporalCutoffAt: isoTimestamp(
      requiredFlag(argv, "--cutoff", undefined, "learning_corpus_cutoff_required"),
      "learning_corpus_cutoff_invalid",
    ),
    actorPrincipalId: requiredFlag(argv, "--actor", undefined, "learning_corpus_actor_required"),
    idempotencyKey: requiredFlag(
      argv,
      "--idempotency-key",
      undefined,
      "learning_corpus_idempotency_key_required",
    ),
    createdAt: isoTimestamp(
      (flag(argv, "--created-at") ?? nowIso()).trim(),
      "learning_corpus_created_at_invalid",
    ),
  };
}

/** Seal one governed corpus version through the existing pipeline operation. */
export function sealGovernedLearningCorpus(
  db: AppDb,
  input: MaterializeGovernedLearningCorpusInput,
) {
  return materializeGovernedLearningCorpus(db, input);
}
