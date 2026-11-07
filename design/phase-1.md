# Phase 1: the Change kernel

Status: approved scope for implementation, revised after an independent review.
Sources: `architecture.md` sections 3, 5, 6, 9.1 and 10, the execution plan, and
the phase 0 prototypes. Promise: unrelated Changes never conflict through
reservations or `Stuck` state (shared capacity limits may still reject
admission), and every admitted Change is identifiable and observable before it
ends (C2, C3, the kernel part of C4).

## Scope and decisions

A **Change** is the only user-facing runtime change object. Phase 1 gives it an
identity, local admission, patch commits, a Restart strategy and per-generation
ownership, for instances registered through `Transition.registerDriver`.
Deployment groups and member closure (phase 3), the supervisor (phase 4) and
batches with compensation (phase 5) come later. The data model holds a member
list so later phases extend it. Phase 1 accepts one target within its supported
fixed-membership model; Changes that would need unsupported member closure are
rejected before execution. Consumers using an unchanged compatible facade are
not treated as consumers of an old generation's captured local resources.

Phase 1 proves coordination and retirement only for execution forms whose
completion evidence is available. A returned RPC result or a cancelled client
wait is not remote execution completion, including for ordinary unary calls.
General remote request-scope drain stays unsupported until phase 2 provides the
Graft-owned completion record (architecture section 13). Packed gateway checks
do not certify that guarantee.

### Public surface

Core is unreleased; no aliases are kept.

- New module `Change`, which holds every application-facing type:
  - `submit(request)` admits and returns a `Handle` without waiting. `id` is
    assigned at admission. `await` can be awaited repeatedly. `cancel` is
    idempotent and only requests cancellation.
  - `run(request)` is `submit` then `await`.
  - `get(id)` returns `Effect<Option<Status>>`; unknown or evicted ids are
    `None`.
  - `changes` is a status notification stream with a per-Change sequence number.
    Slow subscribers never hold the coordinator back; `get` reconciles missed
    updates.
- `Change.Request`: `key` (optional request key), `instance`, `candidate`,
  `strategy` (optional `"Overlap" | "Restart"`), `expected` (optional caller
  precondition on the instance version), `budget` and `requirements`.
  `Transition.Policy` is split into `Budget` (total, startup, probe, drain,
  stop, terminate; each is the limit of one sub-operation, total covers the
  whole Change) and `Requirements` (probes, and trial as a minimum observation
  time charged to the total). Admission checks that the total covers the trial,
  cleanup and the recovery path, including the recovery trial.
- Rejections are not Changes and carry no id: `ChangeRejected`, a discriminated
  union by reason: `Busy` (conflicting objects and the Change ids holding them),
  `Closing`, `UnsupportedTarget`, `InvalidBudget`, `Stale` (a precondition no
  longer holds), `KeyConflict`, `Capacity` and `Unsupported` (closure or
  strategy outside phase 1). Class name equals tag. `Busy`, `Stuck`,
  `InvalidPolicy` and `OverlapRequired` leave `Transition.Reason`.
- Outcomes keep the five tags with `phase` and `evidence`, plus `change` (the
  id) and `members`.
- `Graft.transition` is deleted; callers move to `Change.run`. `Transition`
  keeps only the driver extension points.
- `capacity` becomes the runtime option `maxUnits`.
- Completion condition: `Serving` only. `Committed` needs the supervisor and
  arrives in phase 4.

### Outcomes and member facts

- `Accepted` requires the completion condition and all required settlement
  obligations.
- `Aborted` means the old generation was never stopped or rerouted and is still
  usable.
- `Recovered` means the recovery target serves again and met its Serving
  requirements, including trial, whether or not the route had switched.
- Shutdown reports the actual stopped or unavailable state; it never reports
  `Aborted` when the old generation is no longer usable.

Unit exit settles that generation's runtime execution obligations and leases; it
does not establish successful finalization. Host cleanup keeps its own
completion record and full exit. An unmarked interruption or a repeated
`Scope.close` is never treated as successful cleanup (the `Release.close`
attribution gap). Unresolved attribution and late causes stay observable.

`Status` records the Change source and each member's selection reason. Member
facts are:

