# Phase 2 proof

Status: steps 1–3 implementation. Phase 2 is not complete. The production
reducer drives the Effect interpreter, inspection and native placement control.
Direct channels, calls and the gateway remain required. Native evidence below is
distinguished from finite reducer exploration.

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
| explores repeated exit, timer, failure, cancellation and shutdown reports to depth four | Six-event alphabet; depth 4; state deduplication        | Not a causal-shuffle count | 238 distinct states            | 648         |

`change-model/assertions.ts` checks claim conservation, complete reservation
ownership, monotonic versions, ended-unit lease release and immutable
conclusions after every explored transition. Failures retain stimulus names as a
causal trace. This finite exploration does not prove unbounded executions or
arbitrary topologies.

## 2. Interpreter and native execution conformance

`kernel-interpreter.test.ts` uses the production command queue. Its seven tests
cover intent before dispatch, exact reducer-produced notification snapshots,
complete executor causes, caller cancellation, stale/duplicate evidence, owner
shutdown and immutable handle completion after bounded history eviction.
`embedded-boundary.test.ts` has four tests: no implicit kernel installation,
deleted closure APIs, the public submission requirement and captured unit
membership guards. The interpreter has no strategy or settlement decisions.
Command and timer fibers are keyed in scoped FiberMaps; one scoped dispatcher
atomically hands transactional outbox entries to their command owner. Completion
mailboxes retain the core's immutable conclusion, never a writable status.

Real Worker/process exit and runner uncertainty still require step 3. The
protocol test service supplies external reports; it cannot edit core state,
claims, routes or outcomes.

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
in-process model adapter are deleted. Step 2 deletes the imperative engine, host
cleanup, managed registration and their writable status records. Public Change
operations now require Kernel; three-language guides describe that separation
and remove deleted driver, release-command and sample paths.

| Phase 1 review regression class                                                                                                      | Disposition through step 2                                                                                           | Remaining work                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Round 1 F1, F2: call-credit handoff and stable binding conflicts                                                                     | Driver assumptions deleted; new call/binding cells remain due                                                        | Steps 4–5                                                                      |
| Round 1 F3; round 3 F1; round 4 F2: fresh independent recovery authorization and exclusive recovery                                  | Reducer cases replaced; native current-policy integration remains due                                                | Step 3 current-policy integration                                              |
| Round 1 F4–F5; round 2 F1–F4; round 3 F2 and executor self-check: host waits, preparation, closing ownership and late causes         | Host mechanisms and tests deleted; scoped interpreter conformance added                                              | Steps 2–3 remove host execution; native unit tests replace waits               |
| Round 1 F6; round 2 F5; round 3 F3: live facts and recreated instances                                                               | Reducer projections, immutable conclusions and old-incarnation late exit cases                                       | Steps 2 and 6 public projection integration                                    |
| Round 2 F6: public export/reference completeness                                                                                     | Existing documentation tests retained                                                                                | Step 7                                                                         |
| Round 4 F1/F4 and serving-transfer self-check: one settlement classifier, complete obligations, known failure vs unresolved evidence | Reducer obligations/classifier; old exit/candidate/recovery evidence, immutable serving transfer and cleanup defects | Steps 2–3 remove old classifier and native-evidence conformance                |
| Round 4 F3: absolute preparation/cleanup budget                                                                                      | Absolute execution/recovery budget retained                                                                          | Step 3 inspection and cleanup                                                  |
| Round 4 F5: withdrawn generation dependency-cycle test                                                                               | Retained embedded test                                                                                               | Group/local captured-resource closure deferred to Phase 3                      |
| Round 5 F1: idle unit exit leaves host cleanup                                                                                       | Host cleanup and its watcher mechanism deleted                                                                       | Step 3 native exit settles execution with cleanup quality separate             |
| Round 5 F2: registration races closed runtime                                                                                        | Closed reducer admission fence and scoped command handoff                                                            | Step 3 initial-unit lifecycle                                                  |
| Round 5 F3: settled-history predecessor retention                                                                                    | Bounded reducer history evicts command/timer graphs, with data-only live unit ownership                              | Handle completion survives history eviction; native ownership remains due      |
| Round 5 F4: Traditional Chinese release parity                                                                                       | Existing docs retained                                                                                               | Step 6 removes obsolete host release integration; step 7 three-language parity |

