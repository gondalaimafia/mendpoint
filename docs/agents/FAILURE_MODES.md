# Mendpoint Failure Modes

Read this before writing code, reviewing a PR, or shipping anything to
production in this repository.

This is not a style guide. Every entry below is a defect that actually shipped
here, was diagnosed by reproducing it, and cost real time. They repeat because
each one is *cheap to introduce and invisible at review time* — the reason they
are written down is that judgement alone has not been enough to prevent them.

`docs/agents/OPERATING_PROTOCOL.md` governs *how work is coordinated*. This
document covers *how the work goes wrong*.

---

## 1. The third-state defect

**A two-valued type is asked to carry three states — true / false /
not-determined — and the third silently collapses into the reassuring one.**

This is the dominant defect shape in this codebase. Observed instances:

| Where | The collapse |
|---|---|
| Worker job counter | a *simulated* verifier — one that never ran — incremented `succeeded` |
| ReGauge policy task | `targetPaths: []` made `forbiddenZones` unable to fire; the denylist was inert |
| Inherited-context switch | env unset and env explicitly `0` were indistinguishable, so an operator kill switch silently did nothing |
| Mission graph binding | `already_bound` covered both "pinned to what I wanted" and "pinned to something *different*" |
| Mission context compiler | a corrupt policy envelope produced *zero* directives while a valid one produced three restrictive ones — the most dangerous input produced the least constrained behaviour |
| Change-impact audit | a later event with an unrecognised fallback cleared a genuine `raw_retrieval` degradation stamp, so "we ran degraded" read as "graph-authoritative" |

**The rule.** Any value that answers a question about the world must be able to
say *"I do not know"*, and every consumer must handle that answer explicitly.
Prefer a discriminated union over a boolean plus a default. When a check cannot
run, emit an unmistakable third value — never the passing one.

**Where it hides.** Error paths and defaults. Ask of every `catch`, every `??`,
every `if (!x) return`: *if this input were garbage, is the result MORE or LESS
constrained than the valid case?* Less constrained is a defect, and on a policy
or authorization path it is a security defect.

**It applies to tooling too, not just product code.** A script that reports
`{success, failure}` but cannot express *"did nothing"* produces the same lie —
see §5.

---

## 2. Delete-the-check

**A test that does not die when the thing it tests is removed is not a test.**

Verify by mutation, not by reading. Revert the control, run the suite, watch it
fail, restore it, and record the observed failure output. Do this for real; do
not reason about what would happen.

Instances where inspection said "covered" and mutation said otherwise:

- deleting an entire coordinator wiring left **36/36 tests green**
- a post-provider lease fence, whose loss silently loses work, left **27/27 green**
- moving a transactional outbox write to *after* `COMMIT` — destroying the
  durability the PR's title claimed — left **452/452 green**

**Anti-patterns that look like tests:**

- **Source-text scans.** `readFileSync(...)` plus a regex over a production file
  proves the *text* exists, not that it executes. It passes identically if the
  call sits in dead code, and it breaks on cosmetic reformatting.
- **Tautological checks.** A check whose two sides both derive from the same
  input cannot fail. One gate here allowed `live` evidence where a pre-existing,
  stricter rule already rejected it — so it passed exactly where the older rule
  failed, and could never be the thing that went red.
- **Assertions that pin a bug.** When a fix goes red because a test pinned the
  broken behaviour verbatim, the test follows the corrected contract. Update it;
  never delete an assertion to go green.

When removing a redundant check, prove the coverage survives elsewhere before
deleting it.

---

## 3. Evidence must cite reachable code, not files

**A citation that a file exists is not evidence that the code runs.**

A requirement was marked `verified` while its entire subsystem — store,
resolution, waivers, simulation — had **zero non-test references anywhere in the
repo**. The reachability gate rated it live because a *co-imported* symbol in the
same test was live.

**The rule.** Before claiming a capability, trace a chain from a real production
entry point — an API route in `apps/api/src/server.ts`, a job-type branch in
`apps/worker/src/cli.ts`, or a CLI command — and show that chain. Test-only
callers mean the capability does not exist yet; say so plainly and mark it
`scaffold`, which is what that status is for.

Large, purely-additive PRs are where this concentrates. `+800/-2` with a matching
test file is the classic signature of a subsystem wired to nothing.

---

## 4. CI cannot see production configuration

**PR CI verifies code against fixtures. Production runs code against
configuration. Nothing verified configuration until it failed.**

- A backup workflow shipped and failed **every 30 minutes for a day, having never
  once succeeded** — its environment held zero secrets. PR CI passed on every
  commit, because a scheduled workflow's secret path is unreachable code at
  review time.
