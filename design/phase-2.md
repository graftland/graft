# Phase 2: decision core and units

Status: implementation plan from the owner decision of 2026-11-08. Sources, in
order: [architecture.md](architecture.md) v1.0, especially sections 1, 3–6, 9,
11.2 and 13; [phase-1.md](phase-1.md) and its stopped implementation; the Phase
0 Change model; the encoded-channel prototype and
[upstream drafts](upstream/rpc-request-completion.md). Promise: the production
decision core owns every Change fact; plugin execution is outside the kernel;
fixed-member unary upgrades have observable termination, recovery and residual
ownership (C1–C7, the execution part of C8).

## Scope and decisions

Phase 1 stops at `8a9d2a2c596f823226d8b39e36a85de5367edd4b`. Its guarantees were
implemented around in-process driver effects and the old imperative engine.
Phase 2 replaces that mechanism, then delivers the original unit and gateway
scope. Packages are unreleased: no compatibility layer, legacy engine switch or
transitional driver adapter remains.

| Area               | Decision                                                                                                      | Boundary                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Decision core      | Pure `(state, event) -> (state, commands)`, promoted from the Phase 0 model                                   | Production and exhaustive exploration call the same reducer; the model is not a second oracle                            |
| Effect interpreter | Executes fixed commands and reports evidence as events                                                        | No strategy, recovery, outcome or settlement decisions outside the reducer                                               |
| Kernel             | Coordinates Worker, child-process and runner units                                                            | No plugin imports, contract imports, plugin-defined schema transforms, user resolvers or driver callbacks                |
| In-process mode    | `Graft.plugin`, composition, dependency-aware lifecycle and cooperative member restart                        | No Change handles, outcomes, isolation or termination guarantee; code changes require process restart (architecture 1.3) |
| First slice        | Fixed instances, one member per unit, unary contract injection; Worker and child process, runner Restart-only | Group closure and Loader placement are phase 3; supervision and developer sources are phase 4                            |
| Old paths          | Delete replaced execution paths with their tests; transfer useful behavior into new acceptance tests          | Do not migrate the release journal, `replace`, HMR, `Update` or `ManagedFork` onto the new kernel                        |

The kernel entry point and the embedded runtime have separate service layers. A
unit runs the embedded runtime. A kernel client inside a unit can submit a
Change through the control protocol; it cannot pass a closure or a Context to
the kernel. Merely embedding `Graft.plugin` does not install a Change service.
The phase 2 gateway bootstrap uses a fixed deployment description; it does not
activate Loader or release plugins in the kernel. General control-plane plugin
placement remains phase 3.

Architecture section 1.3 scopes the blanket Change wording in sections 5 and
5.1: embedded cooperative restart is not a kernel Change. Section 5.6 also
limits “deadline → terminate → exit evidence”: missing evidence remains Stuck,
not a promise of bounded native termination. These are scope qualifications, not
changes to the architecture's guarantees.

## Decision core

The reference shape is Erlang `gen_statem`: explicit state, ordered events and
commands describing external work. This is a design shape, not an OTP API or a
new public abstraction. The following are internal type sketches, not exported
signatures. Use Effect immutable records, `HashMap`, `HashSet` and `Option`. No
state field contains an Effect, Fiber, Scope, Deferred, callback or unit handle.

### State

| Record            | Data                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel            | Admission open/closing; monotonic observation time; authority identity; next ids; instance, unit, Change and preparation indexes; keyed requests; bounded settled history                                                                                       |
| Object cell       | Instance, realm/service slot, dependency edge or fixed unit membership key; version including absence tombstones; reader set and optional writer Change                                                                                                         |
| Instance          | Stable identity, desired target, current generation/route, health evidence, term high-water mark; recreation never reuses versions or terms                                                                                                                     |
| Change            | Normalized request and source; member selection reasons and starting facts; strategy; read/write premises and owned versions; previous desired target; phase; old-changed boundary; cancellation/invalidation causes; absolute deadlines and trial requirements |
| Generation        | Instance, unit incarnation, term, desired and resolved input identities; publication owners; resolution and generation leases; readiness/probe/trial evidence; exit evidence                                                                                    |
| Unit              | Placement, spawn command identity, incarnation and member generations; `PendingSpawn / Running / Terminating / Exited / NotStarted`; all execution obligations remain until evidence                                                                            |
| Route view        | Local patch, view version, required participants and matching installation acknowledgements; installed and active are distinct                                                                                                                                  |
| Capacity          | Used units, reserved slots and owner of each claim; includes inspection units, pending spawns, serving/draining units and unconfirmed exits; recovery reservation cannot be stolen                                                                              |
| Call              | Provider generation, consumer generation, connection session and request id; admitted/dispatch/result/cancel facts; owned-scope completion and causes; gate waiters with count and time bounds                                                                  |
| Obligation        | Stable id, owner (preparation, Change or serving instance), unit/generation/call, required evidence, completion disposition and full cause; ownership transfers recorded once                                                                                   |
| Command and timer | Stable command id, correlation token, pending/reported disposition; absolute timer deadline and generation; enough data to reject stale or duplicate reports                                                                                                    |
| Conclusion        | Immutable outcome, phase, member snapshot and evidence at publication; live settlement facts remain separate                                                                                                                                                    |