## Interpretations

| Decision                                                                                                                             | Source                                                                        | Scope                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A completed unknown cleanup fact after confirmed native exit can satisfy retirement execution; known cleanup failure enters recovery | `phase-2.md:180–218`, especially fault cell at 379; `architecture.md:218–220` | The conclusion preserves the forced-retirement cause and Unknown cleanup fact. It never certifies finalizer success.       |
| A failed terminate command preserves the original evidence deadline                                                                  | `phase-2.md:125–126,180–196`; I5/I11 at 350,356                               | No repeated command failure creates another termination budget.                                                            |
| Recovery refreshes read-only premises but cannot overwrite an owned write version                                                    | `phase-2.md:226–230`; `architecture.md:460–468`                               | Resolve success is still simulated evidence until step 3 implements the fixed resolver/policy protocol.                    |
| The old model adapter is deleted with the duplicate model in step 1                                                                  | `phase-2.md:302–313,334–335`                                                  | Real interpreter conformance remains explicitly pending in step 2. No replacement adapter or compatibility layer is added. |

No architecture contradiction or Effect public-API gap has been identified in
steps 1–2. Existing RPC completion and Scope attribution upstream requirements
are unchanged.

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
  the step 1 bound to 159 distinct states while retaining 558 transitions. The
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

## Step 2 interpretations and checks

- `phase-2.md:304–319` requires deleting callers of removed APIs in the
  replacing step. Removing closure registration therefore also removes its
  Remote managed branch, release execution adapters and old gateway callers in
  step 2. The ordinary Remote host path remains for its later replacement.
  Release storage and journal validation remain; journal orchestration is
  deferred to phase 5.
- Public budgets normalize to numeric milliseconds in the pure reducer; keyed
  identity excludes current planning versions (`phase-2.md:147–157`). The
  embedded layer captures fixed unit membership once, so later Context-reference
  overrides cannot bypass legacy mutation guards. No managed registration is
  retained (`phase-2.md:298–303`).
- Timer executor failure is evidence, including its original Cause. Failure of
  an active evidence timer with unresolved units publishes Stuck rather than
  inventing exit (`phase-2.md:120–126,178–193`). Expected cancellation of an
  inactive timer records its Cause without changing a concluded outcome.
- Pure snapshots attached to Publish commands increase bounded repeated-event
  exploration from 159/558 to 238 states/648 transitions at the same depth and
  alphabet. Causal-shuffle counts are unchanged.

Development checks that failed: the initial missing interpreter modules (red);
wrong uninterruptible-mask application and missing inferred HashMap arguments;
yield-in-call-argument diagnostics; the new Schema class construction
diagnostic; unused imports and old Driver consumers during deletion; a circular
guard import initialization in the first full build; stale exact exploration
counts; the old packed gateway and dependent ecosystem harness in the first full
test run; a nested-Effect docs example; and the docs reference test's old
export/field expectations. All must be fixed before the step commit. The first
full root test run reported 302 files passed, 2 obsolete packed suites failed
and the 2 permitted macOS benchmark failures (2,231 cases passed, 3 failed, 45
skipped). No check has been deliberately interrupted. A filtered package
typecheck invocation was a no-op because the package has no such script; root
typechecking is required.

The next full root run fixed the packed harness and reported 303 files passed,
with the two permitted benchmark failures plus an incorrectly scoped membership
reference in the rewritten HMR test and an OTLP serialization race. The HMR
fixture now provides membership to layer construction. The OTLP fixture waits on
a Deferred after an explicit span ends, before disposal. Its first revision
failed typechecking (the Deferred was outside the layer closure and returned a
boolean); the corrected serialization test passes all four variants. The timer
executor test initially used a TestClock cleanup helper under a replacement
Clock; it now owns the interpreter directly, and all seven interpreter tests
pass. The subsequent full root run passed 305 files and 2,239 cases, with only
the two permitted benchmark failures and 45 skipped cases. The added timer fault
case is included in the final full-check rerun.

