/**
 * Single source of truth for the synthetic-corpus root.
 *
 * Corpus repos live OUTSIDE this git repo, so a run cannot accidentally read a
 * repo's own ground truth. An operator points a run at them by setting
 * MENDPOINT_CORPUS_ROOT; when it is unset the corpus is simply UNAVAILABLE.
 *
 * There is deliberately NO path default. The previous fallback was a specific
 * developer's Windows checkout (`C:/Users/Talal/dev`): on that machine a run read
 * a live corpus while presenting as "unconfigured", and on a Linux runner
 * `resolve("C:/Users/Talal/dev")` collapsed to a repo-internal path — so the
 * nightly "full corpus" job looked green while it had actually skipped every
 * corpus scenario. Absence now resolves to an explicit unavailable sentinel that
 * is outside the repo and does not exist, so corpus scenarios cleanly skip
 * (existsSync is false) and the isolation invariant still holds.
 *
 * A GitHub-hosted runner passes `MENDPOINT_CORPUS_ROOT: ${{ vars.MENDPOINT_CORPUS_ROOT }}`,
 * which is the EMPTY STRING when the repository variable is unset — not undefined.
 * An empty or whitespace-only value is treated as unset (the same "unavailable"
 * path), never as `process.cwd()`.
 *
 * Both readers (`evals/scenarios/index.ts` and `scripts/impact-grade.ts`) resolve
 * the variable through here so they cannot diverge again.
 */
import { resolve } from "node:path";

const corpusRootEnv = process.env.MENDPOINT_CORPUS_ROOT?.trim();

/** True when an operator explicitly configured a corpus root via the environment. */
export const CORPUS_ROOT_CONFIGURED = corpusRootEnv !== undefined && corpusRootEnv.length > 0;

/**
 * Sentinel used when no corpus root is configured. It is NOT a real location on
 * any machine and no corpus ever lives here: it is absolute, resolves outside the
 * repo, and does not exist, so every corpus scenario skips and answer-key
 * isolation holds. `CORPUS_ROOT_CONFIGURED` — never this value — is the signal
 * that an operator supplied a corpus.
 */
export const CORPUS_ROOT_UNAVAILABLE = resolve("/mendpoint-corpus-unavailable");

/** Root under which the synthetic corpus repositories live, or the sentinel above when unavailable. */
export const CORPUS_ROOT = CORPUS_ROOT_CONFIGURED
  ? resolve(corpusRootEnv!)
  : CORPUS_ROOT_UNAVAILABLE;
