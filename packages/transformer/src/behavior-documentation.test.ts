import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractBehavioralSpecGraph,
  type BsgEvidenceSource,
  type ExtractedBehavioralSpecGraph,
} from "./bsg-extractor.js";
import {
  generateBehaviorDocumentation,
  BehaviorDocumentationError,
  type BehaviorDocumentationInput,
} from "./behavior-documentation.js";

const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function source(
  id: string,
  observedAt: string,
  key: string,
  label: string,
  spec: string,
  locator: string,
  deletedAt?: string,
): BsgEvidenceSource {
  return {
    id,
    kind: "code",
    tenantId: "tenant-a",
    repositoryId: "payments-api",
    snapshotId: "snapshot-001",
    revision: REVISION,
    snapshotDigest: DIGEST,
    contentDigest: `sha256:${createHash("sha256").update(id).digest("hex")}`,
    observedAt,
    ...(deletedAt ? { deletedAt } : {}),
    assertions: [{ key, kind: "behavior", label, spec, locator }],
    relations: [],
  };
}

function defaultSources(): BsgEvidenceSource[] {
  return [
    source(
      "active-source",
      "2026-08-12T11:30:00.000Z",
      "calculate-payment",
      "Calculate payment",
      "Returns the authorized total",
      "src/payments.ts:18",
    ),
    source(
      "stale-source",
      "2026-08-12T08:00:00.000Z",
      "legacy-rounding",
      "Legacy rounding",
      "Rounds to whole cents",
      "src/legacy.ts:9",
    ),
    source(
      "deleted-source",
      "2026-08-12T11:00:00.000Z",
      "deleted-refund",
      "Deleted refund flow",
      "Allowed manual refunds",
      "src/refunds.ts:4",
      "2026-08-12T11:15:00.000Z",
    ),
  ];
}

function graph(sources = defaultSources()): ExtractedBehavioralSpecGraph {
  return extractBehavioralSpecGraph({
    tenantId: "tenant-a",
    title: "Payments behavior",
    sourceSystem: "node@18",
    targetSystem: "node@22",
    evaluatedAt: "2026-08-12T12:00:00.000Z",
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    sources,
  });
}

function enabledInput(value = graph()): BehaviorDocumentationInput {
  return {
    policy: {
      enabled: true,
      includeInactiveAppendix: false,
      maxOutputChars: 20_000,
      maxStatements: 100,
    },
    graph: value,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected behavior documentation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(BehaviorDocumentationError);
    expect((error as BehaviorDocumentationError).code).toBe(code);
  }
}