The new public request counterexample failed because normalized probe arrays
still referenced caller-owned storage. Effect Array.fromIterable is not a copy
for array inputs, so that first attempted fix also failed. Array.copy fixes the
alias. `input-normalization.test.ts` now has three passing cases: caller storage
cannot mutate retained identity, normalized defaults find keyed records before
stale/closing checks, and stale expected versions emit no execution commands.
There are 56 focused core/interpreter/boundary acceptance cases through step 2.

Final deletion review found that removing the journal's old Change-schema import
had unnecessarily widened persisted rejection validation to arbitrary JSON. A
new failing storage case rejects unknown tags and malformed Busy records. The
journal now keeps its strict version-one data schema locally; this is persisted
data validation, with no bridge from the new kernel to journal execution. The
new storage case passes with the five retained pure storage/journal cases. The
preceding full run passed 306 files and 2,243 cases (45 skipped), with only the
two permitted benchmark failures; the journal validation regression is included
in the final rerun below.

### Step 2 final verification

| Check                                        | Result                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Focused core/interpreter/boundary acceptance | 56 passed (42 reducer cases, 7 interpreter cases, 4 boundary cases, 3 normalization cases)  |
| Retained release storage/journal cases       | 6 passed, including strict version-one rejection validation                                 |
| Typecheck                                    | Passed                                                                                      |
| Build                                        | Passed; 91 public entries, 2,503 documentation pages                                        |
| Root tests                                   | 306 files / 2,244 cases passed; 45 skipped; only the two permitted macOS benchmark failures |
| Independent docs                             | 25 Node/TypeDoc checks and 41 Vitest cases in 21 files passed                               |

Final full-check logs: `phase2-step2-{typecheck,build,test}-release.log` and
`phase2-step2-docs-final.log` under `.cache`. No check was deliberately
interrupted. No packed script was invoked directly. All remaining unit,
transport, call and gateway acceptance is still required by steps 3–7.

## Step 3: preparation and native execution

The reducer owns inspection records before Resolve or Spawn, including their
claims, absolute deadline, command ids and native observer identity. Inspection
has term zero, a distinct preparation id and no serving grant. Only exact native
exit or confirmed prevention releases its claim. Describe is imported and
decoded inside a Worker or child. The subsequent execution independently checks
its resolved input fingerprint/environment and returns matching declarations
before Serve. Serving failures, diagnostics, cleanup and native exit remain
separate facts. The placement executor imports no business module.

`preparation-core.test.ts` has 21 cases: intent and inspection capacity before
action; pending keyed deduplication/conflict; Describe deadline/ack uncertainty;
late exit after preflight rejection; full multi-reason Cause; inherited total
budget; expanded footprint rejection; uncached full-capacity rejection; exact
verified cache identity; Runner Overlap rejection; current authorization; Start
declaration mismatch; uncertain spawn/consumed term; confirmed noncreation;
bounded settled history with unresolved records retained; fresh recovery
Describe using its reserved claim; termination reserve; and immutable
declaration snapshots. `native-evidence-core.test.ts` adds four cases for idle
failure/capacity, serving ownership transfer, stale incarnation and retirement
exit before Stop response. The existing 56 focused core/interpreter cases remain
required.

`native-units.test.ts` has eleven real-unit cases. Both Worker and Process reach
blocked contract import and blocked decoder stages before native termination;
querying the kernel remains possible. Both describe without activation, expose
the execution term and forcibly retire an old blocked finalizer while preserving
unknown cleanup. The runner owner observes real child exits; disconnecting its
control clients leaves execution evidence Missing. An additional Worker case
performs Restart at maxUnits=1 using the verified description. Embedded
Plugin.term fails with UnitOnly. Native deadlines are test guards and escalation
inputs, not proof of exit; each assertion reads exact unit evidence.

### Step 3 interpretations

