# Change Graph query and context contract

Every query requires tenant ID, repository ID, exact graph version ID, target identity, allowed relationship kinds, maximum hops, maximum nodes, maximum relationships, and maximum context bytes.

The first Fettler query resolves an endpoint and traverses reverse software relationships to internal SDK methods, wrappers or callers, and tests. It returns:

- ordered entity and relationship records;
- complete evidence paths;
- publication and traversal coverage;
- ambiguity, stale, and conflict notices;
- truncation reasons and minimum omitted count;
- a deterministic result digest.

The context compiler emits the minimum sufficient structured evidence pack. It never emits the whole graph, raw secrets, chain of thought, or unrelated tenant state. Deterministic evidence remains authoritative; optional model verification is a soft annotation.