describe("evidence-linked behavior documentation", () => {
  it("is disabled by default without inspecting the graph", () => {
    const input = enabledInput();
    input.policy = undefined;
    Object.defineProperty(input, "graph", { get: () => { throw new Error("inspected"); } });

    expect(generateBehaviorDocumentation(input)).toEqual({
      status: "disabled",
      reason: "behavior_documentation_disabled",
    });
  });

  it("renders deterministic current claims with exact active evidence links", () => {
    const firstGraph = graph();
    const secondGraph = graph(defaultSources().reverse());

    const first = generateBehaviorDocumentation(enabledInput(firstGraph));
    const second = generateBehaviorDocumentation(enabledInput(secondGraph));

    expect(first).toEqual(second);
    expect(first.status).toBe("drafted");
    if (first.status !== "drafted") throw new Error("expected documentation draft");
    expect(first.markdown).toContain("## Current behavior");
    expect(first.markdown).toContain("Calculate payment: Returns the authorized total");
    expect(first.markdown).toContain("active-source at `src/payments.ts:18`");
    expect(first.markdown).not.toContain("Legacy rounding");
    expect(first.markdown).not.toContain("Deleted refund flow");
    expect(first.evidenceRefs).toEqual([{
      sourceId: "active-source",
      locator: "src/payments.ts:18",
    }]);
    expect(first.automation).toEqual({ mayWriteRepository: false, mayPublish: false });
  });

  it("puts stale and deleted claims only in an explicitly requested inactive appendix", () => {
    const input = enabledInput();
    if (!input.policy?.enabled) throw new Error("expected enabled policy");
    input.policy.includeInactiveAppendix = true;

    const result = generateBehaviorDocumentation(input);

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("expected documentation draft");
    expect(result.markdown).toContain("## Inactive evidence appendix");
    expect(result.markdown).toContain("Stale: Legacy rounding");
    expect(result.markdown).toContain("Deleted: Deleted refund flow");
    expect(result.evidenceRefs).toEqual([{
      sourceId: "active-source",
      locator: "src/payments.ts:18",
    }]);
  });

  it("redacts known secrets and excludes ambiguous secret-bearing statements", () => {
    const value = graph([
      source(
        "active-source",
        "2026-08-12T11:30:00.000Z",
        "calculate-payment",
        "Calculate payment",
        "Uses api_key=super-secret-value for lookup",
        "src/payments.ts:18",
      ),
      source(
        "ambiguous-source",
        "2026-08-12T11:30:00.000Z",
        "ambiguous",
        "Ambiguous credential",
        "Token aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5bC7dE9fG1hJ3",
        "src/credential.ts:2",
      ),
    ]);

    const result = generateBehaviorDocumentation(enabledInput(value));

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("expected documentation draft");
    expect(result.markdown).toContain("api\\_key=[REDACTED_SECRET]");
    expect(result.markdown).not.toContain("super-secret-value");
    expect(result.markdown).not.toContain("Ambiguous credential");
    expect(result.excludedStatementCount).toBe(1);
  });

  it("escapes Markdown control syntax in claims and evidence locators", () => {
    const value = graph([source(
      "active-source",
      "2026-08-12T11:30:00.000Z",
      "calculate-payment",
      "[Calculate](https://attacker.invalid) # payment",
      "Uses *authorized* `total`",
      "src/payments`bad`.ts:18",
    )]);

    const result = generateBehaviorDocumentation(enabledInput(value));

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("expected documentation draft");
    expect(result.markdown).toContain("\\[Calculate\\]\\(https\\://attacker.invalid\\) \\# payment");
    expect(result.markdown).toContain("Uses \\*authorized\\* \\`total\\`");
    expect(result.markdown).toContain("``src/payments\\`bad\\`.ts:18``");
  });

  it("fails closed when statement or output bounds would be exceeded without mutating the graph", () => {
    const value = graph();
    const before = structuredClone(value);
    const statementBound = enabledInput(value);
    if (!statementBound.policy?.enabled) throw new Error("expected enabled policy");
    statementBound.policy.maxStatements = 1;
    statementBound.policy.includeInactiveAppendix = true;
    expectCode(
      () => generateBehaviorDocumentation(statementBound),
      "behavior_documentation_statement_limit_exceeded",
    );
    expect(value).toEqual(before);

    const outputBound = enabledInput(value);
    if (!outputBound.policy?.enabled) throw new Error("expected enabled policy");
    outputBound.policy.maxOutputChars = 10;
    expectCode(
      () => generateBehaviorDocumentation(outputBound),
      "behavior_documentation_output_limit_exceeded",
    );
    expect(value).toEqual(before);
  });

  it("preserves distinct source and locator pairs without delimiter collisions", () => {
    const first = source(
      "a#b",
      "2026-08-12T11:30:00.000Z",
      "calculate-payment",
      "Calculate payment",
      "Returns the authorized total",
      "c",
    );
    const second = source(
      "a",
      "2026-08-12T11:30:00.000Z",
      "calculate-payment",
      "Calculate payment",
      "Returns the authorized total",
      "b#c",
    );
    const value = graph([first, second]);

    const result = generateBehaviorDocumentation(enabledInput(value));

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("expected documentation draft");
    expect(result.evidenceRefs).toEqual([
      { sourceId: "a", locator: "b#c" },
      { sourceId: "a#b", locator: "c" },
    ]);
  });

  it("rejects tampered graph identity, claims, provenance, tenant, state, and schema", () => {
    const mutations: Array<(value: ExtractedBehavioralSpecGraph) => void> = [
      (value) => { value.digest = `sha256:${"f".repeat(64)}`; },
      (value) => { value.id = "bsg_forged"; },
      (value) => { value.schemaVersion = "forged" as typeof value.schemaVersion; },
      (value) => { value.tenantId = "tenant-b"; },
      (value) => { value.nodes[0]!.spec = "Forged behavior"; },
      (value) => { value.nodes[0]!.provenance[0]!.locator = "forged.ts:1"; },
      (value) => {
        const stale = value.nodes.find((node) => node.state === "stale")!;
        stale.state = "active";
        stale.provenance[0]!.state = "active";
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(graph());
      mutate(value);
      expectCode(
        () => generateBehaviorDocumentation(enabledInput(value)),
        "behavior_documentation_graph_invalid",
      );
    }
  });

  it("neutralizes GFM links, autolinks, emphasis, strikethrough, HTML, images, and newlines", () => {
    const value = graph([source(
      "active-source",
      "2026-08-12T11:30:00.000Z",
      "calculate-payment",
      "_Pay_ ~~now~~ https://attacker.invalid www.attacker.invalid user@attacker.invalid <script>alert(1)</script>",
      "![image](https://attacker.invalid/x)\n[next](https://attacker.invalid)",
      "src/payments.ts:18",
    )]);

    const result = generateBehaviorDocumentation(enabledInput(value));

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("expected documentation draft");
    expect(result.markdown).toContain("\\_Pay\\_ \\~\\~now\\~\\~ https\\://attacker.invalid");
    expect(result.markdown).toContain("www&#46;attacker.invalid user&#64;attacker.invalid");
    expect(result.markdown).toContain("\\<script\\>alert\\(1\\)\\</script\\>");
    expect(result.markdown).toContain("\\!\\[image\\]\\(https\\://attacker.invalid/x\\)\\n");
    expect(result.markdown).not.toContain("https://attacker.invalid");
    expect(result.markdown).not.toContain("www.attacker.invalid");
    expect(result.markdown).not.toContain("user@attacker.invalid");
    expect(result.markdown).not.toContain("\n[next]");
  });

  it("snapshots inactive appendix authority before accessing the graph", () => {
    const policy = {
      enabled: true as const,
      includeInactiveAppendix: false,
      maxOutputChars: 20_000,
      maxStatements: 100,
    };
    const input = { policy } as BehaviorDocumentationInput;
    Object.defineProperty(input, "graph", {
      enumerable: true,
      get() {
        policy.includeInactiveAppendix = true;
        return graph();
      },
    });

    const result = generateBehaviorDocumentation(input);

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("expected documentation draft");
    expect(result.markdown).not.toContain("Inactive evidence appendix");
  });
});