- Inspection cache entries and settled preparation history are bounded by the
  runtime history limit. Pending/unresolved preparations remain regardless of
  that bound. A fully settled rejected key can plan again (phase-2.md:143–158).
- The fixed resolver supports JSON `$reference` values from current data-only
  policy values; no resolver callback enters the kernel. Authorization and
  reference resolution run again for every execution attempt (phase-2.md:97–98,
  171–177, 222–226). Recovery whose current resolution lacks a matching verified
  description performs a distinct inspection under its existing claim. It keeps
  the original deadline and cannot expand the member footprint.
- A lost Stop reply is unavailable protocol evidence, not a known failed cleanup
  Exit. It preserves its full Cause and lets termination/native evidence settle
  retirement. This handles either scheduling order of exit notification and the
  command waiter awakened by that exit (phase-2.md:184–189, 204–220).
- Runner control uses a fixed local socket and an independent execution owner;
  transport disconnect never becomes native exit. Worker and Process are owned
  locally; Runner remains Restart-only (phase-2.md:26, 135–141, 184–189).
- The former managed host preparation/allocation path was removed in step 2. The
  ordinary embedded Remote path is still scheduled for deletion with its
  dependent callers in step 6; it is not reachable from the new kernel entry
  (phase-2.md implementation-order rows 3 and 6).

### Step 3 development failures

Red tests failed for absent preparation/native APIs and the initial missing
runner owner API. Further failures exposed: declaration and unit data type
mismatches; wrong Effect v4 Array/Stream API names; callback/context inference
and unused imports; missing fixture exports; a parser error in a generated edit
(fixed before continuing devenv); inspection reservation/budget errors; uncopied
declarations; unbounded settled inspection records; omitted known-noncreation
settlement; and forward declarations reused during recovery. Native tests
exposed an eval Worker entry incompatible with NodeServices, a double-encoded
file URL, a fixture loading workspace TypeScript in plain Node, a missing
execution-term grant, and the race between native exit and an unavailable Stop
reply. Real stage assertions prevented bootstrap failures from falsely
satisfying blocked-import/decoder tests. The first full build failed on three
new guide links using source filenames instead of relative page URLs. Typecheck
initially also failed on stale published core declarations and yield-in-call
diagnostics; rebuilding the changed public entry and fixing the diagnostics
resolves those failures. No Effect API was patched, no genuine public-API gap
has been established, and no check was deliberately interrupted. Further
acceptance review removed the interpreter submission overload for normalized
internal requests; public submission now always follows public preflight. It
also found that pre-admission Busy rejection lost its conflict identities; the
new red case retains those in the preparation result. Removing a still-used
HashSet import briefly failed seven interpreter tests; the import is restored.
The first full root run passed 310 files and 2,279 cases, with 45 skipped cases
and only the two allowed macOS benchmark failures. Final full-check results are
recorded after completion.

The final failure review added the native inspection executor-failure cell: the
Cause had remained only on the unit, and inspection failure took the ordinary
serving-failure path. The reducer now retains the Cause and interrupted phase in
its preparation and terminates only that inspection. Its red Cause and phase
assertions are recorded in the step 3 development logs.

### Step 3 final verification

| Check                                        | Result                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Focused core/interpreter/boundary acceptance | 82 passed, including 21 preparation, 4 native-evidence and 1 preparation exploration case   |
| Real native unit acceptance                  | 11 passed: Worker, Process and runner owner                                                 |
| Typecheck                                    | Passed                                                                                      |
| Build                                        | Passed; 92 public entries and 2,569 documentation pages                                     |
| Root tests                                   | 310 files / 2,281 cases passed; 45 skipped; only the two permitted macOS benchmark failures |
| Independent docs                             | 25 Node/TypeDoc checks and 41 Vitest cases in 21 files passed                               |
| Formatting                                   | 1,197 files, zero changes; diff checks passed                                               |

Final logs are `.cache/phase2-step3-typecheck-final5.log`,
`phase2-step3-build-final4.log`, `phase2-step3-test-final2.log` and
`phase2-step3-docs-final2.log`. The preceding full run passed 2,280 cases with
only the same two allowed failures. No check was deliberately interrupted and no
packed script was invoked directly. Steps 4–7 remain required.