- Beneath that missing secret sat a second defect no run had ever reached: the
  scoping guard parsed `flyctl apps list --json` with `jq -r '.[].name'`, but
  flyctl emits `"Name"`. Case-sensitive `jq` yielded `null`, so even a correct
  token failed. **Fixing the visible failure is what exposes the masked one.**
- Three jobs minted an App token from secrets scoped to an environment only one
  job declared. The token resolved to an empty string at runtime.

**The rules.**

1. `npm run config:check` (`scripts/config-completeness-check.ts`) gates this
   statically on every PR — **arriving in #479; not yet on `main` at the time of
   writing.** Keep it green; when it flags an undeclared reference, declare it in
   `config/required-configuration.json` with its scope — do not silence it. Until
   it lands, apply the rule by hand: a PR naming new configuration must also
   provision it, or state which gate makes its absence safe.
2. Configuration that may legitimately be absent is `optional_gated` and must
   record *the runtime gate that makes absence safe*. "Deliberately absent" must
   never decay into "forgotten".
3. **A PR that adds or changes a scheduled or secret-bearing workflow is not done
   at merge.** Dispatch it once and read the run's conclusion. Merge proves a
   pointer moved; only a green run proves behaviour.

---

## 5. Verify by reading state back, never by trusting the report

Commands lie about their own success, and every instance below happened here:

- `gh ... | tail -2` made a `&&` chain report success after both calls had failed
  on a rate limit — the pipe masked the exit code.
- Suppressing `stderr` with `>/dev/null 2>&1` hid `Pull Request is still a draft`
  for 96 minutes while a watcher reported clean runs.
- A `cp` restore silently failed (Windows-python `/tmp` is `C:\tmp`; MSYS tools
  resolve their own `/tmp`), leaving a mutated file that nearly got committed.

**The rules.** Capture exit codes explicitly — never pipe a gate through `grep`
and rely on `set -e`. After any state-changing operation, *read the state back*
and assert it. When writing a loop or watcher, enumerate its terminal states
before running it and confirm each prints a distinct line: success, failure,
skipped, held, and **did nothing**. Never copy a script forward as a template
without re-running that enumeration — patching only the branch that last failed
is how the class survives.

---

## 6. A negative result is a claim and needs a control

"Nothing references this" gets acted on — code deleted, features declared
unlinked, audits closed. Establish it properly:

- **On this Windows host, `git grep` patterns containing `="/` are silently
  rewritten by MSYS path conversion and return zero matches.** Prefix
  `MSYS_NO_PATHCONV=1`. `-F` does not help.
- A search truncated by `head -N`, or one that timed out mid-scan, is not an
  absence — early hits fill the window. This produced four near-miss findings in
  a single session, including one where a missing entry would have "proven" a
  live deployment path did not exist.
- Paginated APIs default to a page. A variables listing returned 10 of 18 and
  nearly became a report of eight missing variables.

**The rule.** Before reporting any absence, run the same search for a string you
*know* is present in the same file or scope, and state both results. A search
that cannot produce a hit has not established anything.

---

## 7. Premises decay in hours

This repository has sustained ~70 merges in a day. At that rate an audit finding
is perishable:

- A rebase agent's "this rebases to an empty diff" was true when measured and
  false two hours later.
- A branch was hardened while, in parallel, its owner deleted the entire
  subsystem being hardened.
- A PR removed a workflow trigger; while it was in flight, `main` grew a test
  pinning that exact trigger as required.

**The rules.** Re-fetch `main` immediately before rebasing *and* immediately
before pushing. Re-run the branch's own contract-sensitive tests (pin tests,
full-object `toEqual`) on the rebased tree, not just where the work was done.
Before acting on a finding older than about an hour, re-verify its premise. If a
premise turns out false, **stop and report** rather than adapting the work to fit
— that instruction has repeatedly prevented confident changes built on something
untrue.

---

## 8. Refuse convenient weakenings

When a check blocks, the tempting fix is to relax it. Several times here the
check was correct and the relaxation would have destroyed the guarantee:

- Dropping a job type from `supportedTypes` when a lease was too short would
  have converted *"we cannot verify"* into *"there is nothing to verify"*.
- Resolving a merge conflict "cleanly" would have reintroduced a ternary that
  collapsed an honest `graph_handle_unavailable` state — `main`'s comment
  explains why it renders unconditionally.
- Bumping `auditedRevision` to green a claims gate would have no-op'd the very
  staleness check the PR existed to add.

