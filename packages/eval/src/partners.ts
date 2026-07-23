/**
 * Design-partner style eval corpus — multi-repo fixtures with expected sites.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export type PartnerCase = {
  id: string;
  name: string;
  consumerPath: string;
  /** openapi pair under fixtures/providers or synthetic event */
  kind: "openapi" | "event";
  openapiDir?: string;
  eventPath?: string;
  expected: Array<{ fileIncludes: string; symbolIncludes: string }>;
  /** Migration must edit at least this many files when findings exist */
  minEditedFiles?: number;
};

export const PARTNER_CASES: PartnerCase[] = [
  {
    id: "dp-shop-acme",
    name: "Shop app × Acme payments (TS)",
    consumerPath: join(root, "fixtures/consumers/shop-app"),
    kind: "openapi",
    openapiDir: join(root, "fixtures/providers/acme-payments"),
    expected: [
      { fileIncludes: "payments", symbolIncludes: "amount_cents" },
      { fileIncludes: "payments", symbolIncludes: "charges" },
    ],
    minEditedFiles: 1,
  },
  {
    id: "dp-stripe-pagination",
    name: "Stripe pagination consumer",
    consumerPath: join(root, "fixtures/examples/01-stripe-pagination/consumer"),
    kind: "event",
    eventPath: join(root, "fixtures/examples/01-stripe-pagination/change-event.json"),
    expected: [
      { fileIncludes: ".ts", symbolIncludes: "starting_after" },
    ],
    minEditedFiles: 0,
  },
  {
    id: "dp-openai-python",
    name: "OpenAI Python consumer",
    consumerPath: join(root, "fixtures/examples/02-openai-chat/consumer"),
    kind: "event",
    eventPath: join(root, "fixtures/examples/02-openai-chat/change-event.json"),
    expected: [
      { fileIncludes: ".py", symbolIncludes: "max_tokens" },
    ],
    minEditedFiles: 0,
  },
  {
    id: "dp-go-stripe",
    name: "Go Stripe consumer",
    consumerPath: join(root, "fixtures/examples/06-go-stripe/consumer"),
    kind: "event",
    eventPath: join(root, "fixtures/examples/06-go-stripe/change-event.json"),
    expected: [
      { fileIncludes: "billing.go", symbolIncludes: "StartingAfter" },
    ],
    minEditedFiles: 0,
  },
  {
    id: "dp-java-stripe",
    name: "Java Stripe consumer",
    consumerPath: join(root, "fixtures/examples/07-java-stripe/consumer"),
    kind: "event",
    eventPath: join(root, "fixtures/examples/07-java-stripe/change-event.json"),
    expected: [
      { fileIncludes: "StripeBilling.java", symbolIncludes: "startingAfter" },
    ],
    minEditedFiles: 0,
  },
];

export function loadOpenApiPair(dir: string) {
  return {
    v1: JSON.parse(readFileSync(join(dir, "openapi-v1.json"), "utf8")),
    v2: JSON.parse(readFileSync(join(dir, "openapi-v2.json"), "utf8")),
    notes: (() => {
      try {
        return readFileSync(join(dir, "changelog.md"), "utf8");
      } catch {
        return "";
      }
    })(),
  };
}
