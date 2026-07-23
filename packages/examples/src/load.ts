import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangeEvent, ExampleManifest } from "./types.js";

export function examplesRoot(): string {
  // packages/examples/src → repo fixtures/examples
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../fixtures/examples");
}

function findConsumerDir(exampleDir: string): string {
  const direct = join(exampleDir, "consumer");
  if (existsSync(direct)) return direct;
  return exampleDir;
}

export function listExamples(): ExampleManifest[] {
  const root = examplesRoot();
  if (!existsSync(root)) return [];
  const out: ExampleManifest[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const eventPath = join(dir, "change-event.json");
    if (!existsSync(eventPath)) continue;
    const changeEvent = JSON.parse(readFileSync(eventPath, "utf8")) as ChangeEvent;
    out.push({
      id: name,
      dir,
      title: changeEvent.title,
      vendor: changeEvent.vendor,
      changeType: changeEvent.type,
      consumerPath: findConsumerDir(dir),
      changeEvent,
    });
  }
  return out;
}

export function loadExpectedPr(exampleDir: string): string | null {
  const p = join(exampleDir, "expected-pr.md");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}