## Step 4: encoded binding and staged installation

The production binding validator and indexes now determine exact operation
subsets, shared captured-contract provenance, unary shape and wire tags.
Installation commands target each actual participant incarnation and placement.
Commit rechecks both cell ownership and binding availability. A failed partial
installation discards its view once and requires exact native exit from a
participant whose installation failed to acknowledge; late evidence cannot
rewrite Stuck.

Interpretations: phase-2.md lines 232–250 requires shared contract provenance
independently of implementation code; `contractArtifact` captures that shared
declaration artifact. A unit's fixed import/export bootstrap components belong
to its single logical plugin member (lines 31–33), and preserve the provider's
declared local services. A fresh recovery description can validate within the
original conflict footprint; it cannot expand it (lines 164–165 and 227–230). A
missing Install acknowledgement retains the responsible participant as an exit
obligation (fault table, partial-installation row).

Evidence: `binding-core.test.ts` has 13 cases covering I2–I5, I8, I10 and I12,
including provenance/tag/subset counterexamples, partial and stale
acknowledgements, install timeout, Stuck and late exit, and revalidation before
commit. `unit-bindings.test.ts` has 5 native cases: codec transforms, typed
error prototypes, provider Context/Scope/term, caller-header filtering,
Worker/Process/runner placement, invalid declaration rejection before execution,
and an unrelated second binding preserved by a local patch. `contract.test.ts`
replaces throwing-constructor assertions with 14 pure declaration-validation
cases. Existing core suite: 78 files / 825 cases before the final
missing-endpoint case passed.

Red checks exposed double route-version advancement, Discard retry recursion, a
stale forward-view test helper in recovery, missing participant exit ownership,
missing provider-local bootstrap services, arbitrary caller headers crossing the
direct channel, and unavailable participant activation. All are fixed. Typecheck
also rejected native array helpers, inferred any conditions in a fixture, and
stale public declarations; these are corrected before final verification. Two
commands accidentally filtered the nonexistent package `@graftland/core` and
performed no checks; the correct package `@graftland/graft` was subsequently
checked. No check has been deliberately interrupted.

A participant receives only routes whose consumer is its own instance. The red
local-patch assertion caught a provider receiving consumers’ patches; the
emitted view now filters the already indexed affected routes.

The final Start-envelope red test rejects a serving-provider description without
its endpoint before Serve; inspection declarations alone cannot create a usable
route. Full checks are repeated after this change.

### Step 4 final verification

| Check                  | Result                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Binding acceptance     | 13 reducer cases; 5 native channel cases; 14 contract declaration cases passed        |
| Existing native faults | 11 passed                                                                             |
| Typecheck and build    | Passed; 92 entries and 2,599 documentation pages                                      |
| Root tests             | 312 files / 2,299 cases passed; 45 skipped; only the two permitted benchmark failures |
| Independent docs       | 25 Node checks and 41 Vitest cases in 21 files passed                                 |
| Formatting             | 1,205 files, zero changes; staged diff checks passed                                  |

Final logs: `phase2-step4-typecheck-final4.log`,
`phase2-step4-build-final3.log`, `phase2-step4-test-final3.log`,
`phase2-step4-docs-final3.log`, `phase2-step4-format-final3.log` under
`.cache/`. Two preceding full runs passed 2,298 cases with only the same
permitted failures, before the final endpoint case. No check was interrupted.
Steps 5–7 remain required.

## Step 5: owned single-hop calls

Production call admission, exact provider selection, session-qualified credits,
Restart waiters, cancellation, completion classification, expiry and native-exit
settlement now belong to the reducer. A fixed provider registration precedes the
consumer dispatch grant. Business values remain on the encoded direct channel.
Required call credits participate in Change settlement; results and cancellation
alone cannot release them. Provider exit settles only that incarnation's calls;
consumer exit preserves provider execution.

