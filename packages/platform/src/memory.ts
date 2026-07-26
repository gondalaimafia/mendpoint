/**
 * Four-layer memory (Devin-style) shared by Warden + Transformer.
 * Full trajectory is never re-fed; hard pruning at step boundaries.
 */
export type MemoryLayer = "working" | "step_summary" | "scratchpad" | "knowledge";

export type MemoryEntry = {
  id: string;
  layer: MemoryLayer;
  text: string;
  tags?: string[];
  createdAt: number;
  step?: number;
};

export type AgentMemory = {
  working: MemoryEntry[];
  stepSummaries: MemoryEntry[];
  scratchpad: MemoryEntry[];
  knowledge: MemoryEntry[];
};

let _seq = 0;
function mid() {
  return `m${++_seq}_${Date.now()}`;
}

export function createMemory(): AgentMemory {
  return { working: [], stepSummaries: [], scratchpad: [], knowledge: [] };
}

export function remember(
  mem: AgentMemory,
  layer: MemoryLayer,
  text: string,
  opts?: { tags?: string[]; step?: number },
): AgentMemory {
  const entry: MemoryEntry = {
    id: mid(),
    layer,
    text: text.slice(0, 4000),
    tags: opts?.tags,
    createdAt: Date.now(),
    step: opts?.step,
  };
  const next = { ...mem };
  if (layer === "working") next.working = [...mem.working, entry];
  else if (layer === "step_summary") next.stepSummaries = [...mem.stepSummaries, entry];
  else if (layer === "scratchpad") next.scratchpad = [...mem.scratchpad, entry];
  else next.knowledge = [...mem.knowledge, entry];
  return pruneMemory(next);
}

/** Hard prune at step boundaries — working window slim, summaries capped. */
export function pruneMemory(
  mem: AgentMemory,
  limits = { working: 12, stepSummaries: 40, scratchpad: 20, knowledge: 100 },
): AgentMemory {
  return {
    working: mem.working.slice(-limits.working),
    stepSummaries: mem.stepSummaries.slice(-limits.stepSummaries),
    scratchpad: mem.scratchpad.slice(-limits.scratchpad),
    knowledge: mem.knowledge.slice(-limits.knowledge),
  };
}

/** Material for planner prompt — never full trajectory. */
export function memoryForPlanner(mem: AgentMemory, maxChars = 6000): string {
  const parts: string[] = [];
  if (mem.knowledge.length) {
    parts.push("## Knowledge");
    for (const k of mem.knowledge.slice(-15)) {
      parts.push(`- [${(k.tags ?? []).join(",")}] ${k.text}`);
    }
  }
  if (mem.stepSummaries.length) {
    parts.push("## Step summaries");
    for (const s of mem.stepSummaries.slice(-20)) {
      parts.push(`- step ${s.step ?? "?"}: ${s.text}`);
    }
  }
  if (mem.working.length) {
    parts.push("## Working");
    for (const w of mem.working.slice(-8)) parts.push(`- ${w.text}`);
  }
  let out = parts.join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}

export function retrieveKnowledge(
  mem: AgentMemory,
  query: string,
  limit = 5,
): MemoryEntry[] {
  const q = query.toLowerCase();
  const scored = mem.knowledge.map((k) => {
    const hay = `${k.text} ${(k.tags ?? []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const tok of q.split(/\s+/).filter(Boolean)) {
      if (hay.includes(tok)) score += 1;
    }
    return { k, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.k);
}