**The rule.** A merge conflict whose resolution requires *choosing between two
behaviours* — rather than combining two additive changes — is a design decision,
not a mechanical one. Refuse it and escalate. Refusing is a valued outcome.

---

## 9. Gate scope, not just gate logic

**When a rule is hardened, the next instance appears in a file that rule does not
read.** The rule is never attacked; its scope is stepped around.

A claims gate was hardened against fabricated live evidence (git revision
reachability, plus rejection of synthetic whole-second batch stamps). Days later
a new artifact carried the same class of claim, validated by a *new* gate that
checked string format only. Setting the revision to `deadbeef…` and the timestamp
to the fabrication signature left **both gates printing PASS**.

**The rules.** When reviewing a new artifact that carries observation, evidence,
or compliance claims, ask which existing gate reads *this file* — not which gate
covers this claim *type*. Verify by mutation: write a deliberately false value
and confirm something fails. When hardening a gate, copy the rationale comment to
every validator of the same claim class; the reason this recurred is that the
"why" lived in exactly one file.

**Corollary — one config, many consumers.** A trust-root key was accepted by the
rotation script (key-agnostic) and invisible to the runtime (which whitelists
specific keys). It was verified against one consumer and shipped broken. Verify a
config change against *every* consumer that reads it.

---

## 10. Enumerate layers; do not peel them

A born-broken system hides failures behind failures. One subsystem here had
**five** stacked causes, each visible only after the previous fix landed: a
rate-limit self-DoS, secrets bound to an undeclared environment, null identity
ids, a trust-root key invisible to its runtime, and a stale snapshot. Each fix
was correct. The method was wrong: five fix-PRs, five CI cycles, and five
premature declarations of "fixed".

**The rule.** The moment a *second* hidden layer appears behind a fix, stop
fixing serially. Reproduce the whole chain locally in one pass — run every
sub-check directly against a fixture, enumerate every failure at once — and ship
one change-set with one verification cycle. Serial CI-cycle discovery is
acceptable only when local enumeration is genuinely impossible.

---

## 11. Stacked PRs and branch deletion

`gh pr merge --delete-branch` removes the head branch, and GitHub then
**auto-closes every open PR whose base was that branch**. The closure is silent
and reads to a later observer as a deliberate rejection. Such a PR **cannot be
reopened** — the base no longer exists, and a closed PR's base cannot be changed.

Two reviewed, gate-passing PRs were lost this way and had to be recovered by
cherry-picking onto fresh branches.

**The rule.** Before any `--delete-branch`, run
`gh pr list --base <branch-to-be-deleted>` as a *separate step* and retarget any
child to `main` first. Merge the parent **without** deleting, confirm the child's
base actually moved by reading it back, then delete. See
`OPERATING_PROTOCOL.md` §14.1.

---

## 12. The upgrade path is invisible to CI

**Every test and the deployment-e2e job boot from a *fresh* database. Nothing in
CI exercises an upgrade.**

A slice added an index on `agent_runs(tenant_id, job_id)` to the static DDL while
`job_id` arrives via a later additive migration. Everything was green — fresh
databases have the column. The existing production volume did not; `createDb`
runs the whole static DDL *before* additive migrations, so boot threw
`no such column: job_id` and production went down until a manual rollback to the
previous image.

`CREATE TABLE IF NOT EXISTS` no-ops on an existing table, so **any** static DDL
statement referencing a migrated column works only on fresh databases.

**The rule.** A new column goes in *both* the `CREATE TABLE` and the additive
migration list. Static DDL must never reference a column that arrives by
migration — an index on a migrated column belongs in the migration, not the DDL.
Before deploying a schema change, boot it once against a copy of the pre-change
schema; a green fresh-install suite says nothing about upgrades.

---

## 13. A modeled control arm flatters the treatment

**A benchmark arm that is *modeled* rather than *run* encodes the assumption
being tested.**

The persistent-context benchmark measured "repeated mistakes avoided" as **3.0 of
3** synthetically and **0.0 of 3** against a live model. The treatment did not
regress — it scored 0/3 in both. The metric collapsed because the *control*
changed: a modeled stateless agent repeats every mistake **by construction**,
while the real model's own priors already avoided them. The whole synthetic delta
was manufactured by how the control was written.

**The rule.** Before believing a benchmark delta, ask what the control arm
actually does. If it is a description of a baseline rather than an execution of
one, the number measures the description. Run both arms.

---

## 14. Orchestration failures

These cost more wall-clock time in practice than any single code defect.

**Agents stall waiting on background work.** Five separate agents in one session
ended their turn to announce that a gate was running, each needing an identical
nudge. Put it in the brief, not the recovery: *run all gates in the foreground of
your own turn; end the turn only with a final report or a precisely named
blocker.*

