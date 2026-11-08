# Phase 2 proof

Status: steps 1–7 implemented in order. The checks below distinguish native
execution evidence, finite reducer exploration, and owner-run packed
verification. No architecture contradiction or new Effect public-API blocker was
identified. The owner explicitly reserves packed execution; the packed fixture
is implemented but its execution is **not certified by this report**.

## 1. Production reducer exploration

Production `core/src/internal/decisionCore.ts` and its preparation, binding and
call reducers own decisions. Exploration imports this implementation. State is
immutable data: records, HashMap, HashSet and Option; no Effect, callback,
Deferred, Scope, Fiber or native handle. External reports and timers drive every
transition; the harness has no Commit, Finish or Recover shortcut.

| Test                                                                                                                                           | Bound                                         | Schedules | State visits / distinct states | Transitions |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------: | ------------------------------ | ----------: |
| change-model: explores every causal shuffle of independent Changes using production commands                                                   | Two ordered nine-report actors                |    48,620 | 184,755 visits                 |     184,754 |
| change-model: explores conflicting admission and shutdown in every causal order                                                                | Three one-event actors                        |         6 | 16 visits                      |          15 |
| change-model: explores exclusive recovery alongside an unrelated commit without overwriting it                                                 | Eight-report recovery and two-report B        |        45 | 219 visits                     |         218 |
| change-model: explores repeated exit, timer, failure, cancellation and shutdown reports to depth four                                          | Six-event alphabet, depth 4, deduplicated     |         — | 238 distinct                   |         648 |
| preparation-exploration.test.ts: explores every preparation, duplicate and current-policy shuffle through the production reducer               | Fixed inspection/independent admission actors |        42 | 160 visits                     |         159 |
| call-exploration.test.ts: enumerates causal result, cancellation, duplicate completion and native exit shuffles through the production reducer | Fixed call, drain and completion actors       |        60 | 189 visits                     |         188 |
| call-exploration.test.ts: explores repeated call evidence to depth three without a second model                                                | Five-event alphabet, depth 3, deduplicated    |         — | 93 distinct                    |         135 |

The scenario assertions check conservation, complete reservation ownership,
monotonic versions, exact exit release and immutable conclusions after every
transition. Failure reports preserve the causal trace. These finite bounds do
not prove arbitrary topologies or unbounded executions.

## 2. Interpreter and native conformance

`kernel-interpreter.test.ts` replays production commands and compares published
snapshots with reducer projections. Its seven cases cover intent before
dispatch, full executor causes, cancelled waiters, stale/duplicate reports,
closing owner, evicted handle completion and failed timer execution. Scoped
FiberMaps own command and timer fibers; the interpreter retains handles and
reports evidence, without choosing outcomes or changing a counter.
`kernel-deadline.test.ts` adds two regressions: an early fractional sleep is
rechecked before TimerFired, and a sleep-executor failure retains its complete
Cause. Both lifecycle and call waiter timers use this clock boundary.

Native evidence is separate: `native-units.test.ts` kills actual blocked Worker
and process import/decode/finalizer execution, verifies Describe does not apply,
checks granted terms and full-capacity verified Restart, and distinguishes
runner disconnect from exit. `gateway-faults.test.ts` proves actual synchronous
infinite handlers and never-finishing finalizers cannot block the kernel. The
independent runner owner observes native processes; losing its transport retains
Missing execution rather than asserting death. Unit-only business imports are
outside the kernel process. Effect-only RPC request-scope tests remain evidence
of the upstream limitation, not a general drain guarantee.

## 3. Invariants, counterexamples and fault cells

Names below are test-title fragments; each file contains the invariant ids in
its full titles. All expected results are accompanied by member health/actual
facts, exact claims or credits, and exit/cleanup or missing-evidence assertions.
The JSON disposition inventory gives additional per-regression names.

