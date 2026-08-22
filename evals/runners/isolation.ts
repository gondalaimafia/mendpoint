/**
 * Answer-key isolation invariant (spec §18.3, a MUST).
 *
 * The suite's honesty depends on the corpus-under-test living OUTSIDE the repo
 * that contains the answer keys (`evals/ground-truth/*.json`). Historically that
 * held only because the corpus happened to sit at a developer path outside the
 * tree — a default, not an invariant. This asserts it: if `CORPUS_ROOT` ever
 * resolves inside `REPO_ROOT`, a product staged from the corpus could read the
 * ground truth off disk and every number after that is worthless. Committing the
 * corpus, or a misconfigured `MENDPOINT_CORPUS_ROOT`, must fail loudly here rather
 * than silently poison the run.
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

export class CorpusIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusIsolationError";
  }
}

/** True when `child` is the same as, or nested inside, `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  // Empty means identical; a `..` prefix means it escapes upward; an absolute
  // result (e.g. a different Windows drive) means it is unrelated.
  return rel === "" || (!rel.startsWith("..") && !isAbsoluteRel(rel));
}

function isAbsoluteRel(rel: string): boolean {
  // `path.relative` returns an absolute path only when the two live on different
  // Windows drives; on POSIX it never does.
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(rel);
}

/**
 * Throw unless the corpus root resolves strictly outside the repo root. Returns
 * void on success so callers can assert-and-continue.
 */
export function assertCorpusIsolation(corpusRoot: string, repoRoot: string): void {
  if (isInside(repoRoot, corpusRoot)) {
    throw new CorpusIsolationError(
      `answer-key isolation violated: corpus root\n  ${resolve(corpusRoot)}\nresolves inside the repo root\n  ${resolve(repoRoot)}\n` +
        `The corpus under test must live outside the tree that holds evals/ground-truth so a staged product cannot read its own answer key. ` +
        `Set MENDPOINT_CORPUS_ROOT to a path outside the repo, or keep the corpus external.`,
    );
  }
}

/**
 * Assert answer-key isolation for a whole run, without mis-firing on a runner
 * that simply has no corpus.
 *
 * The invariant that matters is: every corpus repo the product will actually
 * STAGE and read must resolve outside the tree holding evals/ground-truth. So:
 *
 *  - If an operator explicitly configured a corpus root (`configured`), hold it
 *    to the invariant loudly even before any scenario dir materializes — a
 *    MENDPOINT_CORPUS_ROOT pointing inside the tree is a misconfiguration.
 *  - Always assert over the corpus repos that actually EXIST on disk (the ones a
 *    run will stage). A corpus committed into the tree fails here.
 *
 * A GitHub-hosted runner with no corpus (no env, no scenario dirs present) has
 * nothing to assert and degrades cleanly to the generated suite, instead of the
 * old behaviour where an empty/default root collapsed onto the repo root and
 * threw. This never weakens the check: any corpus that could actually leak its
 * answer key still fails loudly.
 */
export function assertCorpusRunIsolation(args: {
  corpusRoot: string;
  configured: boolean;
  corpusRepoPaths: readonly string[];
  repoRoot: string;
  exists?: (p: string) => boolean;
}): void {
  const exists = args.exists ?? existsSync;
  if (args.configured) assertCorpusIsolation(args.corpusRoot, args.repoRoot);
  for (const repoPath of args.corpusRepoPaths) {
    if (exists(repoPath)) assertCorpusIsolation(repoPath, args.repoRoot);
  }
}
