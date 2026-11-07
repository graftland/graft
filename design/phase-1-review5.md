# Phase 1 review, round 5 (recorded, not fixed)

Independent GPT-6 Astra review of 7ab56ee..8a9d2a2, run after the owner stopped
per-defect repair. Recorded as residual risk; [Phase 2](phase-2.md) replaces the
mechanisms involved.

**2. Ranked findings**

**F1 — High: replacement skips cleanup left by a spontaneous idle exit.**

Location: `packages/core/src/internal/changeAdmission.ts:372`, with
`transition.ts:899`.

When a serving Unit exits outside an active Change, `observeExit` clears the
route and starts asynchronous host cleanup. The next Change captures its
previous generation and obligations only from that now-empty route. Restart
consequently skips retirement, starts the candidate and returns **Accepted while
the prior host cleanup remains blocked**.

This violates **P67–80, P186–191, P195–197; A219–220, A351–355**.

**Proved by running code:** probe `review-phase1-probes.test.ts:19` signals the
registered Unit’s exit, waits for its finalizer’s Deferred gate, then invokes
production `Change.run`. Accepted arrives before cleanup is released.

**Fix direction:** capture unresolved registration obligations independently of
the serving route. Exclusive startup must await the required original cleanup
within budget, or retain ownership and reject/report Stuck.

**F2 — High: registration succeeds after runtime admission closes and misses
shutdown.**

Location: `packages/core/src/internal/transition.ts:1040,1083`;
`packages/core/src/Graft.ts:243,254`.

Shutdown closes Change admission and snapshots registered instances.
`admitRegistration` never checks that closing flag. A new registration during an
existing instance’s blocked cleanup starts successfully after the snapshot.
Runtime shutdown can then finish without terminating that Unit.

This violates **P145–153; A418–421**, and the distinction between scope cleanup
and exit evidence in **A218–220**.

**Proved by running code:** probe `review-phase1-probes.test.ts:71` closes an
actual `Graft.layer` scope. Observed result after shutdown completes:

```text
registration: Success
lateUnitExited: false
```

This proves the missing fence and termination path using a controlled driver; it
is not a measured real-process leak.

**Fix direction:** check runtime admission atomically before registration claims
capacity/inserts the instance. Also ensure initial allocation/cutover racing
shutdown remains owned by its teardown protocol.

**F3 — Medium: history eviction retains an unbounded chain of settled records.**

Location: `packages/core/src/internal/changeTable.ts:281`;
`changeAdmission.ts:372`; `transition.ts:501,787,317`.

Removing an id from `table.records` does not detach its execution graph. A newer
record retains the previous Attempt in `obligations`; that Attempt’s cleanup
effects retain the callback and Change that created it. Repeated successful
replacements therefore retain predecessor records through recent history/live
generations.

This violates **P294–296**. The general memory-capacity exclusion does not
exempt the explicitly bounded settled history; these records are unkeyed and
settled.

**Proved by running code, with the retention path established by reading:**
probe `review-phase1-probes.test.ts:110` executes 141 unkeyed Changes. The table
contains 128 records, but a WeakRef to the first remains live after repeated
event-loop turns and explicit GC. Existing eviction tests establish lookup/table
bounds, not collectability.

**Fix direction:** detach completed execution callbacks and predecessor
obligations from archived facts. Preserve immutable evidence and the intentional
keyed/unresolved exceptions.

**F4 — Low: Traditional Chinese release documentation omits rejection
compensation.**

Location: `packages/docs/content/docs/zh-tw/application-releases.md:78`.

English and Simplified Chinese now explain that `ChangeRejected` stops forward
dispatch and compensates earlier accepted entries. Traditional Chinese still
describes only Aborted/Recovered. Its later observation paragraph does not
supply the missing behavior.

This violates **CLAUDE.md:18; STYLE.md:106–107**, for behavior specified by
**P300–306**.

**Verified by reading.** Add the corresponding rule to the Traditional Chinese
failure row. Passing snippet/link tests do not establish semantic translation
parity.

**3. Effect idioms**

- **Low — oversized lifecycle closures:** `transition.ts:308–1038` combines
  allocation, evidence, readiness, routing and host release; registration at
  `:1171–1375` and preparation at `changePreparation.ts:52–191` are deeply
  nested. These boundaries obscure long-lived captures—F3 demonstrates a
  concrete consequence. Extract smaller functions with explicit ownership
  dependencies.
- The STM reservation state and `asyncClose` state plus Deferred serve real
  protocol requirements. I would not replace them mechanically with
  `Effect.cached` or repeated `Scope.close`.
- I found no additional actionable new unowned-fiber, unsafe-cast,
  inline-import-type, broad diagnostic-suppression, synchronous-throw or
  import-time-I/O issue in the inspected kernel changes.

The model adapter calls production admission, versions, leases and commits; its
release action waits for production release. Exhaustive model schedules are not
exhaustive runtime proofs. Release’s mock tests are supplemented by a real
admission/version-conflict test. Remote policy tests use production Policy with
a controlled driver; separate Worker/Local tests cover credential rotation and
unsupported Overlap.
