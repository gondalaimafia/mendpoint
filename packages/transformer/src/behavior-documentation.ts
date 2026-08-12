import { redactSourceForModel } from "@mendpoint/agent";
import {
  verifyExtractedBehavioralSpecGraph,
  type ExtractedBehavioralSpecGraph,
} from "./bsg-extractor.js";

const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_STATEMENTS = 4_000;
const MAX_FIELD_CHARS = 100_000;

export type BehaviorDocumentationPolicy =
  | Readonly<{ enabled: false }>
  | {
      enabled: true;
      includeInactiveAppendix: boolean;
      maxOutputChars: number;
      maxStatements: number;
    };

export type BehaviorDocumentationInput = {
  policy?: BehaviorDocumentationPolicy;
  graph: ExtractedBehavioralSpecGraph;
};

export type BehaviorDocumentationEvidenceRef = Readonly<{
  sourceId: string;
  locator: string;
}>;

export type BehaviorDocumentationResult =
  | Readonly<{
      status: "disabled";
      reason: "behavior_documentation_disabled";
    }>
  | Readonly<{
      status: "drafted";
      markdown: string;
      evidenceRefs: readonly BehaviorDocumentationEvidenceRef[];
      excludedStatementCount: number;
      automation: Readonly<{ mayWriteRepository: false; mayPublish: false }>;
    }>;

export class BehaviorDocumentationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BehaviorDocumentationError";
  }
}

function fail(code: string): never {
  throw new BehaviorDocumentationError(code);
}