`Status`, actual members, lease holders, unconfirmed units, remaining budget and
settlement classification are projections of this state. There is no writable
status mirror. `get`, notifications and outcome creation use the same
projection; late facts change the current projection, never a published
conclusion. Current instance facts follow its present incarnation; old
obligations retain their original owner. The serving generation transferred at
conclusion is recorded once, not rediscovered from a later route.

### Events and commands

Every report carries its command id and the relevant authority, Change or
preparation id, unit incarnation, generation, term and view version. Call
reports also carry the connection session and request id. Data from units is
validated against the fixed control envelope before it enters the reducer.

| Event family     | Payload sketch                                                                                    | Decision enabled                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Submission       | Request, request key, observed time; cached declaration identity if present                       | Duplicate lookup, preflight work, rejection or atomic admission                              |
| Description      | Unit identity, artifact/config provenance, declarations, validation result or cause               | Strategy, binding compatibility and complete fixed footprint                                 |
| Lifecycle report | Spawned, start/serve/ready/probe result, execution failure, stop acknowledgement                  | Advance only the matching attempt; failure enters settlement/recovery                        |
| View report      | Participant, installed view and derived binding acknowledgement                                   | Commit only after every necessary local participant confirms                                 |
| Invalidation     | Changed object/policy version, planned-withdrawal owner or external cause                         | Close affected admission and invalidate its owner; never discard as Busy                     |
| Call report      | Admission request, dispatch confirmation, business result, cancel request, owned-scope completion | Pin generation and retain execution credit independently of client waiting                   |
| Exit evidence    | Observed native exit or confirmed prevention of spawn, observer identity and cause                | Settle only this unit's execution, capacity and generation leases                            |
| Time and control | Timer fired, explicit cancel, shutdown, waiter cancellation/expiry                                | Termination escalation, recovery or terminal decision; cancellation of `await` is not cancel |
| Command failure  | Original command identity and full cause; creation certainty                                      | Preserve failed work and unresolved ownership; never infer NotStarted from a timeout         |

| Command family                                   | Payload sketch                                                                 | Interpreter obligation                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn / Describe                                 | Unit id, placement, immutable artifact, encoded config, narrowly scoped grants | Establish exit observation before dispatching work; report creation or confirmed noncreation                                          |
| Start / Serve / Ready / Probe / Stop / Terminate | Matching unit and attempt, bounded protocol operation                          | Send protocol or native termination; acknowledgement is not exit                                                                      |
| Install / Activate / Discard view                | Patch, required participant, view token                                        | Report installation; activation follows a committed core decision; never restore an older view autonomously                           |
| Resolve / authorize                              | Desired references, target identity, current policy premise                    | Fixed protocol to a resolver unit or fixed runtime facility; no user callback in kernel; result is evidence subject to version checks |
| Admit / reject / cancel call                     | Session-qualified call token, selected endpoint or rejection                   | Transfer only control metadata; business payload goes directly between units                                                          |
| Arm / cancel timer                               | Timer id and absolute monotonic deadline                                       | Report expiry without deciding whether work completed                                                                                 |
| Publish / reply / retain evidence                | Core revision and projected status, handle or rejection, original cause        | Notify without blocking coordination; retain evidence if observers are slow or disconnected                                           |

Admission, route commit, ownership transfer and reservation release are reducer
transitions, not effects which the interpreter may independently approve. A
short STM transaction consumes an event, checks versions, updates core state and
enqueues its commands atomically. Remote waits never enter that transaction. One
control authority serializes decisions, not unit execution; each transition
visits the affected indexes only. Commands for unrelated Changes run
concurrently.

### Interpreter contract

| Rule                 | Required behavior                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent before action | Record the command and its obligations before spawning or sending. Allocation acquires a capacity claim and consumes a fresh term before any execution can exist                                                     |
| One decision owner   | The interpreter owns handles and fibers indexed by core ids; it cannot edit reservations, route choices, status, counters or outcomes                                                                                |
| One execution owner  | Every command fiber belongs to a runtime Scope, FiberSet or FiberMap. Caller interruption cannot orphan an admitted Change or an exit observer                                                                       |
| Repetition           | Process each command id at most once locally; transports deduplicate lifecycle requests. Duplicate reports are idempotent. Retry needs an explicit core command, never blind re-execution of spawn or business calls |
| Stale reports        | Stale readiness/install reports cannot advance a newer attempt. Valid late exit and failure evidence is still attached to its original obligation, even after Stuck                                                  |
| Failure              | Preserve full command, execution and cleanup causes. A crashed command executor emits a failure event; it cannot silently disappear or fabricate completion                                                          |
| Time                 | Read the clock at the boundary and pass time as data. Each wait uses the minimum of its operation budget and remaining total; cleanup/recovery/trial reserves are charged once                                       |
| Shutdown             | Close admission, cancel owned Changes, stop/terminate units and observe evidence outside them. Never join plugin code in the kernel; missing evidence produces retained Stuck facts                                  |

