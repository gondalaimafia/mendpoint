# Mendpoint Change Graph representation benchmark

## Question

Does pre-materializing evidence-bearing software relationships improve Fettler change-impact correctness and efficiency over repeated raw repository retrieval when the generator and acceptance criteria are held constant?

## Arms

- A: raw repository retrieval using the existing code-impact path.
- B: exact Change Graph version plus compact context pack.
- C: arm B plus optional DeepSeek soft selection or review.
- D: oracle ceiling used only by the grader.

DeepSeek may rank deterministic survivors. It cannot rescue a deterministic failure or change an authoritative verdict.

## Dataset

Development, validation, and hidden holdout splits are grouped by repository family and mutation family to prevent related examples crossing splits. At least half of validation and holdout tasks require an indirect relationship. Answer keys are unavailable to the runtime and verifier.

## Measures

Correctness, precision, recall, path accuracy, abstention, false confidence, retrieval calls, context bytes, input and output tokens, latency, model cost, graph build cost, graph reuse, and failure destination.

## Failure destinations

Entity resolution, provider specification, parser, call graph, test mapping, graph runtime, query, context compiler, generator, verifier, deterministic verification, or policy. Graph and representation failures are not eligible for model-weight training.

## External comparison

Rox reports a large graph advantage on unkeyed relationship tasks in [Knowledge Graphs vs Relational Schemas](https://www.rox.com/articles/knowledge-graphs-vs-relational-schemas). Those figures are an external hypothesis only. Mendpoint will not cite them as product evidence; this benchmark must establish software-domain results on retained artifacts.

## Live result: 2026-08-18

The approved live generator was `muse-spark-1.2-contributor`. All runs used the same six programmatically materialized TypeScript repositories, task contract, exact-answer grader, and two examples per split. Validation and holdout each contained one direct and one indirect case. The runtime received context and task only; expected paths stayed in the grader. The combined measured model cost across the three bounded development runs was $0.0076757, below the separate $0.05 ceiling on each run.

### Initial evidence pack

- Scenario-set digest: `sha256:512a98e33501f530ecdf78461394ed83881fdac5d619e8ee489faf92c802f900`
- Report digest: `sha256:9454423d40783f8f5c940a7d0e858524a7cca915bf3053ad102cc7cfe6be4e09`
- Raw: 6 of 6 correct, 4,315 context bytes, 1,894 input tokens, 4,606 output tokens, 28,939.53 ms, $0.0011106.
- Graph: 6 of 6 correct, 20,233 context bytes, 8,629 input tokens, 5,516 output tokens, 38,157.39 ms, $0.0019661.

The first graph compiler repeated hashed entity IDs and source-to-target IDs and included a provider-only path that did not represent repository impact. Those are representation defects, not model defects. Red-first changes removed those fields, compacted each relationship path into ordered evidence-bearing steps, and made provider-only mappings no-impact.

### Optimized evidence pack

- Scenario-set digest: `sha256:e83e282a16da374483cd225e4ccbf4c6faa1e0e48d4b7e49953894b29680b925`
- Report digest: `sha256:53ffd5ba445100345a2c9465964eb0c29abf1076751417a67958ee825966b23d`
- Raw: 6 of 6 correct, 4,315 context bytes, 1,894 input tokens, 4,177 output tokens, 26,739.51 ms, $0.0010248.
- Graph: 6 of 6 correct, 7,710 context bytes, 3,269 input tokens, 4,686 output tokens, 30,922.11 ms, $0.0012641.

The optimized compiler reduced graph context bytes by 61.9 percent, graph input tokens by 62.1 percent, graph latency by 19.0 percent, and graph cost by 35.7 percent relative to the initial graph representation. It did not beat raw retrieval on this tiny synthetic cohort: correctness tied, while graph input tokens were 72.6 percent higher and cost was 23.3 percent higher. The evidence therefore supports the architecture and the compiler improvement, but not enabling graph-first retrieval as the default. The graph path remains shadow evidence until a larger, relationship-heavy cohort demonstrates correctness or efficiency benefit.

### Current-schema evidence pack

After entity, relationship, coverage, scope, and extractor provenance became mandatory, the complete current schema was rerun rather than inferring compatibility from the earlier reports.

- Scenario-set digest: `sha256:13380991077ae37bc820ea047e3dfb25654226804de2cebd876677252894cbdb`
- Report digest: `sha256:326461e6c9deb8f503fdd49b895a29f856f166d658f7c23bb0a7ca2abebcac61`
- Raw: 6 of 6 correct, 4,315 context bytes, 1,894 input tokens, 4,781 output tokens, 28,562.75 ms, $0.0011456.
- Graph: 6 of 6 correct, 7,710 context bytes, 3,255 input tokens, 4,195 output tokens, 26,800.41 ms, $0.0011645.
- Combined model evidence: 12 calls, 5,149 input tokens, 8,976 output tokens, and $0.0023101 measured cost.

The current graph arm was 6.2 percent faster and emitted 12.3 percent fewer output tokens, but used 71.9 percent more input tokens and cost 1.7 percent more. Correctness again tied. This result confirms that the current evidence and provenance schema is executable, while still providing no basis to activate graph-first retrieval by default. The shadow decision remains unchanged.

Arm C was not run because no approved DeepSeek credential was configured. The injected verifier boundary is tested and remains soft only; this report does not fabricate a DeepSeek result.
