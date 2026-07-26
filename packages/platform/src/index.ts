export type { MemoryLayer, MemoryEntry, AgentMemory } from "./memory.js";
export {
  createMemory,
  remember,
  pruneMemory,
  memoryForPlanner,
  retrieveKnowledge,
} from "./memory.js";

export type { SandboxKind, MockUpstream, SandboxHandle, CreateSandboxOpts } from "./sandbox.js";
export {
  createSandbox,
  sandboxManifest,
  RUNTIME_MATRIX,
} from "./sandbox.js";

export type { KnowledgeDoc } from "./knowledge.js";
export {
  DEFAULT_API_STYLE_GUIDE,
  DEFAULT_MIGRATION_PLAYBOOK,
  loadKnowledgeFromDir,
  seedMemoryForAgent,
  captureFixup,
} from "./knowledge.js";

export type { CanaryPolicy, CanaryDecision, CrossPrRollback } from "./canary.js";
export {
  DEFAULT_CANARY,
  evaluateCanary,
  planCrossPrRollback,
} from "./canary.js";
