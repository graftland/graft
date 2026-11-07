# Phase 2 proof

Status: step 1 implementation. Phase 2 is not complete. No interpreter, real
unit termination, direct channel, completion protocol or gateway evidence is
claimed by the reducer tests below. The existing application Change entry still
uses the Phase 1 engine until step 2 removes it.

## 1. Production reducer exploration

`packages/core/src/internal/decisionCore.ts` owns the new decision transitions;
`decisionState.ts` contains data-only records. The test directory contains no
second implementation. Exploration supplies external command reports, exit
reports and timer events; there are no Commit, Recover, Finish or synthetic
NotStarted actions.

| Exploration test in `core/test/change-model.test.ts`                                    | Bound                                                   | Schedules                  | State visits / distinct states | Transitions |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------- | ------------------------------ | ----------- |
| explores every causal shuffle of independent Changes using production commands          | Two ordered actors, nine reports each                   | 48,620                     | 184,755 visits                 | 184,754     |
| explores conflicting admission and shutdown in every causal order                       | Three one-event actors                                  | 6                          | 16 visits                      | 15          |
| explores exclusive recovery alongside an unrelated commit without overwriting it        | Recovery actor of eight reports; unrelated actor of two | 45                         | 219 visits                     | 218         |
| explores repeated exit, timer, failure, cancellation and shutdown reports to depth four | Six-event alphabet; depth 4; state deduplication        | Not a causal-shuffle count | 159 distinct states            | 558         |

`change-model/assertions.ts` checks claim conservation, complete reservation
ownership, monotonic versions, ended-unit lease release and immutable
conclusions after every explored transition. Failures retain stimulus names as a
causal trace. This finite exploration does not prove unbounded executions or
arbitrary topologies.

## 2. Interpreter and native execution conformance

Not implemented. Step 2 must bind commands to an Effect interpreter and separate
kernel and embedded services. Step 3 must supply real Worker/process exit
observation and runner uncertainty tests. Reducer exit events are simulated
external evidence, not native termination proof.

## 3. Invariants, counterexamples and fault cells

Step 1 has 42 acceptance tests across `decision-core.test.ts`,
`change-model.test.ts` and `change-model-settlement.test.ts`. Test names
identify the applicable invariant ids.

| Requirement | Step 1 evidence                                                                                                                                                                                                                                         | Remaining acceptance                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| I1, I2      | Intent before dispatch; owned claims; duplicate/reordered reports; full command/cleanup causes; idempotent exit/cancel; capacity conservation                                                                                                           | Interpreter conformance, call-credit ownership                        |
| I3          | All independent shuffles; both commit orders; atomic conflict footprint; absence ABA; shared-read writer fence; lost-owned-version recovery rejection                                                                                                   | Verified declaration footprint and binding identity                   |
| I4          | State/event/command records contain no plugin callbacks or handles                                                                                                                                                                                      | Import audit and real blocking-contract fixture                       |
| I5, I6      | Spawn timeout and terminate acknowledgement preserve Missing evidence; confirmed prevention; native-exit event releases only its unit; cleanup remains separate; forced retirement and known cleanup failure paths; delayed report/exit deadline guards | Actual native exit and disconnected runner evidence                   |
| I7          | Old-changed before Stop; exclusive recovery; failed current authorization; refreshed read premises; shutdown never Aborted after old stops                                                                                                              | Real policy/resolver unit protocol and reauthorization                |
| I8          | Required participant set; partial/stale view rejection; late old-attempt reports cannot advance/fail recovery                                                                                                                                           | Unit-local contract injection and direct encoded transport            |
| I9          | Not implemented                                                                                                                                                                                                                                         | Step 5 single-hop result/cancel/completion and bounded calls          |
| I10         | Immutable Stuck/Accepted conclusions, exact late release, indexed current incarnation, fixed serving transfer, bounded history without predecessor commands                                                                                             | Public observer reconciliation and collection/native runtime evidence |
| I11         | One absolute deadline retained through forward/recovery/trial; terminate failure cannot renew its evidence timer; two-trial admission reserve                                                                                                           | Inspection and preparation retirement charged before admission        |
| I12         | Group/local-service and Runner Overlap requests rejected before commands                                                                                                                                                                                | Complete unsupported unary topology checks                            |

Reducer fault cells covered include pre-admission conflict/staleness/capacity,
forward spawn prevention/uncertainty, startup timeout, exclusive recovery
denial, forced retirement, cleanup defect, missing/late/duplicate exit, wrong
view and shutdown. Describe, transport, call and public gateway cells remain
required in the steps that implement them. No aggregate passing test count
certifies those missing cells.

