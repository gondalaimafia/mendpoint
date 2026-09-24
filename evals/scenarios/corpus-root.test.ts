import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

/**
 * The corpus root is resolved at module load from MENDPOINT_CORPUS_ROOT, so each
 * case loads a fresh copy of the module under a specific environment value.
 */
async function loadCorpusRoot(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.MENDPOINT_CORPUS_ROOT;
  else process.env.MENDPOINT_CORPUS_ROOT = value;
  return import("./corpus-root.js");
}

// The unavailable sentinel: an absolute path outside the repo that does not
// exist. Deliberately NOT a developer path and NOT process.cwd().
const UNAVAILABLE = resolve("/mendpoint-corpus-unavailable");
const REPO_ROOT = resolve(__dirname, "..", "..");

describe("corpus-root resolver", () => {
  const original = process.env.MENDPOINT_CORPUS_ROOT;

  afterEach(() => {
    if (original === undefined) delete process.env.MENDPOINT_CORPUS_ROOT;
    else process.env.MENDPOINT_CORPUS_ROOT = original;
    vi.resetModules();
  });

  it("treats the empty string (unset repository variable) as unavailable, not as process.cwd()", async () => {
    // GitHub Actions substitutes "" for an unset `vars.MENDPOINT_CORPUS_ROOT`.
    // `resolve(process.env.X ?? default)` would let "" survive and collapse onto
    // process.cwd() (the checkout root) — the footgun this guards against.
    const mod = await loadCorpusRoot("");
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(false);
    expect(mod.CORPUS_ROOT).toBe(UNAVAILABLE);
    expect(mod.CORPUS_ROOT).not.toBe(resolve("")); // resolve("") === process.cwd()
  });

  it("treats a whitespace-only value as unavailable", async () => {
    const mod = await loadCorpusRoot("   ");
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(false);
    expect(mod.CORPUS_ROOT).toBe(UNAVAILABLE);
  });

  it("resolves to the unavailable sentinel when the variable is absent — no developer-path default", async () => {
    const mod = await loadCorpusRoot(undefined);
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(false);
    expect(mod.CORPUS_ROOT).toBe(UNAVAILABLE);
    // The sentinel is what CORPUS_ROOT exposes when unavailable.
    expect(mod.CORPUS_ROOT).toBe(mod.CORPUS_ROOT_UNAVAILABLE);
  });

  it("never falls back to a developer path or inside the repo when unavailable", async () => {
    const mod = await loadCorpusRoot(undefined);
    // The old default was a specific developer's Windows checkout; guard against
    // any such path reappearing, and against collapsing inside the repo tree.
    expect(mod.CORPUS_ROOT.replace(/\\/g, "/")).not.toContain("Users/Talal");
    expect(mod.CORPUS_ROOT.startsWith(REPO_ROOT)).toBe(false);
  });

  it("honors an explicitly configured corpus root", async () => {
    const mod = await loadCorpusRoot("/home/dev/corpus");
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(true);
    expect(mod.CORPUS_ROOT).toBe(resolve("/home/dev/corpus"));
  });

  it("trims surrounding whitespace from a configured value", async () => {
    const mod = await loadCorpusRoot("  /home/dev/corpus  ");
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(true);
    expect(mod.CORPUS_ROOT).toBe(resolve("/home/dev/corpus"));
  });
});
