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

const DEFAULT_ROOT = resolve("C:/Users/Talal/dev");

describe("corpus-root resolver", () => {
  const original = process.env.MENDPOINT_CORPUS_ROOT;

  afterEach(() => {
    if (original === undefined) delete process.env.MENDPOINT_CORPUS_ROOT;
    else process.env.MENDPOINT_CORPUS_ROOT = original;
    vi.resetModules();
  });

  it("treats the empty string (unset repository variable) as unset, not as process.cwd()", async () => {
    // GitHub Actions substitutes "" for an unset `vars.MENDPOINT_CORPUS_ROOT`.
    // `resolve(process.env.X ?? default)` would let "" survive and collapse onto
    // process.cwd() (the checkout root) — the footgun this guards against.
    const mod = await loadCorpusRoot("");
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(false);
    expect(mod.CORPUS_ROOT).toBe(DEFAULT_ROOT);
    expect(mod.CORPUS_ROOT).not.toBe(resolve("")); // resolve("") === process.cwd()
  });

  it("treats a whitespace-only value as unset", async () => {
    const mod = await loadCorpusRoot("   ");
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(false);
    expect(mod.CORPUS_ROOT).toBe(DEFAULT_ROOT);
  });

  it("falls back to the default when the variable is absent", async () => {
    const mod = await loadCorpusRoot(undefined);
    expect(mod.CORPUS_ROOT_CONFIGURED).toBe(false);
    expect(mod.CORPUS_ROOT).toBe(DEFAULT_ROOT);
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
