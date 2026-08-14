/**
 * Explicit Knowledge store — tagged snippets for planner prompts.
 * Seed API style guide (Warden) and migration playbooks (Transformer).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentMemory } from "./memory.js";
import { remember } from "./memory.js";

export type KnowledgeDoc = {
  id: string;
  title: string;
  tags: string[];
  body: string;
};

export const DEFAULT_API_STYLE_GUIDE: KnowledgeDoc = {
  id: "api-style-guide-v1",
  title: "Mendpoint / Fettler API style guide",
  tags: ["warden", "style-guide", "api"],
  body: [
    "Version APIs via /vN/ path or documented version header.",
    "POST/PUT mutating endpoints should support Idempotency-Key.",
    "List endpoints must paginate (cursor or page+limit).",
    "Document 4xx error responses with stable error codes.",
    "Prefer additive non-breaking changes; renames require consumer registry check.",
    "Never auto-merge consumer PRs; human review required by default.",
    "Auth: Bearer or documented API key schemes only; no secrets in URLs.",
  ].join("\n"),
};

export const DEFAULT_MIGRATION_PLAYBOOK: KnowledgeDoc = {
  id: "playbook-generic-v1",
  title: "Generic migration playbook",
  tags: ["transformer", "playbook", "migration"],
  body: [
    "Extract Behavioral Specification Graph before code moves.",
    "Split work into PR-sized DAG units with explicit dependsOn.",
    "Prove parity via differential traces, not only unit tests.",
    "Use feature flags for pre/post coexistence when needed.",
    "One agent per repo; share learnings file across campaign.",
    "Human review on every PR; promote playbook refinements with review gate.",
  ].join("\n"),
};

export function loadKnowledgeFromDir(dir: string): KnowledgeDoc[] {
  const out: KnowledgeDoc[] = [];
  const guide = join(dir, "api-style-guide.md");
  if (existsSync(guide)) {
    out.push({
      id: "api-style-guide-file",
      title: "API style guide (file)",
      tags: ["warden", "style-guide"],
      body: readFileSync(guide, "utf8").slice(0, 8000),
    });
  }
  const play = join(dir, "migration-playbook.md");
  if (existsSync(play)) {
    out.push({
      id: "migration-playbook-file",
      title: "Migration playbook (file)",
      tags: ["transformer", "playbook"],
      body: readFileSync(play, "utf8").slice(0, 8000),
    });
  }
  return out;
}

export function seedMemoryForAgent(
  agent: "warden" | "transformer",
  mem: AgentMemory,
  knowledgeDir?: string,
): AgentMemory {
  let m = mem;
  if (agent === "warden") {
    m = remember(m, "knowledge", DEFAULT_API_STYLE_GUIDE.body, {
      tags: DEFAULT_API_STYLE_GUIDE.tags,
    });
  } else {
    m = remember(m, "knowledge", DEFAULT_MIGRATION_PLAYBOOK.body, {
      tags: DEFAULT_MIGRATION_PLAYBOOK.tags,
    });
  }
  if (knowledgeDir) {
    for (const d of loadKnowledgeFromDir(knowledgeDir)) {
      m = remember(m, "knowledge", d.body, { tags: d.tags });
    }
  }
  return m;
}

/**
 * Capture a human PR fix-up as a candidate style/playbook refinement (explicit only).
 */
export function captureFixup(
  mem: AgentMemory,
  text: string,
  tags: string[],
): AgentMemory {
  return remember(mem, "knowledge", `fixup: ${text}`, {
    tags: [...tags, "human-fixup", "needs-review"],
  });
}