- starting version and health;
- desired target;
- `NotStarted`, or execution progress and outcome;
- compensation disposition (`NotNeeded` for single-member Changes);
- actual version and health, and whether it matches the target;
- recoverability with a reason.

Status and diagnostics share the Change id and the available trace correlation.
Desired state is a desired configuration and version, not a generation that may
not exist yet.

### Request keys

Request equality covers `instance`, `expected`, strategy, budget, requirements,
and the candidate's driver, identity and desired deployment. Effect 4's
`Equal.equals` compares plain records structurally, so no fingerprinting is
needed, but every compared value must be one immutable normalized
representation: duration inputs normalized, documented defaults applied, absent
and explicit `undefined` unified, the key itself and runtime-generated ids
excluded.

Duplicate lookup precedes admission checks, so a retry returns the original
Change even after its preconditions went stale. A different normalized request
under the same key fails with `KeyConflict`. Keyed admission records stay
available for the runtime lifetime, independently of the bounded observation
history; this retention is not memory-bounded in phase 1, and eviction never
lets a keyed request run again. Persistent deduplication is phase 5.

## Admission and commit

Admission is one short STM transaction. It reads the plan's preconditions,
checks versions and reserves the complete conflict set. Objects in phase 1 are:
the instance, every service slot its facades publish (realm and key), and the
dependency edges whose retirement waits on consumers. Reads are shared and
writes have one owner. A conflict rejects with `Busy`; nothing queues and
nothing is taken over. The reservation lasts until the Change settles, through
trial and recovery. Transactions never span remote waits.

The internal plan records versioned read and write conditions for every relevant
object, including service-slot absence and authorization conditions.
`Request.expected` is an optional caller precondition on the instance; it does
not replace the plan's internal preconditions. Object versions stay
distinguishable across removal and recreation, so absence, presence, absence
(ABA) is detected.

A commit applies only this Change's patch (the new route and generation),
checking the versions it reserved; it never writes back a snapshot read at
planning. Recovery restores only versions the Change still owns. If recovery
meets an incompatible state left by another accepted Change, it does not
overwrite it: it reports `RecoveryFailed` with the conflict in the evidence.

Planned withdrawal is attributed to its owning Change. External invalidation
records its cause and stops affected progress; it is never discarded as `Busy`.
Discovering a conflict outside the admitted set settles staged work and requires
fresh planning and admission.

Instances are indexed by name. Admission and commit touch only the Change's own
objects. The runtime-wide `transitionBusy` and `transitionStuck` flags and the
scan over all forks are deleted.

Acknowledgements from drivers carry the Change id, the generation and the route
version; late ones are ignored. Disposing the runtime first closes admission,
then cancels admitted Changes; their outcomes keep the interrupted phase.

### Ownership of Changes and Stuck

Admitted Changes and unresolved settlement watchers are owned by the runtime and
outlive caller and instance scopes. Instance disposal closes admission but is
not exit evidence and does not release unresolved reservations.

A recorded `Stuck` outcome is immutable. Late evidence updates the current
settlement facts. Reservations are released only after all relevant obligations
are settled or safely fenced from newer state, using generation identity and
reservation-owner checks; a watcher can never release state of a re-registered
instance of the same name or of a later Change. Release does not resume the
failed Change or turn it into `Accepted`; restoring service takes a new Change.
The phase 0 model and observer get an explicit reservation-release transition
before automatic release is implemented. Unresolved records are kept
independently of the bounded settled history.

## Strategies

Strategy is selected before candidate execution can overlap the old generation.
`Overlap` requires a verified declaration for the candidate and support from its
placement (runners support only `Restart`). Without that information, `Restart`
is selected; an explicit unsupported `Overlap` request is rejected before
execution. Preparation before stopping the old generation must not execute the
candidate plugin or acquire resources that need the old generation to have
stopped. Drivers therefore declare overlap support as part of the candidate's
verified deployment description, before `Unit.start`.

- **Overlap**: validate; allocate and start the candidate; readiness and probes;
  commit the route and begin trial; drain and stop the old generation and obtain
  its exit evidence; confirm completion; record.