Timers and command dispatch are part of exploration: the harness supplies
possible external reports, not internal `Commit`, `Finish` or `Recover`
shortcuts. The Phase 0 model's synthetic `NotStarted` on deadline is replaced
with proof that spawn was prevented or completed without creating execution.
Extend its simplified cleanup and capacity data; do not promote its omissions as
production guarantees.

## Units, preparation and termination

| Work                                                                                       | Runs in                                              | Kernel receives                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Candidate metadata preparation and declaration checks                                      | Describe-only unit under the selected trust boundary | Encoded declarations tied to immutable artifact, config identity and protocol version                                           |
| Contract import, config decode/default/refinement, schema and operation checks             | Unit                                                 | Declared requires/provides, operation identities and provenance, overlap capability, probes and fixed member/resource footprint |
| Plugin apply, handlers, custom resolvers/interceptors and finalizers                       | Unit                                                 | Protocol results, owned-scope completion, diagnostic causes and observed exit                                                   |
| Policy enforcement, version comparison, exact identity-set comparison, resource accounting | Fixed kernel protocol                                | Core events; no execution of declarations or plugin-defined predicates                                                          |
| Worker/process spawn and native kill; runner control                                       | Fixed placement interpreter                          | Observed exit for the exact incarnation, or explicit uncertainty                                                                |

Preflight first normalizes data and looks up request keys. Preparation has a
runtime-owned record before spawning its inspection unit, including capacity,
deadline and cleanup evidence; rejection has no Change id but cannot hide a
leftover unit. Duplicate submissions share the pending preparation and later
handle; a different normalized request under the same key is KeyConflict. The
submission's absolute total deadline includes inspection and its retirement;
admission inherits the remaining budget and revalidates recovery/trial reserves.
It never starts a fresh total clock. Cancelling a pre-admission waiter does not
remove its execution owner. After Describe, stop the inspection unit and require
exit evidence before admission. A lost inspection exit rejects admission and
retains a queryable preparation/unit record and capacity claim. It does not
reserve the old instance or falsely create an admitted Stuck Change. Its
rejection carries the preparation correlation id for public residual queries. A
pending or unresolved key record prevents duplicate inspection work; a fully
settled rejection is not an admitted-key record and may be retried with fresh
planning.

Describe cannot activate the plugin, publish services or obtain its exclusive
service resources. The unit imports and validates under restricted preparation
grants. The subsequent execution unit must return the same declarations before
Serve; a mismatch settles it and fails the Change. The plan admits the complete
fixed footprint before candidate execution. Discovery outside that footprint
settles staged work and requires a fresh submission; it never expands locks. The
kernel records the next instance term before granting it to an execution unit;
`Plugin.term` exposes that grant inside the unit. Failed spawns consume their
term. Inspection uses a distinct preparation identity and cannot acquire serving
authority. Fencing across kernel restarts remains phase 5.

Verified declarations may be reused only for the same immutable artifact,
encoded config and validation environment; authorization and reference
resolution are always checked afresh. Inspection capacity is explicit: at full
`maxUnits`, an uncached description can be rejected with Capacity before old
execution stops. Restart can reuse the old unit's slot after exit when the
verified description is already available. No uncounted inspection Worker and no
import in the kernel are allowed to preserve a full-capacity test.

All execution deadlines follow the same path: stop forward progress, request
termination of the responsible unit, then wait within the reserved termination
budget for exit evidence. A successful trial timer is an observation milestone,
not a fault; an expired queued call that never dispatched has no unit to kill.

| Evidence                                   | Settles                                                                                    | Does not establish                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Graft-owned request scope completed        | That call's execution credit and cleanup report                                            | RpcServer internal scope completion, descendant calls or unit exit          |
| Observed Worker termination / process exit | All execution obligations and runtime leases in that unit, exactly once; its used capacity | Successful finalizers, rollback of external effects or exit of another unit |
| Confirmed NotStarted                       | A spawn intent which cannot later create execution; its capacity                           | Timeout or interruption of a spawn waiter                                   |
| Runner exit report                         | Exact runner incarnation observed dead by its execution owner                              | Disconnect, lease expiry, fencing or termination acknowledgement alone      |

Termination can fail or outlast its wait budget. Then record Stuck, retain the
conflicting ownership, used capacity and exit observer, and let unrelated
Changes proceed. Native termination has no promised wall-clock upper bound. Late
exit releases only the original claims and updates current facts; the Stuck
outcome remains immutable. Shutdown reports stopped, unavailable or unknown
facts, never Aborted after the old generation has stopped. Runtime process death
is outside the in-memory observation guarantee. A completed shutdown request
leaves a read-only observation/evidence owner for unresolved units until the
kernel process ends; it does not hide an unbounded exit wait in a Scope
finalizer. Final process disposal can abandon observation, not manufacture exit.

### Settlement and recovery

One pure classifier reads all required obligations, including the previous,
forward and recovery units and any preparation still owned by the operation. It
distinguishes unresolved execution, ended execution with failed/unknown cleanup,
and satisfied requirements. Unknown finalization after forced exit is a recorded
fact, not a reason to wait forever for an in-kernel finalizer.