`call-core.test.ts` contains 23 cases covering I1–I3 and I5–I12. Its cells
include result-before-cleanup, pre-registration and post-dispatch cancellation,
cancellation overtaking the admission queue, duplicate/lost completion, reused
ids across sessions, independent providers, missing exit and immutable Stuck,
drain expiry, waiter exit/shutdown/expiry/overflow, control failures, known
cleanup failure, first startup, current-policy recovery, and serving ownership
transfer. `call-exploration.test.ts` imports the production reducer: 60 causal
shuffles / 189 state visits / 188 transitions; repeated evidence at depth 3 with
alphabet 5 reaches 93 distinct states and 135 transitions. Every explored state
checks credit conservation and exact provider ownership. The complete core suite
passes 80 files / 851 cases before final workspace verification.

Native evidence: `unit-bindings.test.ts` has 8 cases, including a received
result with blocked owned cleanup, real nested second-hop rejection, and runner
control disconnect during drain producing Stuck with the call and exact missing
unit retained. `owned-completion.test.ts` has 7 cases for original Exit, blocked
cleanup, cancellation before registration, retained/duplicate/lost delivery,
finalizer defects, deferred rejection and reporter failure. The existing 11
native fault cases remain. `rpc-scope-limit.test.ts` preserves three Effect-only
counterexamples. The old prototype routing coordinator and its four fixtures are
deleted, rather than retained as an oracle. The upstream draft now links these
minimal reproductions and states the narrower Graft-owned guarantee.

Interpretations (phase-2.md lines 241–258): the supported completion boundary is
the Graft-supplied handler Scope, not RpcServer's private Scope. No Effect
implementation, private request map or diagnostic parsing is used. Unary handler
effects and all contract middleware run inside the owned Scope. Deferred
replies, discarded calls, streams and nested cross-unit completion cannot
silently gain the guarantee. Live credits and gate waiters have independent
global limits; cancellation, native exit and completion use reserved control
traffic. Encoded frames retain the existing 1 MiB limit. The kernel outbox,
native input and evidence queues are bounded. Runtime-lifetime request identity
tombstones are retained independently of bounded settled call history. These
bounds do not promise universal process-memory limits.

Two earlier omissions were found while completing the native call cells.
Phase-2.md lines 227–230 excludes a restoration generation for an instance which
has never served; the core now records that starting fact and rejects that
spurious recovery. The old preparation recovery case was initialized as a new
instance; it now starts from a previously serving instance with native exit
evidence. Recovery health and call authorization follow the actual generation
under current policy, rather than a denied desired target. New red reducer tests
prove both corrections. Call failures after serving ownership transfers cannot
attach to old concluded Changes.

Development failures: the initial call and owned-Scope acceptance files failed
before implementation. Subsequent red cases found retirement starting before
completion, cancellation joining a blocked finalizer, immediate fiber start
racing registration, cancellation overtaking its request, missing
pre-registration cancellation fencing, control failure Causes being discarded,
consumer-exit Pending results, known cleanup failure being overwritten, and
deferred reply escape. Typechecks rejected wrong Reference construction,
non-finite number schemas, missing public generic requirements and exports,
inferred fixture types, inline test yields, and missing resource fields. These
were fixed without casts or disabled diagnostics. A new native drain fixture
initially exceeded the total reserve budget; its total budget is corrected. A
runner fixture initially omitted the owner identity and correctly failed schema
validation. The minimal RPC reproduction initially supplied an Effect instead of
a handler function. Exploration count assertions changed as the production state
gained cancellation and retirement facts; final counts above are asserted. No
check was deliberately interrupted and no packed script was run directly. Full
workspace results follow after verification.

The first full step 5 run passed 315 files / 2,330 cases, with 45 skipped and
only the two permitted failures. Docs passed 25 Node checks and 41 Vitest cases.
Its build generated 92 entries / 2,632 pages and formatting changed zero of
1,211 files. A final byte-boundary audit then added `encoded-limit.test.ts`:
logical unary size is checked before dispatch, including UTF-8 expansion and
unencodable input with its original Cause. Control framing uses a bounded queue
with socket backpressure and counts UTF-8 bytes. Fixed native frames are bounded
before send and validated on receipt. Full checks are repeated after these
changes.

