/**
 * Single source of truth for the synthetic-corpus root.
 *
 * Corpus repos live OUTSIDE this git repo (default `C:/Users/Talal/dev`), so a
 * run cannot accidentally read a repo's own ground truth.
 *
 * A GitHub-hosted runner passes `MENDPOINT_CORPUS_ROOT: ${{ vars.MENDPOINT_CORPUS_ROOT }}`,
 * which is the EMPTY STRING when the repository variable is unset — not undefined.
 * `?? default` only falls back on null/undefined, so an empty string would survive
 * and `resolve("")` collapses to `process.cwd()` (the repo root), silently pointing
 * the corpus at the repository under test. That footgun took the nightly eval down
 * for four nights (via `evals/scenarios/index.ts`) and would misgrade the corpus
 * (via `scripts/impact-grade.ts`). Treat an empty or whitespace-only value as unset
 * so it degrades to the default / clean skip instead.
 *
 * Both readers resolve the variable through here so they cannot diverge again —
 * two divergent handlings of this one variable is how the footgun survived twice.
 */
import { resolve } from "node:path";

const corpusRootEnv = process.env.MENDPOINT_CORPUS_ROOT?.trim();

/** True when an operator explicitly configured a corpus root via the environment. */
export const CORPUS_ROOT_CONFIGURED = corpusRootEnv !== undefined && corpusRootEnv.length > 0;

/** Root under which the synthetic corpus repositories live. */
export const CORPUS_ROOT = resolve(
  CORPUS_ROOT_CONFIGURED ? corpusRootEnv! : "C:/Users/Talal/dev",
);