| Condition                                                                                                                                                | Outcome / action                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required exit evidence missing at the evidence deadline                                                                                                  | Stuck; retain unresolved ownership, regardless of a separate known failure                                                                              |
| Target Serving, full trial completed, all required retirement evidence and settlement requirements met                                                   | Accepted                                                                                                                                                |
| Failure/cancel before any old stop or route change; old generation still healthy and authorized; candidate settled                                       | Aborted                                                                                                                                                 |
| Old generation may have changed; candidate settled; previous desired target re-resolved, reauthorized, started exclusively and passes full Serving/trial | Recovered                                                                                                                                               |
| Recovery denied, conflicts with an accepted version, fails or exhausts its budget; required exits confirmed                                              | RecoveryFailed; actual member unavailable/stopped                                                                                                       |
| Known cleanup failure or unattributed failed cleanup Exit                                                                                                | Preserve cause and fail the affected success requirement; recover if possible. Do not equate an unmarked interrupt or repeated Scope.close with success |

For retirement, forced exit can discharge the runtime execution obligation while
cleanup stays unknown. Accepted requires the specified retirement evidence, not
a claim that finalizers succeeded; any known required cleanup failure enters the
failure/recovery path. Missing attribution is not repaired by heuristics. The
[Scope attribution draft](upstream/scope-close-interrupt-attribution.md) remains
applicable inside units and embedded mode.

Record the old-changed boundary before issuing Stop or activating a new route.
Recovery uses previous desired input, fresh credentials, fresh binding and the
current authorization premise; it does not reuse a resolved snapshot or the
forward Overlap requirement. It commits only owned versions. Shutdown has no
service-restoration target and does not start a recovery generation.

## Encoded channel and binding

Use Effect RPC's encoded protocol and serialization in both endpoint units. The
kernel brokers and authorizes direct channels for actual dependency edges; it
neither imports business schemas nor relays business payloads. Worker ports,
child-process channels and runner channels carry the same logical encoding.
Local Context services remain inside one unit.

| Rule                    | Acceptance evidence                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime compatibility   | Resolve realm and service binding first; one provider must contain the consumer's exact operation identity subset. Reject incompatible versions, unexplained same-identity provenance or mismatched wire tags before installing/activating the binding; never union partial providers |
| Install before activate | Change/generation/view acknowledgements from necessary participants precede commit. Candidate lifecycle traffic bypasses paused business admission and cannot wait for its own publication                                                                                            |
| Context boundary        | Handler sees provider services, Scope and authority. Only explicitly allowed capability, origin and trace metadata crosses; caller services, interceptors and arbitrary privileges do not                                                                                             |
| Call binding            | Register execution credit before dispatch, select generation and authorization atomically, then pin the call. New calls follow the committed route; existing calls never migrate                                                                                                      |
| Single-hop completion   | Graft supplies the handler's request Scope, owns its execution and close, and reports completion after that Scope ends with the original Exit. Business result and completion remain separate records                                                                                 |
| Cancellation            | Client cancellation requests provider interruption but does not release credit. Completion or observed provider exit releases it. Lost completion leaves an obligation until reconciled or terminated                                                                                 |
| Delivery                | Completion reports are retained and acknowledged, deduplicated by provider generation, session and request id. Reused request ids in another session cannot settle old calls; loss/disconnect never invents success                                                                   |
| Unknown result          | Before dispatch, rejection is NotAdmitted. Once dispatch is registered, loss without a terminal result is Unknown; no automatic business retry                                                                                                                                        |
| Bounds                  | Bound call concurrency, control queues, message size and Restart waiter count/time; reserve control capacity for cancellation, exit and completion. Overflow rejects new work, never drops an existing obligation                                                                     |

The Graft-owned Scope is the deliberately narrow interim protocol authorized by
architecture section 13. It does not change Effect RPC messages or claim a hook
for RpcServer's internal request Scope. The prototype's early-result and early
RPC Exit counterexamples stay as tests of that limit. General unary
request-scope drain still needs the upstream hook. Structured codec failures
remain incomplete; preserve their Cause without parsing messages to invent a
ContractFailure phase. Streams, deferred replies, discard and nested cross-unit
completion are outside this slice and rejected where the Change guarantee would
depend on them.

## Gateway slice and public observation

The fixed deployment contains a gateway unit holding an upstream session, an
integration provider unit and an unrelated provider unit. The gateway injects
the integration's unary contract through the public unit API. The test replaces
the integration by submitting a public Change; it does not read coordinator
refs, simulate a release journal or implement protocol steps in a test adapter.

