# Change Graph coverage model

Coverage is evidence, not a boolean.

Each graph version records stages for repository discovery, language parsing, provider specification, SDK resolution, call resolution, and test resolution. A stage is:

- `complete`: every item inside the declared scope was processed;
- `partial`: processing succeeded but a declared bound or unsupported area remains;
- `not_analyzed`: the stage did not run.

Two further bases are reserved for future stage logic and have no producer today, so the published type (`SoftwareGraphCoverageStageV1["basis"]`) does not yet admit them; re-add each here together with the stage logic that would emit it:

- `failed`: the stage ran but produced no authoritative result;
- `conflicted`: authoritative sources disagree.

Every stage records scope, counts, omissions, reasons, extractor identity, and evidence references. Query coverage combines publication coverage with traversal truncation.

An empty result is `no_impact` only when all required stages are complete and the target resolved exactly. Otherwise it is `unknown_impact`. High-risk work with unknown impact must abstain or escalate.