| Invariant and counterexample                                               | Production acceptance evidence                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1: interpreter-chosen success or writable stale status                    | decision-core: full original command/cleanup causes; kernel-interpreter: intent and projected notifications; public-control: repeated handle/get reconciliation                                               |
| I2: duplicate exit release, old owner clears new owner                     | decision-core: keeps Stuck local and exact late claims; call-core: completion dedupe and only exited provider credits; decision-fault-matrix: every candidate/recovery exit                                   |
| I3: snapshot commit erases B, absence ABA, global Stuck barrier            | decision-core: both commit orders and complete atomic conflicts; change-model: 48,620 shuffles; decision-access: actual accesses with 2,000 active B Changes; gateway-faults: B completes beside runner Stuck |
| I4: contract refinement blocks kernel                                      | native-units and gateway-faults: blocked import/decode; phase2-boundary: fixed kernel import graph has no business/contract/plugin modules                                                                    |
| I5: timeout/ack/disconnect fabricates exit                                 | decision-core: never manufactures NotStarted and confirmed prevention; preparation-core: uncertain inspection/creation; native-units: runner disconnect; kernel-deadline: fractional early wake               |
| I6: dead unit holds lease, forced kill certifies finalizers                | decision-core: only exited unit leases with separate cleanup; change-model-settlement: forced retirement Unknown vs known failure; gateway-faults: native blocked handler/finalizer exit                      |
| I7: Aborted after Stop, stale authorization or forward Overlap in recovery | decision-core: old-changed before Stop and independent exclusive recovery; gateway: failed trial fresh Recovered; gateway-faults: denied current recovery policy                                              |
| I8: stale installation activates, queued call prematurely binds            | binding-core: exact required participant/incarnation and missing ack; unit-bindings: installed direct encoding; gateway: pinned old call, new code, Restart public waiter without provider                    |
| I9: result/cancel frees blocked cleanup                                    | call-core: retains credit after result/cancel, consumer exit and disconnect; owned-completion: actual independently owned scope and retained completion; Effect-only scope evidence states the limit          |
| I10: late exit rewrites Stuck or transfers future work back                | decision-core: immutable conclusion after recreation; change-model-settlement: fixed serving transfer; call-core: instance-owned later failures; public-control: disconnected observer reconciles             |
| I11: total resets after preparation/recovery or one trial reserve          | preparation-core: original total and inspection termination reserve; change-model-settlement: absolute deadline and fresh term; decision-fault-matrix: recovery stalls and expired recovery trial             |
| I12: unsupported topology silently falls back                              | decision-core: group/local-service/Runner Overlap rejection; binding-core: duplicate/stream/provenance checks; call-core: nested dispatch and saturation rejection                                            |

| Spec fault cell (phase-2.md:370–388)                       | Named test evidence                                                                                                                                                                                                                                    | Outcome and residual assertion                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-admission Busy/stale/budget/topology/capacity          | decision-core: reserves every conflict object atomically; decision-fault-matrix: rejects invalid and insufficient two-trial budgets; preparation-core: rejects uncached inspection at full capacity; binding-core: rejects incompatible fixed bindings | Rejected without Change; old usable, inspection separately owned, conflict facts retained                                                   |
| Describe import/decode/check fails or stalls               | gateway-faults: exposes placement stalled fault rejection; native-units: terminates real placement blocked in fault                                                                                                                                    | Rejected with preparation correlation, native inspection Exited; B Accepted while A pending; missing exit retains claim in preparation-core |
| Candidate fails before old changed                         | gateway: settles failed startup as Aborted and failed trial as fresh Recovered; decision-fault-matrix: stalled forward operation before old change                                                                                                     | Aborted only after candidate exit; old healthy and serving, no candidate claims                                                             |
| Candidate fails after old stop                             | decision-fault-matrix: restores service after stalled forward operation following old stop with full recovery trial                                                                                                                                    | Recovered only after fresh Serving and full trial; old/candidate ended, recovery instance-owned                                             |
| Overlap trial fails, Restart-only previous target          | change-model-settlement: retains absolute deadline and fresh term across Overlap failure and Restart-only recovery                                                                                                                                     | Recovered exclusively, no forward Overlap requirement or renewed total                                                                      |
| Revoked recovery, lost owned version, failed recovery      | decision-core: does not reuse revoked recovery authorization or overwrite lost owned version; gateway-faults: reauthorizes fresh recovery after denial                                                                                                 | RecoveryFailed after required exits, unhealthy/stopped actual; unrelated facts intact                                                       |
| Candidate Start/Serve/Ready/Probe stalls before old change | decision-fault-matrix: settles stalled forward operation before old change (four cases)                                                                                                                                                                | Terminate requested, Aborted after exit, old target healthy                                                                                 |
| Candidate Start/Serve/Ready/Probe stalls after old stop    | decision-fault-matrix: restores service after stalled forward operation (four cases)                                                                                                                                                                   | Recovered after complete fresh trial; exact failed claims released                                                                          |
| Old drain/stop stalls during Restart                       | gateway-faults: terminates integration with stalled handler/finalizer                                                                                                                                                                                  | Forced native old exit, Recovered rather than Aborted, call credit settled, same gateway session                                            |
| Overlap old retirement stalls after successful trial       | change-model-settlement: accepts forced Overlap retirement with unknown cleanup only after native exit; native-units: embedded finalizer cannot finish                                                                                                 | Accepted after exact exit, old claims released, cleanup remains Unknown; known cleanup failure follows recovery case                        |
| Recovery Start/Serve/Ready/Probe/trial stalls              | decision-fault-matrix: stalled recovery operation (four cases) and expired recovery trial                                                                                                                                                              | RecoveryFailed only after own exit, no healthy serving generation, no residual Change leases/units                                          |
| Admitted spawn/termination uncertain                       | decision-core: never manufactures NotStarted; binding-core: exact missing participant exit as Stuck; gateway-faults: runner disconnect with B                                                                                                          | Stuck, exact unconfirmed claims/conflicts retained; independent B Accepted                                                                  |
| Late/duplicate exit and recreation                         | decision-core: keeps Stuck local and does not rewrite conclusion after recreation                                                                                                                                                                      | Original conclusion unchanged, release once, new incarnation unaffected                                                                     |
| Defective/unattributed cleanup                             | change-model-settlement: known retirement cleanup failure as failed success evidence; call-core: complete defect and unknown cleanup separate                                                                                                          | Failed required success enters recovery; exact execution released, original Cause retained; Scope attribution reproductions retained        |
| Unary result then blocked cleanup/cancel                   | call-core: retains execution credit after result and cancellation; owned-completion: independently owned finalizer barriers                                                                                                                            | Result received with credit outstanding; cancel alone cannot discharge drain                                                                |
| Lost completion or runner disconnect/lease without exit    | call-core: lost completion until provider exit and immutable Stuck; native-units: runner disconnect is not native exit                                                                                                                                 | Unknown pending result, no retry, unit/call claims retained until evidence                                                                  |
| Wrong/partial installation                                 | binding-core: stale participant/view, discards partial staged views, missing participant exit as Stuck                                                                                                                                                 | No activation; settle all required participants before Aborted/recovery, retain exact missing obligation                                    |
| Queue overflow/expiry/cancel before dispatch               | call-core: rejects nested dispatch and saturation; expires/cancels Restart waiters; cancellation overtakes admission                                                                                                                                   | NotAdmitted or removed waiter once, zero credit before dispatch                                                                             |
| Shutdown races admitted work                               | kernel-interpreter: closing owner; change-model-settlement: retains old exit obligations after cancellation; decision-core: closes admission                                                                                                           | RecoveryFailed when service stopped, Stuck when evidence missing; no new registration/Aborted fiction                                       |