function boundedInteger(value: unknown, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(code);
  }
  return value as number;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([`*_~{}\[\]<>()#+!|])/g, "\\$1")
    .replace(/\b([a-z][a-z0-9+.-]*):(?=\/\/)/gi, "$1\\:")
    .replace(/\bwww\./gi, (match) => `${match.slice(0, -1)}&#46;`)
    .replace(/@(?=[a-z0-9.-]+\.[a-z]{2,}\b)/gi, "&#64;")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function inlineCode(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function restoreRedactionMarkers(value: string): string {
  return value.replace(/\\\[REDACTED(?:\\_[A-Z]+)+\\\]/g, (marker) => marker.replaceAll("\\", ""));
}

function safeClaim(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const redaction = redactSourceForModel(value.trim(), MAX_FIELD_CHARS);
  if (redaction.excluded || redaction.truncated) return null;
  return restoreRedactionMarkers(escapeMarkdown(redaction.text));
}

function safeEvidence(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const redaction = redactSourceForModel(value.trim(), MAX_FIELD_CHARS);
  if (redaction.excluded || redaction.truncated || redaction.counts.total > 0) return null;
  return escapeMarkdown(redaction.text);
}

type DraftStatement = Readonly<{
  key: string;
  text: string;
  evidence: readonly Readonly<BehaviorDocumentationEvidenceRef & { rendered: string }>[];
}>;

function statementEvidence(
  provenance: ExtractedBehavioralSpecGraph["nodes"][number]["provenance"],
  state: "active" | "stale" | "deleted",
): readonly Readonly<BehaviorDocumentationEvidenceRef & { rendered: string }>[] | null {
  const records: Array<Readonly<BehaviorDocumentationEvidenceRef & { rendered: string }>> = [];
  for (const item of provenance.filter((candidate) => candidate.state === state)) {
    const sourceId = safeEvidence(item.sourceId);
    const locator = safeEvidence(item.locator);
    if (!sourceId || !locator) return null;
    records.push(Object.freeze({
      sourceId: item.sourceId,
      locator: item.locator,
      rendered: `${sourceId} at ${inlineCode(locator)}`,
    }));
  }
  records.sort((left, right) => compareCodeUnits(
    `${left.sourceId.length}:${left.sourceId}${left.locator}`,
    `${right.sourceId.length}:${right.sourceId}${right.locator}`,
  ));
  return Object.freeze(records);
}

function nodeStatement(
  node: ExtractedBehavioralSpecGraph["nodes"][number],
  state: "active" | "stale" | "deleted",
): DraftStatement | null {
  const label = safeClaim(node.label);
  const spec = safeClaim(node.spec);
  const evidence = statementEvidence(node.provenance, state);
  if (!label || !spec || !evidence?.length) return null;
  return Object.freeze({
    key: `node\0${node.key}`,
    text: `${label}: ${spec}`,
    evidence,
  });
}

function edgeStatement(
  edge: ExtractedBehavioralSpecGraph["edges"][number],
  nodesById: ReadonlyMap<string, ExtractedBehavioralSpecGraph["nodes"][number]>,
  state: "active" | "stale" | "deleted",
): DraftStatement | null {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  if (!from || !to) return null;
  const fromLabel = safeClaim(from.label);
  const toLabel = safeClaim(to.label);
  const kind = safeClaim(edge.kind);
  const evidence = statementEvidence(edge.provenance, state);
  if (!fromLabel || !toLabel || !kind || !evidence?.length) return null;
  return Object.freeze({
    key: `edge\0${edge.from}\0${edge.to}\0${edge.kind}`,
    text: `${fromLabel} ${kind} ${toLabel}`,
    evidence,
  });
}

function renderStatement(statement: DraftStatement, prefix = ""): string {
  const evidence = statement.evidence.map((item) => item.rendered).join("; ");
  return `- ${prefix}${statement.text}  \n  Evidence: ${evidence}`;
}

export function generateBehaviorDocumentation(
  input: BehaviorDocumentationInput,
): BehaviorDocumentationResult {
  if (!input?.policy || input.policy.enabled === false) {
    return Object.freeze({
      status: "disabled" as const,
      reason: "behavior_documentation_disabled" as const,
    });
  }
  const policy = input.policy;
  const includeInactiveAppendix = policy.includeInactiveAppendix;
  if (typeof includeInactiveAppendix !== "boolean") {
    fail("behavior_documentation_policy_invalid");
  }
  const maxOutputChars = boundedInteger(
    policy.maxOutputChars,
    MAX_OUTPUT_CHARS,
    "behavior_documentation_output_limit_invalid",
  );
  const maxStatements = boundedInteger(
    policy.maxStatements,
    MAX_STATEMENTS,
    "behavior_documentation_statement_limit_invalid",
  );
  let graph: ExtractedBehavioralSpecGraph;
  try {
    graph = verifyExtractedBehavioralSpecGraph(input.graph);
  } catch {
    fail("behavior_documentation_graph_invalid");
  }

  const activeNodes = graph.nodes.filter((node) => node.state === "active");
  const activeEdges = graph.edges.filter((edge) => edge.state === "active");
  const inactiveNodes = includeInactiveAppendix
    ? graph.nodes.filter((node) => node.state === "stale" || node.state === "deleted")
    : [];
  const inactiveEdges = includeInactiveAppendix
    ? graph.edges.filter((edge) => edge.state === "stale" || edge.state === "deleted")
    : [];
  const candidateCount = activeNodes.length + activeEdges.length + inactiveNodes.length + inactiveEdges.length;
  if (candidateCount > maxStatements) fail("behavior_documentation_statement_limit_exceeded");

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  let excludedStatementCount = 0;
  const current: DraftStatement[] = [];
  for (const node of activeNodes) {
    const statement = nodeStatement(node, "active");
    if (statement) current.push(statement);
    else excludedStatementCount++;
  }
  for (const edge of activeEdges) {
    const statement = edgeStatement(edge, nodesById, "active");
    if (statement) current.push(statement);
    else excludedStatementCount++;
  }
  current.sort((left, right) => compareCodeUnits(left.key, right.key));

  const inactive: Array<Readonly<{ state: "stale" | "deleted"; statement: DraftStatement }>> = [];
  for (const node of inactiveNodes) {
    const statement = nodeStatement(node, node.state as "stale" | "deleted");
    if (statement) inactive.push(Object.freeze({ state: node.state as "stale" | "deleted", statement }));
    else excludedStatementCount++;
  }
  for (const edge of inactiveEdges) {
    const state = edge.state as "stale" | "deleted";
    const statement = edgeStatement(edge, nodesById, state);
    if (statement) inactive.push(Object.freeze({ state, statement }));
    else excludedStatementCount++;
  }
  inactive.sort((left, right) => compareCodeUnits(left.statement.key, right.statement.key));

  const title = safeClaim(graph.title);
  if (!title) fail("behavior_documentation_title_excluded");
  const sections = [`# ${title}`, "", "## Current behavior", ""];
  sections.push(...current.map((statement) => renderStatement(statement)));
  if (inactive.length) {
    sections.push("", "## Inactive evidence appendix", "");
    sections.push(...inactive.map(({ state, statement }) =>
      renderStatement(statement, `${state === "stale" ? "Stale" : "Deleted"}: `)
    ));
  }
  const markdown = `${sections.join("\n")}\n`;
  if (markdown.length > maxOutputChars) fail("behavior_documentation_output_limit_exceeded");
  const evidenceByKey = new Map<string, BehaviorDocumentationEvidenceRef>();
  for (const item of current.flatMap((statement) => statement.evidence)) {
    const key = `${item.sourceId.length}:${item.sourceId}${item.locator}`;
    evidenceByKey.set(key, Object.freeze({ sourceId: item.sourceId, locator: item.locator }));
  }
  const evidenceRefs = [...evidenceByKey.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value);

  return deepFreeze({
    status: "drafted" as const,
    markdown,
    evidenceRefs,
    excludedStatementCount,
    automation: { mayWriteRepository: false as const, mayPublish: false as const },
  });
}