| Schedule                                      | Required public observations                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlap upgrade                               | Same gateway generation and upstream session; an old admitted call completes on old code; a new call uses new code; Accepted includes old-unit exit and settled execution credits |
| Restart upgrade                               | Admission pauses only for the changed binding; bounded waiters choose a generation on dispatch; old exit precedes candidate Start; gateway session remains                        |
| Failed startup or trial                       | Candidate settles; Aborted only while old remains usable, otherwise fresh recovery passes trial and reports Recovered; denied recovery reports RecoveryFailed                     |
| Stalled import, decoder, handler or finalizer | Kernel remains responsive and reports termination/cleanup facts; absent exit after admission is Stuck, before admission a rejection with residual unit facts                      |
| A stuck or in trial, B changes                | B completes through the same public API; only A's conflict set stays reserved, subject to shared capacity                                                                         |
| Observer disconnect / cancelled await         | Query by Change id reconciles sequence gaps and returns current members, remaining budget, leases, unconfirmed units and causes; repeated await returns the same conclusion       |
| Placement change in the test fixture          | Worker and child-process fixtures use the same consumer code and encoding; runner fixture uses Restart and reports disconnect uncertainty                                         |

The public control protocol exposes submission/rejection, handle await/cancel,
`get` and sequenced status notifications, plus unit/preparation residual facts
needed for a rejection before admission. It is schema-independent and usable
from outside the kernel process. Slow subscribers do not hold coordination;
settled history is bounded, while keyed requests and unresolved records retain
Phase 1's runtime-lifetime retention. Persistent observation is phase 5.

## Deletion and test disposition

Paths below are relative to `packages/`. A listed replacement removes the old
implementation in the same step; retaining its filename does not authorize a
second engine. Unrelated embedded lifecycle code stays embedded.

| Files / APIs                                                                                                                                                                      | Phase 2 disposition                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/src/internal/changeAdmission.ts`, `changeCoordinator.ts`, `changeExecution.ts`, `changePreparation.ts`, `changeSettlement.ts`, `changeTable.ts`, `terminalSettlement.ts`    | Delete the imperative Change implementation and mutable status mirrors; replace with production reducer, projections and interpreter                                                                                                                               |
| `core/src/internal/transition.ts`                                                                                                                                                 | Delete engine, managed registration/attempt/HostLease machinery, host allocation executors and late host-cleanup watchers; move only still-needed legacy bypass guards out until their phase 4 callers are deleted                                                 |
| `core/src/internal/ownedExecution.ts`, `asyncClose.ts`                                                                                                                            | Delete Change host execution/cleanup machinery and its dedicated tests; do not move uninterruptible plugin waits into the new interpreter                                                                                                                          |
| `core/src/internal/admission.ts`, `capacity.ts`, `generations.ts`, `changeRequest.ts`, `transitionBudgets.ts`                                                                     | Replace Change counters, queues, claims, generation ownership and request/budget decisions with core data/transitions. Keep embedded generation lease behavior in the embedded runtime; never maintain a second kernel ledger                                      |
| `core/src/Transition.ts`: `Driver`, `Prepared`, `Registration`, `Unit`, `Allocation`, `Invoke`, `Facade`, `facade`, `registerDriver`                                              | Delete closure-based registration and Context-returning readiness. Fixed placement protocol and unit-local contract injection replace them; no adapter accepts old drivers                                                                                         |
| `core/src/Change.ts`, `Graft.ts`, `internal/runtime.ts`, `runtimeContext.ts`, `activation.ts`, `dependencies.ts`, `forkState.ts`                                                  | Keep Change's identity/query/outcome intent but bind it to the kernel service; remove managed-Change execution hooks from embedded activation and teardown. Kernel generation ownership is separate from unit-local member lifecycle                               |
| `plugin-remote/src/internal/transition.ts`, `execution.ts`; module/managed branches in `src/index.ts`, `host/index.ts`, `Config.ts`; host contract loading in `internal/entry.ts` | Delete the two host activation paths and `ManagedOptions`/resolver callback surface. Replace with data-only placement and unit bootstrap; metadata, schema-dependent `contract.ts`/`unit.ts`/`host.ts` work runs only inside units                                 |
| Remote transport, runner process observation and termination primitives                                                                                                           | Reuse only fixed protocol/platform capabilities after conformance tests; remove host business clients and schema decoding from their kernel-facing dependency graph                                                                                                |
| Phase 1 adapters in `plugin-release/src/internal/service.ts` and `candidates.ts`, plus callers requiring deleted Remote managed APIs                                              | Remove obsolete host integration and its execution assertions instead of bridging it. Keep release data/storage behavior unported; unit control integration belongs to phase 3 and batch/journal replacement to phase 5. The gateway slice submits Change directly |
| `core/test/change-model/model.ts`, `adapter.ts`, `change-driver.ts`                                                                                                               | Promote/refine the reducer into production, then delete the duplicate model and in-process driver adapter. Retain scenario generators, exploration and independent assertions importing the production core                                                        |

Do not remove `Release.ts` or attribution reproductions as if termination solved
Effect's provenance gap. Do not migrate unrelated `replacement.ts`, aliases,
HMR, `Update` or the release journal to the kernel. Their later replacing phases
delete their implementations and tests. Remove any dead imports, exports and
sample branches caused by the phase 2 deletions; a package that relied on a
deleted path must not retain an executable compatibility stub.

| Existing tests                                                                                                                                                                                                 | Retarget or delete                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/test/change-model.test.ts`, `change-model-settlement.test.ts`, `change-model/{scenarios,explore,assertions}.ts`                                                                                          | Run every supported schedule against production transitions and commands; mark closure/group cases as rejected until phase 3. Remove the independent implementation in `model.ts`                                    |
| `core/test/change-adapter.test.ts` and `change-model/adapter.ts`                                                                                                                                               | Replace with interpreter conformance and public unit-protocol traces; adapter only schedules external reports and cannot edit routes, leases or reservations                                                         |
| `core/test/change.test.ts`, `change-request.test.ts`, `change-restart.test.ts`, `change-recovery-overlap.test.ts`, `change-authorization.test.ts`, `change-total-budget.test.ts`, `transition-budgets.test.ts` | Keep behavior as core admission, recovery, capacity, dedupe and absolute-time acceptance tests; delete driver fixture plumbing                                                                                       |
| `core/test/change-{allocation,preparation,execution-lifetime,late-obligations,shutdown,lifetime}.test.ts`, `registration-lifetime.test.ts`                                                                     | Replace host Deferred/fiber waiting assertions with stalled unit import/Describe/spawn/stop/exit tests. Delete assertions requiring kernel-held plugin resources or waiting for their cleanup after unit exit        |
| `core/test/change-{terminal,settlement,leases}.test.ts`, `terminal-settlement.test.ts`, `call-admission.test.ts`                                                                                               | Move classification, immutable conclusion, late evidence, owner fencing and call-credit races to core schedules plus unit evidence tests                                                                             |
| `core/test/async-close.test.ts`, old driver portions of `transition.test.ts`                                                                                                                                   | Delete with the replaced mechanism; retain only independently useful embedded behavior as embedded tests                                                                                                             |
| `core/test/generation-ownership.test.ts`, cleanup/activation and Scope attribution tests                                                                                                                       | Keep embedded ownership/provenance tests; add kernel unit-exit conservation checks. Do not treat in-process pass results as kernel evidence                                                                          |
| `plugin-remote/test/transition-driver.test.ts`, `transition.test.ts`, `managed-config.test.ts`, `change-recovery-policy.test.ts`                                                                               | Delete host-driver assumptions; retain current-policy recovery, term, placement and failure behavior through unit protocol tests                                                                                     |
| `plugin-remote/test/encoded-channel.prototype.test.ts`, `fixtures/encoded-channel/`                                                                                                                            | Promote encoding, pinning, Context and completion counterexamples into production-channel tests; keep minimal Effect-only evidence for unresolved upstream gaps, remove prototype kernel routing as a product oracle |
| Remote module/entry tests, release execution tests and old gateway packed proof                                                                                                                                | Delete cases for removed APIs in the replacing step; rewrite slice behavior through public unit control. Record deferred release batch/compensation cases for phase 5 rather than porting old journal orchestration  |