- **Restart**:
  1. Validate, decide the strategy and capacity, and create the full Change
     record.
  2. Pause new admission to the instance's facades, keeping calls already
     admitted to the old generation.
  3. Drain the old generation. Record the recovery boundary before issuing any
     operation that may change the old generation.
  4. Stop it and obtain exit evidence. Settle its leases and the host cleanup
     that must complete.
  5. Allocate and start the candidate; describe, serve, ready, probes.
  6. Commit the route and version atomically and open the queue. Queued calls
     choose their generation only now.
  7. Finish after the trial and cleanup obligations are met.
  8. On failure, settle the candidate first. If the old generation is unchanged
     and usable, the outcome is `Aborted`; otherwise recover.

Both strategies share the allocate, start, probe, retire, commit and settle
primitives; they differ in order. The existing single-owner host release record
is kept; a repeated close never stands in for waiting on the original owner.

The engine tracks whether the old generation may have been changed,
independently of route cutover. Cancellation before that boundary settles the
candidate and keeps a usable old generation. Cancellation after it enters
recovery. That stopping may have begun is recorded before waiting for a stop
acknowledgement.

Recovery starts from the previous desired target, obtains fresh resolution and
authorization, and meets its Serving requirements, including trial.

### Paused admission

While admission is paused, calls wait with explicit limits
(`Registration.queue`: maximum waiters and maximum wait, with defaults). Queue
cancellation and expiry remove a waiter exactly once. Dispatch selects the
generation and checks authorization atomically when the call is admitted.
Overflow, expiry, closing and failed recovery complete waiting calls with a
declared rejection; `AdmissionRejected` gains a form for calls rejected before a
generation was chosen.

## Ownership and terms

Two identity levels:

- The instance and fork keep the stable logical identity, parent and child
  relations and facade bindings. A facade is published once by the long-lived
  managed activation; a cutover never republishes it, so stable consumers are
  not restarted.
- A generation owns its resolution, leases, publications, activity state and
  cleanup record.

Rules for generations:

- `Provision.consumers` records generation tokens; each activation cycle and
  each managed attempt gets a fresh token. Repeated injection within one
  generation still takes a single lease.
- Withdrawal and teardown update only state owned by their generation, compared
  against its token, so an old generation's cleanup never erases a newer one's
  resolution, publications or leases.
- Cycle detection covers every live generation's resolution, including old
  generations that withdrew their publications but still hold leases, and keeps
  parent and child ownership edges.
- When exit evidence arrives, the generation's runtime leases and reverse
  indexes are settled exactly once. Repeated evidence and late teardown are
  idempotent, including slot retain and release counts. Settlement does not
  claim the finalizers succeeded.

Each instance keeps a term high-water mark in memory. A new generation gets the
next term before it starts. The term is recorded in the instance state before
the grant and passed to the driver at allocation. A failed allocation never
re-grants the same term. Phase 1 gives no fencing across runtime restarts, and
exposing the term to plugin code inside a unit is phase 2.

### Desired and resolved candidates

The unresolved desired candidate is kept separately from each generation's
resolved allocation input. `Registration.resolve` receives the desired candidate
before every allocation, including initial startup and recovery. The default
identity resolver is valid only for candidates with no deferred references.
Resolution never replaces the kept desired candidate with resolved credentials
or other transient values. The driver validates the resolved input and checks
current authorization before execution. Any change to the admitted resource
footprint needs fresh planning and admission.

### Capacity

`maxUnits` counts:

- initial registrations;
- reserved allocations;
- serving and draining units;
- units without exit evidence.

Rules:

- Admission reserves the peak additional capacity that the selected strategy and
  its recovery path need.
- Restart may reuse capacity released by a confirmed old-unit exit.
- Another Change cannot consume capacity reserved for recovery.
- Deadlines and disposal requests do not release unconfirmed execution capacity.

Phase 1 bounds managed-unit count and facade waiter count and duration. Byte,
memory and external-resource limits are not claimed and stay later work.

## Observation

`Status` contains:

- the id, request key and source;
- instance and strategy;
- current phase and remaining budget;
- members with their facts;
- generations that hold leases;
- units without exit evidence;
- desired versus actual configuration.

Settled statuses live in a bounded in-memory history (default limit), apart from
keyed admission records and unresolved records. Full causes stay in memory in
phase 1; diagnostic references are phase 5.

## Release plugin migration