## 4. Gateway, boundary and locality

`gateway.test.ts` (five cases) and `gateway-faults.test.ts` (eight cases) use
public Control submission/queries with actual units. The runnable
`samples/integration-gateway/src/main.mjs` goes further: a separate fixed kernel
process coordinates unchanged gateway execution, actual v1/v2 JavaScript
entries, a held old call and new unary dispatch.
`scripts/gateway-sample.test.mjs` runs Worker Overlap, process Restart and
runner Restart. It verifies version 1 then 2, one upstream session, one gateway
unit, old native Exited, selected target health, ExplicitTarget reason, zero
Change leases/unconfirmed units/credits, remaining budget and causes. Control
reconnects by id during the trial. `public-control` also proves interrupted
await/disconnect do not cancel admitted work.

`phase2-boundary.test.mjs` follows runtime source imports from fixed kernelMain,
rejects contract/embedded/plugin modules, samples and dynamic import calls, and
imports all three fixed executables in a child process to verify import inertia.
The blocked-contract fixture independently demonstrates the execution boundary.
`decision-access.test.ts` wraps actual Effect collection operations while
executing the production reducer, propagates identity labels through immutable
writes, and detects enumeration even after a write. Twenty-two admission,
commit, failed candidate, exclusive recovery, late report, duplicate exit and
get operations have identical visited-key counts with zero and 2,000 unrelated
active Changes. Neither run enumerates a global index or reads an unrelated key.
The probe self-test deliberately enumerates a changed instances map and reads B
to prove detection. The probe metadata is outside core state. This establishes
the measured footprint, not constant latency under saturation.

## 5. Deletion, docs and public types

The [deletion manifest](phase-2-deletion-manifest.md) and
[per-case JSON inventory](phase-2-test-disposition.json) map all original 147
core/Remote/release test modules, 742 literal entries plus full parameterized
patterns, and 61 review regression rows. Duplicate title occurrences share one
JSON entry with an occurrence count. Embedded provenance/release tests remain
embedded evidence. Captured local closure is explicitly Phase 3; kernel release
batch/compensation is Phase 5. Every removed host API has no adapter, legacy
switch or executable stub. The old integration-gateway fixture packages are
replaced by the runnable public sample. Old benchmark results remain data.

