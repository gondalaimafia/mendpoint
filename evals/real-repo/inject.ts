/**
 * Real-repository harness — the injector.
 *
 * The "injection" is a PROVIDER-side change, expressed the way Fettler consumes
 * it: an OpenAPI v1 -> v2 diff. It is deliberately NOT a mutation of the cloned
 * repository. The whole point of this harness is to test the product against
 * code it did not write, so the injector must never author the call sites it
 * grades — that would reproduce exactly the synthetic self-grading this harness
 * exists to escape. Instead the injector:
 *
 *   1. Records the change in a sealed answer key (`answer-key/*.json`): the
 *      provider delta, and the pre-existing real call sites the change impacts,
 *      hand-derived from the repository source with grep, never from any product
 *      output.
 *   2. Proves the spec pair encodes EXACTLY that recorded change (a breaking
 *      removal of the declared endpoint, plus its declared successor), so the
 *      specs cannot silently drift away from the answer key's description.
 *   3. Enforces that the sealed answer key is unreachable from the repository the
 *      product will stage and read.
 *
 * None of this reads product output, so nothing here can flatter the result.
 */
import { readFileSync } from "node:fs";
import { normalizeChange } from "@mendpoint/change-intel";
import type { ImpactableSurface } from "@mendpoint/shared";
import { validateGroundTruth, type GroundTruth } from "../ground-truth/schema.js";
import { isInside } from "../runners/isolation.js";
import type { RealRepoManifest } from "./manifest.js";

/** One recorded pre-existing call site the injected change impacts. */
export interface ImpactedCallSite {
  file: string;
  symbol: string;
  line: number;
}

/** The provider delta the injection encodes, recorded for the report. */
export interface InjectedChange {
  kind: "endpoint_removed";
  method: string;
  path: string;
  superseded_by: { method: string; path: string };
  provider_slug: string;
  spec_v1: string;
  spec_v2: string;
}

/**
 * The sealed answer key: the standard {@link GroundTruth} shape plus the
 * provenance fields that record what the injection changed and where.
 */
export type SealedAnswerKey = GroundTruth & {
  injected_change: InjectedChange;
  impacted_call_sites: ImpactedCallSite[];
};

/** Load and validate the sealed answer key. Throws loudly on any malformation. */
export function loadSealedAnswerKey(manifest: RealRepoManifest): SealedAnswerKey {
  const raw = JSON.parse(readFileSync(manifest.answerKeyPath, "utf8")) as unknown;
  const problems = validateGroundTruth(raw);
  if (problems.length) {
    throw new Error(
      `sealed answer key ${manifest.scenarioId} invalid:\n  - ${problems.join("\n  - ")}`,
    );
  }
  const key = raw as SealedAnswerKey;
  if (key.scenario_id !== manifest.scenarioId) {
    throw new Error(
      `answer key scenario_id ${key.scenario_id} does not match manifest ${manifest.scenarioId}`,
    );
  }
  if (!key.injected_change || !Array.isArray(key.impacted_call_sites)) {
    throw new Error(
      `answer key ${manifest.scenarioId} is missing injected_change / impacted_call_sites provenance`,
    );
  }
  return key;
}

/** Parse the two provider contracts and produce the change surfaces Fettler consumes. */
export function loadInjectedSurfaces(manifest: RealRepoManifest): {
  surfaces: ImpactableSurface[];
} {
  const oldSpec = JSON.parse(readFileSync(manifest.specV1Path, "utf8"));
  const newSpec = JSON.parse(readFileSync(manifest.specV2Path, "utf8"));
  const { surfaces } = normalizeChange(oldSpec, newSpec, {
    providerSlug: manifest.providerSlug,
  });
  return { surfaces };
}

/**
 * Prove the spec pair encodes exactly the change the sealed key describes: the
 * declared endpoint is removed and the removal is breaking, and the declared
 * successor endpoint is added. This is an integrity check on the INJECTION (does
 * it match its own recorded description?), not on the product — it reads no
 * product output. Returns the surfaces so the caller can reuse them.
 */
export function assertInjectionMatchesKey(
  manifest: RealRepoManifest,
  key: SealedAnswerKey,
): ImpactableSurface[] {
  const { surfaces } = loadInjectedSurfaces(manifest);
  const change = key.injected_change;

  const removed = surfaces.find(
    (s) => s.op === "path_removed" && s.path === change.path,
  );
  if (!removed) {
    throw new Error(
      `injection integrity: expected a path_removed surface for ${change.path}, ` +
        `got ops [${surfaces.map((s) => `${s.op} ${s.path ?? ""}`.trim()).join(", ")}]`,
    );
  }
  if (removed.severity !== "breaking") {
    throw new Error(
      `injection integrity: removal of ${change.path} must be breaking, got ${removed.severity}`,
    );
  }
  const added = surfaces.find(
    (s) => s.op === "path_added" && s.path === change.superseded_by.path,
  );
  if (!added) {
    throw new Error(
      `injection integrity: expected a path_added surface for the successor ${change.superseded_by.path}`,
    );
  }
  return surfaces;
}

/**
 * Defence-in-depth on top of the corpus-run isolation guard: assert the sealed
 * answer key does not resolve inside the repository tree the product will stage
 * and read. A leaked answer key would make every number meaningless.
 */
export function assertAnswerKeyUnreachable(
  manifest: RealRepoManifest,
  repoUnderTest: string,
): void {
  if (isInside(repoUnderTest, manifest.answerKeyPath)) {
    throw new Error(
      `answer-key isolation violated: sealed key\n  ${manifest.answerKeyPath}\n` +
        `resolves inside the repository under test\n  ${repoUnderTest}\n` +
        `The product would be able to read its own answer key off disk.`,
    );
  }
}
