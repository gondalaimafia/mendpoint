import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeImpactWithSoftwareGraph } from "@mendpoint/code-impact";
import {
  openGraphLearnMemory,
  runChangeGraphRepresentationBenchmark,
  type ChangeGraphBenchmarkScenario,
} from "@mendpoint/graph-learn";
import type { ImpactableSurface } from "@mendpoint/shared";
import { createChangeGraphLiveGenerator } from "../packages/eval/src/change-graph-live-generator.js";

type Split = ChangeGraphBenchmarkScenario["split"];
type SyntheticDescriptor = Readonly<{
  id: string;
  split: Split;
  indirect: boolean;
  resource: string;
  observedAt: string;
}>;

const DESCRIPTORS: readonly SyntheticDescriptor[] = Object.freeze([
  { id: "dev-direct", split: "development", indirect: false, resource: "messages", observedAt: "2026-08-18T00:00:00.000Z" },
  { id: "dev-indirect", split: "development", indirect: true, resource: "calls", observedAt: "2026-08-18T00:01:00.000Z" },
  { id: "validation-direct", split: "validation", indirect: false, resource: "recordings", observedAt: "2026-08-18T00:02:00.000Z" },
  { id: "validation-indirect", split: "validation", indirect: true, resource: "conferences", observedAt: "2026-08-18T00:03:00.000Z" },
  { id: "holdout-direct", split: "holdout", indirect: false, resource: "transcriptions", observedAt: "2026-08-18T00:04:00.000Z" },
  { id: "holdout-indirect", split: "holdout", indirect: true, resource: "notifications", observedAt: "2026-08-18T00:05:00.000Z" },
]);

const codeUnitCompare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function scenarioFiles(descriptor: SyntheticDescriptor): Record<string, string> {
  const title = descriptor.resource[0]!.toUpperCase() + descriptor.resource.slice(1);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: `change-graph-${descriptor.id}`,
      private: true,
      dependencies: { twilio: "4.0.0" },
    }),
    "src/client.ts": [
      'import twilio from "twilio";',
      `export async function create${title}(value: string) {`,
      `  return twilio.${descriptor.resource}.create({ value });`,
      "}",
    ].join("\n"),
    "src/unrelated.ts": [
      `export const note = "${descriptor.resource}.create is mentioned in documentation only";`,
      "export function unrelated() { return note.length; }",
    ].join("\n"),
  };
  if (descriptor.indirect) {
    files["src/wrapper.ts"] = [
      `import { create${title} } from "./client";`,
      `export async function wrap${title}(value: string) {`,
      `  return create${title}(value);`,
      "}",
    ].join("\n");
    files["src/service.ts"] = [
      `import { wrap${title} } from "./wrapper";`,
      `export async function run${title}Service(value: string) {`,
      `  return wrap${title}(value);`,
      "}",
    ].join("\n");
    files["test/service.test.ts"] = [
      `import { run${title}Service } from "../src/service";`,
      `export async function test${title}Service() {`,
      `  return run${title}Service("value");`,
      "}",
    ].join("\n");
  } else {
    files["test/client.test.ts"] = [
      `import { create${title} } from "../src/client";`,
      `export async function testCreate${title}() {`,
      `  return create${title}("value");`,
      "}",
    ].join("\n");
  }
  return files;
}

function writeScenario(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, ...path.split("/"));
    mkdirSync(resolve(destination, ".."), { recursive: true });
    writeFileSync(destination, content, { encoding: "utf8", flag: "wx" });
  }
}

async function buildScenario(descriptor: SyntheticDescriptor): Promise<ChangeGraphBenchmarkScenario> {
  const root = mkdtempSync(join(tmpdir(), `mendpoint-change-graph-${descriptor.id}-`));
  const graphDb = openGraphLearnMemory();
  try {
    const files = scenarioFiles(descriptor);
    writeScenario(root, files);
    const method = "POST";
    const path = `/v1/${descriptor.resource}`;
    const surface: ImpactableSurface = {
      id: `surface-${descriptor.id}`,
      canonicalId: `twilio.${method}.${path}.request_field_renamed.value.payload`,
      kind: "request_field",
      op: "request_field_renamed",
      path,
      method,
      field: "value",
      fromField: "value",
      toField: "payload",
      severity: "breaking",
      migrationStrategy: "Rename value to payload",
      explanation: `The provider renamed the ${descriptor.resource} request field`,
      searchTokens: [descriptor.resource, "create", "value", "payload"],
    };
    const analyzed = await analyzeImpactWithSoftwareGraph(root, [surface], {
      graphDb,
      tenantId: "tenant-change-graph-benchmark",
      repositoryId: `repository-${descriptor.id}`,
      providerId: "twilio",
      providerSnapshotId: `provider-snapshot-${descriptor.id}`,
      providerRevision: "2026-08-18",
      providerSdkPackage: "twilio",
      providerSdkVersion: "4.0.0",
      providerEvidenceRefs: [`synthetic-provider-spec:${descriptor.id}`],
      observedAt: descriptor.observedAt,
      maxCallerHops: 8,
      maxContextBytes: 32_768,
      impact: { persistIndex: false },
    });
    const rawContext = [
      `Changed provider endpoint: ${method} ${path}`,
      "Changed request field: value to payload",
      ...Object.entries(files)
        .filter(([file]) => file.endsWith(".ts"))
        .sort(([left], [right]) => codeUnitCompare(left, right))
        .flatMap(([file, content]) => [`FILE ${file}`, content]),
    ].join("\n\n");
    const expectedEntityIds = Object.keys(files)
      .filter((file) => file !== "package.json" && file !== "src/unrelated.ts")
      .sort(codeUnitCompare);
    return {
      id: descriptor.id,
      split: descriptor.split,
      splitGroupId: `synthetic:${descriptor.id}:provider-request-field-rename`,
      indirect: descriptor.indirect,
      task: [
        `For ${method} ${path}, return every repository relative source or test file on the active call path`,
        "from the provider SDK call through its repository callers and covering test.",
        "Exclude files that only mention the endpoint in prose or unrelated constants.",
      ].join(" "),
      expectedEntityIds,
      rawContext,
      graphContext: analyzed.context.content,
    };
  } finally {
    graphDb.raw.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function buildSyntheticChangeGraphCohort(): Promise<ChangeGraphBenchmarkScenario[]> {
  const scenarios: ChangeGraphBenchmarkScenario[] = [];
  for (const descriptor of DESCRIPTORS) scenarios.push(await buildScenario(descriptor));
  return scenarios;
}

export async function runChangeGraphLiveBenchmark(): Promise<unknown> {
  const scenarios = await buildSyntheticChangeGraphCohort();
  const runtime = createChangeGraphLiveGenerator();
  const report = await runChangeGraphRepresentationBenchmark({
    benchmarkId: "mendpoint-change-graph-synthetic-v1",
    generatorId: runtime.snapshot().model,
    scenarios,
    generator: runtime.generator,
  });
  return Object.freeze({ report, modelEvidence: runtime.snapshot() });
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  runChangeGraphLiveBenchmark()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