## 4. Gateway and locality

No gateway slice yet. The object-access test checks the reducer admission and
commit footprint with 0, 20 and 200 unrelated instances; each uses only the
target object. Timer cancellation uses each Change timer index, and status
revision uses indexed affected Changes rather than scanning all Changes. This is
internal logical-cell access accounting; the external gateway object-access
instrumentation required by proof item 4 remains unimplemented. These checks do
not promise constant latency under saturation.

## 5. Deletion and documentation

The [deletion manifest](phase-2-deletion-manifest.md) maps the old model cases,
adapter removal and the baseline test-file inventory. The duplicate model and
in-process model adapter are deleted. Old production execution remains until its
designated replacing step. Product documentation is unchanged because step 1
adds internal machinery only; it does not yet change the public runtime.

| Phase 1 review regression class                                                                                                      | Step 1 disposition                                                                                                   | Remaining work                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Round 1 F1, F2: call-credit handoff and stable binding conflicts                                                                     | Deferred; old tests retained                                                                                         | Steps 4–5                                                                                            |
| Round 1 F3; round 3 F1; round 4 F2: fresh independent recovery authorization and exclusive recovery                                  | Reducer cases replaced; real policy tests retained                                                                   | Step 3 current-policy integration                                                                    |
| Round 1 F4–F5; round 2 F1–F4; round 3 F2 and executor self-check: host waits, preparation, closing ownership and late causes         | Host tests retained pending deletion                                                                                 | Steps 2–3 remove host execution; native unit tests replace waits                                     |
| Round 1 F6; round 2 F5; round 3 F3: live facts and recreated instances                                                               | Reducer projections, immutable conclusions and old-incarnation late exit cases                                       | Steps 2 and 6 public projection integration                                                          |
| Round 2 F6: public export/reference completeness                                                                                     | Existing documentation tests retained                                                                                | Step 7                                                                                               |
| Round 4 F1/F4 and serving-transfer self-check: one settlement classifier, complete obligations, known failure vs unresolved evidence | Reducer obligations/classifier; old exit/candidate/recovery evidence, immutable serving transfer and cleanup defects | Steps 2–3 remove old classifier and native-evidence conformance                                      |
| Round 4 F3: absolute preparation/cleanup budget                                                                                      | Absolute execution/recovery budget retained                                                                          | Step 3 inspection and cleanup                                                                        |
| Round 4 F5: withdrawn generation dependency-cycle test                                                                               | Retained embedded test                                                                                               | Group/local captured-resource closure deferred to Phase 3                                            |
| Round 5 F1: idle unit exit leaves host cleanup                                                                                       | Old host regression mechanism is still present                                                                       | Step 2 deletes host cleanup; step 3 native exit settles unit execution with cleanup quality separate |
| Round 5 F2: registration races closed runtime                                                                                        | Closed reducer admission fence                                                                                       | Step 2 kernel ownership and step 3 initial-unit lifecycle                                            |
| Round 5 F3: settled-history predecessor retention                                                                                    | Bounded reducer history evicts command/timer graphs, with data-only live unit ownership                              | Step 2 interpreter handle collection                                                                 |
| Round 5 F4: Traditional Chinese release parity                                                                                       | Existing docs retained                                                                                               | Step 6 removes obsolete host release integration; step 7 three-language parity                       |

## Interpretations

| Decision                                                                                                                             | Source                                                                        | Scope                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A completed unknown cleanup fact after confirmed native exit can satisfy retirement execution; known cleanup failure enters recovery | `phase-2.md:180–218`, especially fault cell at 379; `architecture.md:218–220` | The conclusion preserves the forced-retirement cause and Unknown cleanup fact. It never certifies finalizer success.       |
| A failed terminate command preserves the original evidence deadline                                                                  | `phase-2.md:125–126,180–196`; I5/I11 at 350,356                               | No repeated command failure creates another termination budget.                                                            |
| Recovery refreshes read-only premises but cannot overwrite an owned write version                                                    | `phase-2.md:226–230`; `architecture.md:460–468`                               | Resolve success is still simulated evidence until step 3 implements the fixed resolver/policy protocol.                    |
| The old model adapter is deleted with the duplicate model in step 1                                                                  | `phase-2.md:302–313,334–335`                                                  | Real interpreter conformance remains explicitly pending in step 2. No replacement adapter or compatibility layer is added. |

No architecture contradiction or Effect public-API gap has been identified in
step 1. Existing RPC completion and Scope attribution upstream requirements are
unchanged.

## 6. Checks and development failures

Build, test, formatting and git commands run through `devenv shell --`. The
read-only pipeline exception is recorded below. No packed script is invoked
directly.