Three-language unit, binding, call, control and Remote docs describe only the
final supported slice. The sample READMEs have identical structure and commands.
TypeDoc plus public declaration signature traversal checks exported types.
`Release.ts` and attribution reproductions remain; forced exit does not solve
Effect's interruption provenance or general RpcServer scope completion.

## 6. Verification scope

Every implementation step ran typecheck, build, root test, independent docs test
and no-cache formatting before commit. Exact historical counts and failures
follow. The only allowed residual root failure after Step 6 is benchmark
`runner.test.ts` /proc lookup on macOS; the obsolete Remote benchmark executable
and its test were deleted with the old host path.

`scripts/packed-gateway.mjs` packs release copies, installs tarballs inside
`.cache/packed-consumers`, and runs the same public sample with Worker Overlap,
process Overlap and runner Restart. It does not import workspace source or
expose an internal protocol to the sample. It has **not been run**, following
the owner's explicit prohibition on invoking packed scripts. Packed runtime
proof item 6 therefore remains owner verification, not a claimed pass. No
independent review was started; the owner requested one review after all
implementation steps.

## Interpretations

| Decision                                                                                                                             | Source                                                                        | Scope                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A completed unknown cleanup fact after confirmed native exit can satisfy retirement execution; known cleanup failure enters recovery | `phase-2.md:180–218`, especially fault cell at 379; `architecture.md:218–220` | The conclusion preserves the forced-retirement cause and Unknown cleanup fact. It never certifies finalizer success. |
| A failed terminate command preserves the original evidence deadline                                                                  | `phase-2.md:125–126,180–196`; I5/I11 at 350,356                               | No repeated command failure creates another termination budget.                                                      |
| Recovery refreshes read-only premises but cannot overwrite an owned write version                                                    | `phase-2.md:226–230`; `architecture.md:460–468`                               | Resolve is a fixed data protocol; native preparation and current-policy integration were added in steps 3–6.         |
| The old model adapter is deleted with the duplicate model in step 1                                                                  | `phase-2.md:302–313,334–335`                                                  | Step 2 supplies real interpreter conformance. No driver compatibility adapter is retained.                           |

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

## Step 7: public slice, access audit and final manifest

The public executable is `@graftland/plugin-remote/kernel`; its old
`./internal/kernel` export is removed rather than aliased. It accepts fixed
Deployment data and writes the ready Address. Imports remain inert. The sample
uses only public SDK entries and ordinary application-owned socket code, never
kernel/private framing. Its captured artifacts live under the sample's cache so
Node resolves declared package dependencies through the installed package
ancestry; no workspace node_modules is symlinked or copied to another workspace.
The packed fixture stages installed release copies inside this worktree.

| Interpretation                                                                                                                  | Controlling source                                                           | Consequence                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The fixed gateway may have a client/driver outside the kernel and must not install business control-plane plugins in the kernel | phase-2.md:33–37, 262–289; architecture.md section 1.3                       | Fixed executable plus data-only deployment, business gateway and integration in units, public capability control                                              |
| A timer reports observed time at or after its absolute deadline; an early platform wake is not deadline evidence                | phase-2.md:125–126, 159–160; I11 at 356                                      | Recheck the clock before lifecycle/call TimerFired/CallExpired; the reducer still decides its meaning. This is interpreter correctness, not an Effect API gap |
| Stopped/unavailable actual membership may retain the known target identity while health is false                                | phase-2.md:205–209, fault table at 375/380; architecture.md sections 5.5–5.6 | RecoveryFailed matrix asserts unhealthy actual plus exact native/claim settlement; it does not invent None as an extra specification requirement              |
| Packed execution is reserved for the owner despite the general proof checklist                                                  | Owner's explicit instruction; phase-2.md:413–419                             | Implement and statically check the fixture, run the ordinary public sample, report packed runtime execution as unverified                                     |

### Step 7 failures and interruptions

Logs are `.cache/phase2-step7-*.log`; none is committed. Expected red tests and
development failures are recorded separately from final verification.