## Implementation order

Each step begins with failing acceptance tests for its listed behavior, then
implements the mechanism and removes what it replaces. This table orders work;
it does not authorize parallel changes to coupled core ownership files.

| Step | Reviewable diff                                                                                                              | Tests written first                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Production pure core and projections; extend Phase 0 state/events/commands                                                   | Exhaustive independent/conflicting Changes, reverse commit order, ABA, late acknowledgement/exit, shutdown, immutable conclusions, full cause and capacity conservation; remove synthetic NotStarted                                                                  |
| 2    | Effect interpreter and kernel/embedded service boundary; delete old Change engine and driver APIs                            | Command intent before dispatch, duplicate/reordered reports, original command failure, cancelled caller, stale timer, closing owner, no alternate status writer; embedded API cannot claim Change guarantees                                                          |
| 3    | Fixed unit lifecycle, Describe preparation, current-policy recovery and exit observation; remove host preparation/allocation | Real blocked import/decoder/finalizer outside kernel, spawn uncertainty, pre-admission leftover visibility, duplicate preparation, inspection charged to total, inspection capacity, Restart at capacity with verified description, termination and runner disconnect |
| 4    | Encoded direct channel and unit-local contract injection, staged route installation                                          | Codec transforms and typed errors survive transport; provider Context; one-binding subset/provenance/tag checks; missing/stale install ack; candidate startup cannot deadlock on paused admission                                                                     |
| 5    | Graft-owned single-hop completion/cancel protocol and bounded calls                                                          | Result before cleanup, cancellation before/after dispatch, lost/duplicate completion, reused ids across sessions, disconnect, unit exit settles only its calls, finalizer defect/unknown attribution, control traffic under saturation                                |
| 6    | Public observation and fixed gateway slice; remove old Remote host path and dependent sample/release integrations            | Every gateway schedule above through public queries/events, native exit evidence, unrelated progress, recovery reauthorization, consistent get/event/outcome projections                                                                                              |
| 7    | Three-language guides and samples, public exports, proof manifest                                                            | Deleted API/import checks, no kernel dependency on plugin/contract modules, packed gateway and public API checks; every old Phase 1 case mapped to retained/replaced/deleted/deferred evidence                                                                        |

## Invariants and counterexamples

