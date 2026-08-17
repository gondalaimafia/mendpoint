/**
 * Shared types for procedurally-generated scenarios.
 *
 * A generated scenario carries its repository IN MEMORY (never on the shared
 * corpus) plus a full, validated {@link GroundTruth}. The driver materializes it
 * to scratch just before running and cleans it up after.
 */
import type { GroundTruth, Product } from "../ground-truth/schema.js";
import type { SyntheticRepo } from "../mutations/engine.js";

export interface GeneratedScenario {
  scenario_id: string;
  product: Product;
  /** Provider slug hint for the Fettler path (Fettler scenarios only). */
  slug?: string;
  /** In-memory repository (files + optional OpenAPI spec pair). */
  repo: SyntheticRepo;
  /** Full answer key; `dataset_split` lives here. */
  gt: GroundTruth;
}