| Check                                       | Result                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Frozen-lockfile installation                | Passed; bin warnings before packages were built                                                      |
| Initial shell formatting                    | Failed before installation: missing `@ianvs/prettier-plugin-sort-imports`; after installation passed |
| Baseline build                              | Passed; 92 public entries and 2,662 documentation pages                                              |
| Step 1 acceptance tests                     | 42 passed                                                                                            |
| Step 1 typecheck                            | Passed                                                                                               |
| Step 1 build                                | Passed; 92 public entries and 2,662 pages                                                            |
| Step 1 root tests                           | 332 files and 2,456 cases passed; 46 skipped; only the two allowed benchmark failures                |
| Step 1 independent docs tests               | Passed: 25 Node/TypeDoc tests and 41 Vitest cases in 21 files                                        |
| Step 1 final no-cache format and diff check | Passed; 1,236 files formatted with zero changes; working and staged diff checks passed               |

Expected failing acceptance batches and development failures are retained in
`.cache/phase2-step1-*.log`:

- Initial acceptance import failed because the production reducer did not exist.
- First implementation: three fixture/API errors (Array.some on an iterator,
  recovery fixture repeated Resolve, and no-old-unit acceptance fixture).
- Initial typechecks: unused import, widened timer/phase types, shutdown literal
  inference, Option access and iterator test types; corrected without casts or
  diagnostic suppression.
- A mechanical replacement inserted Status into two non-import positions;
  another changed a test loop delimiter. Parser, typecheck and formatter checks
  failed until the edits were corrected.
- Retargeting the exploration helpers temporarily broke old adapter imports;
  deleting the replaced adapter/model removed those errors. Test logging was
  removed in response to the globalConsole diagnostic.
- New retirement/evidence/history acceptance failed in three cells: forced
  retirement entered recovery, terminate failure renewed its timer, and history
  was not bounded. All three were implemented and passed.
- Fresh read-premise recovery initially failed because the write-ownership guard
  still included obsolete read versions; corrected to refresh reads and retain
  writes. Late forward Start acknowledgement initially advanced recovery;
  guarded by the current view and unit identity.
- The serving-transfer regression initially retained a healthy target under the
  Stuck Change owner. Transfer now happens at conclusion even while an old
  retirement exit is missing; late retirement cannot recapture that serving
  owner.
- A build and typecheck were started while the first root suite was still
  active. That suite finished with only the two known platform failures, but
  final checks are repeated serially to avoid overlapping its public-API build.
- Three delayed-time tests initially advanced an overdue operation, allowed an
  exit observed after its evidence deadline to abort, and accepted a trial
  report after total exhaustion. Affected-owner timer indexes now expire overdue
  fault deadlines before consuming reports; trial milestones still require their
  own events.
- Shutdown initially omitted already settled and idle serving units. The core
  now issues runtime-owned termination commands for those units, preserves
  execution capacity until exit, and changes current availability without
  rewriting outcomes. An arbitrary instance named `change-1` exposed owner
  identity collision; instance owners now use a disjoint namespace.
- A read-only `rg | tail` pipeline placed `tail` outside the devenv command
  prefix; subsequent pipelines use a shell inside devenv. No files were changed
  by that read.
- Settlement expansion after cancellation/shutdown or authorization invalidation
  initially omitted the newly required old-unit exit. Required obligations now
  expand monotonically while keeping the original evidence timer. The related
  health assertion also initially reported a Terminating current unit as
  healthy; the current projection requires Running execution.
- Idle exit and recreation initially retained ended serving-unit records after
  their Change history was evicted. Eviction now removes ended, noncurrent
  instance-owned records, and replacement removes an orphaned ended current
  record after its producing command history is gone. Retained keyed/history
  records and unresolved execution keep their evidence.
- Exploration count discovery initially used exact-count assertions for 161
  distinct states and 558 transitions. Expanding settlement ownership reduced
  the final bound to 159 distinct states while retaining 558 transitions. The
  final assertions and table record that result.

Earlier root runs passed 2,446, 2,447 and 2,454 cases, with only the same two
benchmark failures; source changes during those runs required the final serial
run recorded above. No check was intentionally interrupted.

The final two failures were exactly the allowed macOS benchmark exceptions, not
passes:

- `benchmarks/test/remote.test.ts`: checks identical work, lifecycle counts and
  native exits for every connection; the `/proc/self/fd/.../runner.sock` path is
  unavailable.
- `benchmarks/test/runner.test.ts`: resolves compressed sample files relative to
  nested result outputs; process auditing cannot scan `/proc`.