| Id  | Invariant                                                                                    | Counterexample the tests must reject                                                               |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| I1  | Only core transitions choose state, status, outcomes and settlement                          | Interpreter marks a successful command Accepted, or status retains an old registration's route     |
| I2  | Each claim, execution and obligation has one owner; release is idempotent                    | Exit decrements capacity twice; an old watcher clears a new instance's reservation                 |
| I3  | Admission reserves the complete local conflict set; commits check versions and apply patches | B disappears when A commits a snapshot; absence ABA goes unnoticed; A Stuck blocks unrelated B     |
| I4  | No plugin or contract code executes in kernel                                                | A contract refinement blocks the kernel event loop; metadata preparation runs as a kernel Effect   |
| I5  | No timeout, disconnect, lease expiry or cancel acknowledgement substitutes for exit          | Timed-out spawn becomes NotStarted while it can still create execution                             |
| I6  | Every required unit exit settles its runtime leases; cleanup quality stays separate          | Dead generation holds a lease forever, or forced termination claims successful finalizers          |
| I7  | Old-changed boundary and current trust determine recovery                                    | Aborted after Stop began; forward Overlap blocks exclusive recovery; revoked credentials revive    |
| I8  | Required installation precedes activation; each admitted call stays pinned                   | Late view ack changes current route; queued call binds before actual admission                     |
| I9  | Result, cancellation, owned-scope completion and exit are distinct                           | Client stops waiting and provider credit disappears while its finalizer still runs                 |
| I10 | Terminal conclusion is immutable; current facts and residual objects remain truthful         | Late exit rewrites Stuck to Accepted or transferred serving work becomes an old Change obligation  |
| I11 | One absolute submission budget covers inspection, trial, cleanup and recovery                | Admission, recovery or termination resets the total budget; only one trial is reserved             |
| I12 | Unsupported topology is rejected before execution relies on its guarantee                    | Cross-unit local service, nested completion or runner Overlap silently uses an in-process fallback |

## Fault table

Each row is an acceptance cell: inject the fault at the named boundary and
assert outcome, actual members, residual ownership and evidence. In rows where
exit is withheld, the missing-exit cell overrides the otherwise expected result.
“Released” means only that operation's claims; a serving unit retains its normal
capacity and leases. All failure cells retain full causes and the interrupted
phase. No matching fault may be hidden behind an aggregate success count.

| Fault cell                                                                                                        | Expected result                                                                                                                          | Residual objects                                                                                   | Evidence                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Busy, stale premise, invalid budget, unsupported target/topology or capacity before admission                     | Rejection, no Change id; old service unchanged                                                                                           | No Change reservation; any preflight unit stays owned until exit                                   | Rejection reason, conflicts/versions and preparation record                         |
| Describe import/decode/check fails or stalls before admission                                                     | Reject after bounded termination attempt                                                                                                 | Inspection unit/capacity and exit observer if exit absent; no instance lock                        | Unit identity, original cause, termination request and exit or uncertainty          |
| Candidate fails before old changed, candidate exit confirmed                                                      | Aborted if old still usable                                                                                                              | Candidate claims released; old remains serving                                                     | Old health/authorization, candidate exit and failed phase                           |
| Candidate fails after old stop, recovery succeeds                                                                 | Recovered after fresh full trial                                                                                                         | Failed units released; recovery unit now instance-owned                                            | Old/candidate exits, new resolution/policy/term, recovery readiness and trial       |
| Overlap trial fails with Restart-only previous target                                                             | Recovered via exclusive recovery                                                                                                         | Same as above                                                                                      | Forward failure plus independent recovery requirement                               |
| Recovery authorization revoked, owned version lost or recovery fails                                              | RecoveryFailed once all required exits confirmed                                                                                         | Failed units released, desired state retained, actual unavailable; unrelated accepted state intact | Current policy/version conflict or recovery cause, exit evidence                    |
| Candidate Start/readiness/probe stalls before old changed                                                         | Terminate candidate; Aborted after exit if old healthy and authorized                                                                    | Candidate released; old serving                                                                    | Expired operation, candidate exit and old health/policy                             |
| Candidate Start/readiness/probe stalls after old stopped                                                          | Terminate candidate; Recovered if exclusive recovery passes full trial                                                                   | Failed units released; recovery unit serving                                                       | Old/candidate exits, fresh recovery evidence                                        |
| Old drain/stop stalls during Restart; exit then recovery succeeds                                                 | Terminate old; Recovered after full recovery trial, not Aborted                                                                          | Old claims released; recovery unit serving                                                         | Forced exit, interrupted calls, fresh recovery evidence                             |
| Old retirement stalls after Overlap target passes trial; forced exit confirmed, no known required cleanup failure | Accepted with forced-retirement and unknown-cleanup facts                                                                                | Old execution claims released; target serving                                                      | Target Serving/trial, native old exit, cleanup unknown                              |
| Recovery Start/readiness/probe/trial stalls                                                                       | Terminate recovery unit; RecoveryFailed after required exits                                                                             | No serving target; settled claims released                                                         | Recovery deadline/cause and all required exits                                      |
| Admitted Change: required spawn/termination cannot be confirmed                                                   | Stuck                                                                                                                                    | Exact unresolved units, leases, capacity, conflict reservations and observers retained             | Missing-exit identity and attempted commands; independent B can complete            |
| Late exit after Stuck; duplicate exit; same-name recreation                                                       | Original Stuck unchanged; current facts update once                                                                                      | Only old settled claims released; new incarnation untouched                                        | Original unit/owner token and monotonically sequenced status                        |
| Cleanup completes with defect or unattributed interruption                                                        | Aborted if old remains usable; otherwise Recovered after successful recovery, or RecoveryFailed after failed recovery and required exits | Execution claims released on exit; diagnostic/unknown attribution retained                         | Original cleanup Exit plus execution evidence                                       |
| Client receives unary result while owned cleanup blocks; cancel arrives                                           | Call remains outstanding; Change drain cannot finish from result/cancel alone                                                            | Session-qualified credit until completion or provider exit                                         | Independent result, cancel and completion records                                   |
| Lost completion or runner disconnect, lease expiry without exit                                                   | Unknown call result if no result received; Change Stuck at evidence deadline                                                             | Call and unit claims retained; no retry/reuse                                                      | Connection/session identity, missing completion/exit                                |
| Wrong view/generation ack or partial installation                                                                 | No activation; after candidate exit, Aborted if old usable, Recovered if recovery succeeds, otherwise RecoveryFailed                     | Only staged claims until exit; no stale route authority                                            | Rejected token, required participant set and installed/active views                 |
| Queue overflow/expiry/cancel before dispatch                                                                      | Declared NotAdmitted rejection                                                                                                           | Waiter removed once; no execution credit                                                           | Gate limit/deadline and absence of dispatch                                         |
| Runtime shutdown races admitted work                                                                              | Close admission; cancel and terminate; RecoveryFailed for stopped service, Stuck for missing exit                                        | Only unresolved claims retained until late evidence                                                | Closed admission, immutable interrupted-phase outcome, actual stopped/unknown facts |