The byte-boundary rerun initially failed typecheck/build and the root public-API
setup: the serializer used JSON.stringify inside Effect and a fixture used the
uncurried String.repeat form. The implementation now uses
Schema.fromJsonString(Schema.Unknown), retaining its typed SchemaError Cause;
fixtures use Effect String.repeat. All three new size cases pass, including
UTF-8 bytes and an unencodable bigint. The failed root run stopped in global
setup and has no passed-case count. No check was deliberately interrupted.

### Step 5 final verification

| Check                     | Result                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Core                      | 80 files / 851 cases passed, including 23 call cases and 2 exploration cases                   |
| Native and Scope evidence | 11 native faults, 8 bindings, 7 owned completion, 3 Effect-only limits and 3 size cases passed |
| Typecheck and build       | Passed; 92 entries and 2,632 pages                                                             |
| Root tests                | 316 files / 2,333 cases passed; 45 skipped; only the two permitted benchmark failures          |
| Independent docs          | 25 Node checks and 41 Vitest cases in 21 files passed                                          |
| Formatting                | 1,213 files, zero changes; diff checks passed                                                  |

Final logs under `.cache/`: `phase2-step5-typecheck-final5.log`,
`phase2-step5-build-final3.log`, `phase2-step5-test-final3.log`,
`phase2-step5-docs-final3.log` and `phase2-step5-format-final3.log`. Steps 6–7
remain required.

## Step 6: public control and the fixed gateway

Public control uses fixed JSON codecs, a loopback TCP endpoint and a connection
capability. The server forwards submit, inspect, get, await, cancel, policy and
shutdown requests to Kernel. It holds transport mailboxes and request fibers,
not writable lifecycle facts. Reconnecting a client never constructs a new
Change. Unknown or expired unkeyed ids fail with UnknownChange rather than
waiting forever.

The gateway fixture is an actual Worker with one long-lived upstream TCP
session. Its injected unary contract reaches native providers. Its business
replies include the provider version and term and the gateway session identity.
Changes, preparation failures, residual units and execution credits are observed
only through Control clients. A separate-process test launches the fixed JSON
kernel executable and performs submit, await, query and shutdown across TCP.

Acceptance evidence:

| Test file              | Evidence                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gateway.test.ts        | Worker, Process and Runner Restart; public waiter facts before dispatch; old native exit; unchanged gateway generation and session; old-call Overlap pinning; new code after commit; B completes during A trial; startup Aborted and fresh Recovered trial                                                    |
| gateway-faults.test.ts | Worker/Process stalled import and decoder before admission; B progress and unchanged session; current-policy denied recovery; real stalled handler and finalizer with explicit native barriers; Runner disconnect produces immutable Stuck, retains claims and rejects conflicting A while Worker B completes |
| public-control.test.ts | Keyed dedupe; query/outcome equality; interrupted await and disconnect/reconnect; wrong capability rejection before unit allocation; independent kernel process                                                                                                                                               |
| deleted-host.test.ts   | No default or plugin activation export, host/runner connection entries, CLI, Config or schema adapter                                                                                                                                                                                                         |

The obsolete ordinary Remote host path, host contract loading, execution
clients, old connectors, launchers and their dependent test fixtures are
removed. The Contract descriptor has one owned unit server path. Release
data/storage and journal models remain unported. The old YAML Remote sample, its
CLI reload cases, the Remote execution benchmark and the direct author-host
conformance launcher are removed with their execution path. Independently useful
embedded and author metadata/codec tests remain.

### Step 6 interpretations

- Phase 2 lines 33–34 and 262–289 require fixed deployment data and external
  metadata control, not a discovery loader. The executable accepts a JSON
  deployment and writes its ready address; it never imports a business module.
- Lines 275–289 require current residual facts and sequenced observation. Public
  waiters are a projection of core callWaiters, so the Restart fixture can prove
  queue residence before dispatch without a test protocol adapter.