**A watcher that is silent on red converts "blocked" into "waiting."** A
merge-on-green loop correctly refused a red PR for over an hour while emitting
nothing — indistinguishable from checks still running, and the operator noticed
before the tooling did. Any such loop must emit a distinct `RED:<pr> <check>` line
and stop: a completed failure is terminal, and more polling cannot fix it.

**Automation that rebases mid-CI serializes itself.** Rebasing a PR whose checks
are still running kills the in-flight run and restarts the clock. Rebase only
when every required check is *completed* and staleness is the last blocker.

**Briefs decay faster than they execute.** Include the standing instruction: *if a
premise in this brief turns out to be false, stop and report rather than adapting
the work to fit.* That instruction repeatedly prevented confident changes built on
something untrue — including an agent told to harden a subsystem another session
had already deleted.

---

## 15. Environment traps on this host

- **The default `dev/mendpoint` checkout is not `main`.** It is a long-parked
  worktree on another branch. Read `origin/main` through `git show` or a clean
  worktree; never trust the working tree.
- **`git grep` mangles patterns containing an equals-quote-slash sequence**
  (MSYS path conversion) and returns zero matches. Prefix `MSYS_NO_PATHCONV=1`.
  See §6.
- **Windows-python and MSYS tools resolve `/tmp` to different directories.**
  Mixing them silently breaks backup-and-restore — a restore that "succeeded"
  once left a mutated file staged for commit.
- **Some suites carry hard-coded per-test timeouts** and fail under parallel load
  while passing in isolation. Distinguish an environmental timeout from an
  assertion failure before reporting either.

---

## 16. Before an irreversible or outward-facing action

Merging, deleting a branch, deploying, sending, publishing, paying, and changing
branch protection are all one-way doors.

A stated constraint ("schedule, do not publish") was violated minutes later — not
from forgetting, but because the commitment lived only in conversation prose, and
a long error-recovery loop had shifted the work into repeating the mechanical
sequence that worked last time.

**The rules.** Write a constraint on a future irreversible action into the task
list or a file, never only into conversation. Immediately before the action,
restate the constraint and confirm this action satisfies it. Treat long
failure-recovery loops as a trigger to re-read the plan — that is exactly when
pattern-matching replaces intent. And **query live state before assigning manual
work to a human**: a chain of manual errands was once justified entirely by a
stale note, when one live check would have shown the work was already done.

---

## 17. An unsatisfiable gate is not a failing PR

**A gate can be red because its passing condition requires knowledge the author
could not have had — and refreshing only re-loses the race.**

The closure gate once compared each PR's committed matrix snapshot against *live*
GitHub state at every judge: one code demanded the snapshot equal main's current
tip, another demanded its open-PR set equal the live open-PR set. With ~30 open PRs
and ~70 merges a day this was **unreachable by construction** — every merge turned
the other ~29 PRs red, and every new PR turned all earlier ones red. On one day
this was the sole cause of red on ~25 of 30 PRs; exactly one PR had a genuine test
failure. Hand-refreshing 25 PRs would have been wasted within a single merge.

**The discriminating test.** Ask whether *a perfectly diligent author could have
satisfied the check at author time*. A PR authored at time T cannot enumerate a
sibling created at T+1. When the answer is no, the check is unsatisfiable, and
**relaxing it is the only correct move** — not a weakening. This is the mirror
image of §8: there the check was right and relaxing it was the lazy path; here the
check cannot be met, and refusing to change it just re-loses the race. Distinguish
both from a *wrong-baseline* gate, which measures against the wrong anchor but is
still satisfiable — fix the anchor, do not relax it.

**Before relaxing, two guards.** Say plainly which guarantee is being given up.
And confirm the property is a *reporting* one, not a *security* one: enumerate
every consumer of the value first (§10) and stop if any makes a security decision
on it. A provenance or snapshot change offered as "load-bearing" is often not —
measure before accepting it. One PR re-pinned an audited revision to green a new
gate; zero of the 13 claim surfaces had changed across 310 files, so the gate
passed without the re-pin at all.

---

## 18. A systemic false positive does not entitle you to switch the check off

**Reducing branch protection to drain a queue past a known-noisy gate let a real
dependency violation through within the hour. The noise and the signal came out of
the same check.**

The closure gate was red on all 34 open PRs for one systemic reason (§17), so it
carried no signal about any individual PR. To ship, the required contexts were cut
to the four product checks and six reviewed PRs merged. Within the hour,
`closure:check` on main reported `PR_DEPENDENCY_UNSATISFIED`: one merged PR
declared a dependency on another that had been closed as superseded, and main's
matrix recorded its disposition as *replace, do not merge as-is*. The gate would
have caught both. It had been switched off.