## Proof and enough bar

1. Exploration imports the production reducer. Enumerate all causal shuffles for
   each finite scenario and bounded repeated-event exploration with explicit
   depths, state/transition counts and failing traces. Cover forward, recovery,
   settlement, timers and command reports; finite exploration is not a proof of
   every possible topology or an unbounded execution.
2. Interpreter conformance replays representative traces against real commands
   and compares public observations to core projections. Real Worker and process
   fault tests establish termination; a fake exit event alone is not evidence. A
   runner test distinguishes native exit from disconnect/lease expiry.
3. Every invariant, counterexample and fault cell above has an identified test,
   expected outcome and residual-object assertion. Tests use Deferred/barriers
   and TestClock for ordering; real process deadlines are bounded test guards,
   not timing sleeps used as evidence.
4. The gateway proves the slice through public control and observation,
   including actual version/health, selection reason, leases, unconfirmed units
   and causes. An import audit and a blocking-contract fixture prove the kernel
   boundary. Object-access instrumentation proves unrelated instances are not
   scanned; it does not claim constant latency under saturation.
5. A deletion manifest maps Phase 1 tests and review regressions to new evidence
   or explicit deferral. No old driver adapter, shadow model, host metadata
   executor or mutable status mirror remains. Three-language product docs state
   the same scope and non-guarantees; every public signature type is exported.
6. Run `treefmt`, `pnpm typecheck`, `pnpm test`, `pnpm build` and packed slice
   proofs through `devenv shell --`. Record failures and platform exceptions
   separately; an exception is not a pass. Each implementation phase runs full
   checks. There are no per-phase independent review loops: one independent
   review after all implementation phases accepts against each phase spec's
   invariants, counterexamples, fault cells, evidence and non-guarantees.

Phase 2 is enough when these six proof items hold for the fixed unary slice and
all listed residuals are observable. It does not wait for the following work.

| Explicit non-guarantee                                                                                                   | Destination / limit                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| In-process Change outcomes, isolation, hard cleanup deadlines or code reclamation                                        | Deliberately absent; embedded mode offers cooperative lifecycle only                                                            |
| Group inference/closure, online member add/remove, general Loader placement and all control-plane plugins in units       | Phase 3; phase 2 rejects footprints it cannot cover                                                                             |
| Supervisor retries/intensity, Committed completion, unified developer changes; removal of replace/HMR/Update/ManagedFork | Phase 4; no migration of those old paths in phase 2                                                                             |
| Release batches, compensation journal, persistent dedupe/terms/diagnostics, kernel crash recovery                        | Phase 5; only in-memory runtime-lifetime records here                                                                           |
| General RpcServer request-scope drain, deferred/discard, streams, nested cross-unit completion                           | Upstream hooks or later explicitly scoped work; only Graft-owned single-hop scope is covered                                    |
| Structured codec failure phases and general interruption provenance                                                      | Upstream requirements remain open; full original causes and unknown facts are preserved                                         |
| Successful finalizers or external effect rollback after forced exit; bounded native kill latency                         | Never inferred from termination                                                                                                 |
| Worker as security sandbox, universal memory/byte/external-resource capacity bound                                       | Worker is a fault boundary; untrusted work requires sandboxed child placement. Protocol limits do not imply total memory bounds |
| Gateway session survival when its own unit or kernel process dies                                                        | Only an unchanged gateway unit's session is preserved; handoff and session continuation are conditional extensions              |