- Lines 346–357 distinguish leases from execution claims. A Stuck generation
  with no captured lease has zero leaseHolders while its unit claim and object
  reservation remain held. The Runner test checks Missing exit evidence, the
  retained owner/claim, conflicting Busy and unrelated progress.
- Lines 286–291 permit bounded observation history and reconciliation. The
  control transport bounds in-flight requests and notification queues; losing
  notifications requires querying the same core id. It does not persist history.

### Step 6 development failures

Intentional red checks: missing public control modules; absent gateway fixture;
removed-export assertions before deletion; missing waiter query; missing fixed
kernel executable; missing native finalizer barrier; missing independent B
fixture. The first finalizer assertion passed without a native barrier and was
strengthened before it was accepted as evidence.

Typecheck failures included PubSub.Subscription passed to Stream.fromQueue,
Effect 4 filterMap requiring Result rather than Option, optional-key
assignability, untyped empty HashMap inference, missing SecureRandom service,
native crypto diagnostics, yield-in-argument diagnostics, old Controller await
error types, unused imports, stale installed core declarations, native child
process diagnostics, encoding a typed target with the Json encoder, and an
optional conflicts assertion. All were corrected without casts or broad
diagnostic suppression. The fixed executable uses two single-line
strictEffectProvide exceptions with composition-root reasons.

Runtime checks caught a fixture JavaScript escaping error, the Runner socket
path, an insufficient total budget for two long trials, a lost reply to the
deliberate trial crash, a barrier socket left open after a held call, and a test
clock advanced to Restart's stop deadline before native exit. The fixture now
owns/closes the barrier socket and waits for native progress; timeout does not
stand in for completion. The earlier held-call run phase2-step6-gateway9.log was
interrupted with SIGTERM after timeout while these fixture problems were being
corrected. Other timed-out debug runs ended through Vitest; two attempted
signals found that their process had already ended.

The first complete Remote test run failed three obsolete YAML activation cases
in entries.test.ts; those cases and their dead helper are deleted with that API.
The first root test run failed in the CLI global setup, which still built four
deleted host entry points; its dependent Remote reload cases and setup branch
are deleted. Public declaration expectations for removed exports were updated.

Build attempt 1 failed on 22 stale local documentation links after host guide
deletion. The links and landing navigation were corrected. Documentation tests
passed 25 Node cases and 39 doctests after deletion. An offline lockfile-only
resolution failed because pnpm had no avvio registry metadata. Removing only the
deleted sample importer followed by frozen offline installation succeeded with
resolution skipped. One shell entry was stopped by formatting a malformed
temporary trace string; it was repaired immediately. A malformed shell quote and
a JavaScript orchestration syntax error executed no requested checks.

Packed proof scripts were not invoked directly. The replacing packed fixture and
final deletion/proof inventory belong to step 7.

### Step 6 final verification

| Check                                | Result                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Frozen offline install               | Passed after deleting only obsolete dependency/importer declarations; no dependency resolution                             |
| Typecheck                            | Passed                                                                                                                     |
| Build                                | Passed; 71 public entries, 2296 documentation pages                                                                        |
| Full tests                           | 284 files; 2092 passed, 45 skipped; only the permitted benchmark runner /proc failure                                      |
| Remote acceptance and retained tests | 21 files, 156 cases; includes 5 gateway schedules, 8 gateway fault cases, 4 public control cases and 1 deleted-export case |
| Documentation tests                  | 25 Node cases and 39 doctests in 19 files                                                                                  |
| treefmt --no-cache                   | 1039 files, zero changed                                                                                                   |

Final logs are phase2-step6-typecheck-final5.log, build5.log, test4.log,
docs5.log and format4.log under .cache. The previous full test run also had 2092
passing cases and the same sole permitted failure. A preceding run found the
removed chat sample setup had also removed isolated-home registration; the
independent isolation setup is retained. The last test typecheck edit briefly
omitted the describing fixture variable and was immediately corrected; the
subsequent typecheck and complete checks passed.

No spec contradiction or Effect public-API blocker was identified in step 6.