Migrating release execution to `Change.run` includes handling `ChangeRejected`
separately from admitted outcomes. A rejection stops forward dispatch and enters
the existing compensation path for earlier accepted entries; it is not turned
into an `Aborted` Change. Compensation carries the expected version produced by
the entry it compensates; a conflicting later change is reported and never
overwritten. Rejections and admitted Change ids stay distinguishable in release
observations.

The release plugin keeps resolving `$env` and secret references, but hands core
the unresolved desired input through `Registration.resolve` so recovery and
compensation re-resolve. Previously resolved deployment snapshots are not
recovery targets. Phase 1 keeps the plugin's serialized batch orchestration;
concurrent-entry proofs submit independent Changes directly and do not claim
phase 5 batch guarantees.

## Implementation order

The changes to `runtime.ts`, `activation.ts`, `dependencies.ts` and
`Graft.provide` form one coupled change and are not split across workers.

| Step | Reviewable diff                                                                                                               | Tests written first                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Model additions (Stuck release, request normalization, capacity state); public types and errors                               | Immutable outcomes, repeated evidence, `expected` in `KeyConflict`, ABA, Restart and recovery at full capacity                                                   |
| 2    | Generation resolution, lease and publication ownership                                                                        | Two generations leasing one provider; old teardown does not harm the new one; repeated cleanup after exit; parent, child and cycle order                         |
| 3    | Change table, instance index, reservations and versions, runtime ownership, `get` and `changes`                               | B completes while A is in trial or Stuck; same target is Busy; reverse-order commits; cancel of a wait; admission racing shutdown                                |
| 4    | Restart, explicit cancel, recovery and budgets, paused admission                                                              | No candidate start before old exit; pause boundary; queue overflow, expiry and cancel; recovery after candidate failure; recovery trial; unfinished host cleanup |
| 5    | plugin-remote (declared overlap support, `resolve`, term) and plugin-release (rejections, compensation versions), in parallel | Credential rotation, revoked authorization, unsupported Overlap; A accepted then B rejected still compensates; compensation version conflict not overwritten     |
| 6    | Docs, sample, real adapter for the phase 0 scenarios, packed proof                                                            | Model, engine and remote coverage stated separately; two instances changing in parallel                                                                          |

Steps 5 and 6 shipped as written. From phase 2 on, paths that a later phase
deletes or rebuilds (Remote module mode, the release journal, `replace`, HMR,
`Update`, `ManagedFork`) are not migrated again; they are deleted in the phase
that replaces them, and behavior worth keeping becomes acceptance tests for the
new mechanism.

Edge cases come before happy paths: host cleanup still blocking after unit exit;
candidate start failing after the old generation stopped; Stuck followed by
disposal; the same key retried after history eviction. Ordering uses `Deferred`,
budgets use `TestClock`; no sleeps. The object-access test counts real
production accesses; it shows there is no full scan, not that latency is
constant under load. Existing cleanup ownership tests stay. Tests that encode
old outcome semantics (for example `Aborted` after the old generation stopped)
are migrated explicitly, never carried over unchanged. `activation-release`
tests that accept every pure interruption as success are reviewed against the
attribution gap rather than kept green by dropping causes.

## Proof

1. Every phase 0 scenario is listed as implemented, unsupported with a
   rejection, or deferred to a named phase. The adapter drives production
   admission, version checks, leases and commits; it never implements missing
   protocol behaviour itself.
2. Core tests for every strategy and phase failure listed above, plus budget
   validation with the trial and recovery trial charged to the total.
3. plugin-remote and plugin-release tests for step 5; the integration gateway
   sample moves to `Change.run`, and the packed gateway proof passes, including
   two managed entries changing concurrently.
4. Docs in three languages: `transitions.md` becomes the Change page (submit,
   await, observe, rejections, strategies, outcomes, and the unsupported
   remote-drain guarantee); `loader-api.md`, `config-file.md`, `cli.md` and
   `mcp-server/projection.md` follow.
5. treefmt, typecheck, tests, build (TypeDoc validation) and the packed proofs
   pass through devenv.

Excluded: deployment groups and closure (phase 3); the supervisor, `retry` for
managed instances, `Committed` and the deletion of `ManagedFork` (phase 4);
batch reservations, persistence and persistent dedupe (phase 5); the inter-unit
completion record and term exposure inside units (phase 2); byte and memory
capacity.