**The trap:** "this gate is red on all 34 PRs for one systemic cause, therefore it
is telling me nothing about these six." The first clause was true; the second does
not follow. A gate emitting a systemic false positive can emit true positives in
the same run, and disabling it discards both. This is §8 one level up — applied to
the enforcement mechanism instead of a single assertion.

**What was available instead:** the per-PR `closure-authority (N)` checks were
*not* required contexts — only the sweeps were. Reading each PR's own verdict for
real findings while merging past the sweep was possible the whole time, visible in
the branch-protection config already read. After the drain, all 28 per-PR runs on
main's tip came back green: the check discriminates fine when its inputs are
current. Note also that draining N PRs stales main's own matrix (it is authored
inside PRs; the last merged wins), so budget a resync PR as part of any batch
merge, not as a surprise after.

**The rule.** Before disabling an enforcement mechanism to unblock delivery,
separate its systemic failure from its per-item findings and read the per-item
findings anyway. If you cannot separate them, you are not entitled to conclude it
has nothing to say.

---

## 19. A fixture must look like production, not like the code

**Across ~12 PRs reviewed in one session not one merged on first review, and every
genuine defect hid behind a fixture shaped like the module under test rather than
like production.** Carelessness was never the cause; the fixtures tested the wrong
world.

- **Identifier length.** Production ids are a 49-char campaign plus a 68-char
  target — a verification scope of 217 chars and an entry id of 230 against a
  `maxIdentifier: 200` that *throws*. Every fixture used two-character ids (`c1`,
  `t1`), scope length 117, so the throw never fired in tests; in production it
  dropped the entire mission context to absent, which downstream read as "no prior
  context."
- **A precondition production never establishes.** A fix derived a binding from
  `mission.snapshotId`, which is *null on the live Fettler path*. Its test passed
  only because the fixture had called the binding setup itself — a step production
  never runs. Green in tests, no-op in prod. The remedy was removing that setup
  call from the test so it exercised the unbound path.
- **Caller wiring left unexercised.** The one line wiring a seam into production
  was unguarded; mutating the caller to feed a bogus value left **618** and **90**
  tests green in two PRs. The seam was well tested; its only production binding was
  not.
- **Vacuous evidence shims.** An evidence-shape check was hollow because the `jq`
  shim ignored its filter and emitted a hardcoded object; deleting `result` and
  `reason` from both evidence writers left **51/51** green.
- Database age (§12) and tautological controls (§2) are the same disease in other
  dimensions.

**The rule.** A fixture must resemble production in every dimension the code is
sensitive to: identifier length, database age, whether a setup function the live
path never calls has been called, whether the caller wiring is exercised at all.
When reviewing, ask *what does production actually look like here* and check whether
any fixture matches. When fixing, **fix the fixture, not just the assertion** — an
assertion tightened over a fake world still tests the fake world. Prove it by
mutation (§2): the corrected fixture must make a *named* test die when the guard is
reverted.

**Pin the production shape next to the guard, not only here.** Two of the bullets
above now carry their reasoning at the point of use — `apps/worker/src/mission-context.ts`
records why the absence entry id is a sha256 (the real 217/230-against-200 numbers),
and `apps/worker/src/agent-run-policy.ts` records why the snapshot binding must not be
derived from `mission.snapshotId` on the live Fettler path. A comment beside the guard
survives the next author who rewrites the fixture.

---

## Quick checklist

Before opening a PR:

- [ ] Every new check has a test that **dies** when the check is reverted — run it
- [ ] No source-text scan is standing in for behavioural coverage
- [ ] Every value answering a question about the world can say "I don't know"
- [ ] Every `catch` and default fails **closed**
- [ ] New columns appear in **both** the `CREATE TABLE` and the additive-migration
      list (`ensureTables` never alters; fresh-install CI cannot see upgrade drift)
- [ ] `completeJob` / `failJob` returning `false` **throws** — a lost lease is never success
- [ ] Any claimed capability has a traced production call path
- [ ] Any new configuration is declared in `config/required-configuration.json`
- [ ] If it touches a scheduled or secret-bearing workflow: dispatch it post-merge
      and read the run's conclusion
- [ ] Every fixture matches production where the code is sensitive to it — id length,
      database age, setup the live path never runs, caller wiring actually exercised
- [ ] A red gate is triaged before it is relaxed or bypassed — unsatisfiable, wrong
      baseline, or a true finding are three different verdicts