| Attempt                             | Failure and resolution                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| boundary-red                        | Runnable sample and per-case inventory absent: two failures; import boundary and inert entry imports passed. Added the sample, packed fixture, complete inventory and public executable export                                                                                                                                                                                   |
| boundary-red2                       | CLI project filter `scripts` matched no Vitest project; corrected to `@graftland/workspace`                                                                                                                                                                                                                                                                                      |
| access-red, access1–3, typecheck1–3 | Missing helper, Effect 4 sort/iterator assumptions, async mock factory diagnostic and missing test fields; implemented real collection instrumentation and corrected public APIs. An arbitrary 250-operation bound was removed: the acceptance property is equality/no unrelated reads, not an invented numeric limit. Final two access tests pass                               |
| sample-red                          | Three sample processes could not resolve newly declared platform dependency before installation; frozen offline installation passed after updating only the sample importer                                                                                                                                                                                                      |
| sample1                             | Artifact store at repository root could not resolve the sample's declared Remote dependency. Moved the store under the sample cache; no node_modules symlink workaround                                                                                                                                                                                                          |
| sample2                             | Report used nonexistent plural Status.members rather than member; corrected the report. Process and runner then completed real Restart                                                                                                                                                                                                                                           |
| sample3, boundary-sample1           | Real Worker Overlap hung because the native clock woke just before a fractional trial deadline; the early event was correctly rejected by the reducer, but the interpreter never rearmed. The ordinary sample was explicitly stopped with SIGTERM (owned PID 31383); Vitest's 45-second child guard timed out the other attempt. Both are failures, not exit proofs              |
| deadline-red                        | Missing clock-boundary implementation, as expected. Added a deterministic early-wake and complete-failure test before implementation                                                                                                                                                                                                                                             |
| deadline1–2, typecheck5             | Test used nonexistent Effect.flipCause and yielded in assert argument; changed to Exit observation and explicit values. First repeated-effect implementation inserted a zero-duration schedule sleep, so the exact sleep-count assertion failed. Replaced it with a small named recursive effect, no schedule side effect. Eleven focused interpreter/deadline/access tests pass |
| typecheck4                          | Ran while workspace public-test setup rebuilt declarations; missing declaration cascade. Repeated sequentially after builds; passed. This attempt is not a typecheck pass                                                                                                                                                                                                        |
| fault-matrix1                       | Eight cases passed; five asserted None for an unhealthy stopped member's known actual identity. The spec allows stopped/unavailable facts; corrected assertions to health=false plus exit/claim settlement. All 13 startup/recovery matrix cases pass; one additional budget case covers five invalid/reserve counterexamples                                                    |
| boundary-sample1 inventory          | One repeated original file/title entry caused 818 rows versus 817 unique keys. JSON now groups duplicate occurrences explicitly; Markdown follows the same inventory                                                                                                                                                                                                             |
| test1                               | 2,102 passed, 45 skipped, two failures: allowed /proc benchmark plus public declaration traversal. The custom executable export accidentally included a source condition in publishConfig; use a published JavaScript entry as for the other inert executables. Public signature traversal then returned no missing types                                                        |
| Final checks                        | Recorded below after sequential completion; no packed script was executed                                                                                                                                                                                                                                                                                                        |

The sample guards are bounded test deadlines, never timing sleeps used to infer
an exit or ordering. Public phase events, held-call barriers, queued waiter
facts, owned completion and native exit provide the evidence. Runner teardown
can log its full disconnected-control Cause after successful shutdown; this is
retained diagnostic evidence, not an assertion of missing native evidence for
the settled Change.

### Step 7 final verification

| Check                    | Result                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen lockfile, offline | Passed; sample importer uses existing Effect 4.1.2 resolutions                                                                                                                                              |
| Final typecheck          | Passed (`phase2-step7-typecheck-final3.log`)                                                                                                                                                                |
| Final build              | Passed (`phase2-step7-build-final3.log`); all 72 public entries and 2,299 HTML pages validated                                                                                                              |
| Final root tests         | 288 passing files / 2,118 passing cases; 45 skipped; one failing benchmark file/case, solely the permitted macOS /proc exception (`phase2-step7-test-final3.log`)                                           |
| Added acceptance         | 26 cases: 14 fault-matrix (including five invalid/reserve inputs in one case), two real-access probes, two clock-boundary cases, five boundary/deletion/inventory checks and three public sample placements |
| Independent docs tests   | See final docs log; 25 Node/reference and 39 Vitest examples in 19 files                                                                                                                                    |
| No-cache formatting      | Verified before commit; no formatting diff                                                                                                                                                                  |
| Packed runtime execution | Not run: explicitly reserved for the owner; runnable fixture committed                                                                                                                                      |

The preceding final1/final2 root repetitions each passed 2,117 cases with the
same permitted benchmark failure. The last run adds the budget acceptance case.
The last audit replaces sample partial Option extraction with effectful absence
handling, explicitly asserts current target health/selection, removes temporary
access-count console output, and uses assertions in the owner-run packed
harness. No additional production behavior was introduced after the final
checks.

No implementation step is left pending. The outstanding verification is the
owner's packed runtime proof and the single independent review requested by the
spec. Explicit Phase 3–5 and upstream non-guarantees above remain outside this
slice; none is represented by an executable compatibility stub.
