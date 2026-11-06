---
title: Execution transitions
description:
  Observe coordinator outcomes and implement a scoped execution driver.
---

`Graft.transition` coordinates replacement of one managed fork's execution unit.
**Managed forks** register an execution driver and keep their contract service
objects across generations. There is no built-in Remote transition driver yet;
ordinary plugins, Remote plugins and runner targets return `Aborted` with
`UnsupportedTarget`.

## Request a transition

```ts
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

declare const forkId: number
declare const deployment: Remote.CandidateOptions

export const request = Graft.transition({
	fork: forkId,
	candidate: Remote.candidate(deployment),
	policy: { drain: 5_000, terminate: 5_000, probes: ["health"] },
})
```

`Remote.candidate` constructs an inert description of a captured artifact,
contract module, direct target and input. It neither verifies nor starts the
artifact. [Capture and verification](../remote/artifacts/) remain explicit. This
request currently returns `Aborted(UnsupportedTarget)` for Remote forks.

| Admission rule                                              | Result                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Another transition is running, including its trial window   | `Aborted(Busy)`; nothing is queued.                                                           |
| Target has no matching registered driver                    | `Aborted(UnsupportedTarget)` before allocating a unit.                                        |
| A deadline is non-finite or not positive; trial is negative | `Aborted(InvalidPolicy)`. Zero trial is allowed.                                              |
| A previous transition has unconfirmed termination           | `Aborted(Stuck)` until the runtime is disposed. Late exit evidence does not reopen admission. |
| Caller cancels after admission                              | The fork owns completion and recovery; cancelling the wait does not cancel the transition.    |

## Outcomes and evidence

| Outcome          | Meaning                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Accepted`       | The candidate serves; the previous unit has observed exit evidence.                                                                                                           |
| `Aborted`        | Admission failed, or the candidate failed before cutover and its termination was confirmed. The old route is retained after candidate rejection.                              |
| `Recovered`      | Candidate and old-unit termination were confirmed, then a fresh attempt of the old artifact became ready. This also covers an old attempt failing during candidate rejection. |
| `RecoveryFailed` | Recovery failed; failed units have confirmed termination, and calls receive `Unavailable`.                                                                                    |
| `Stuck`          | A required termination could not be confirmed. Calls receive `Unavailable`; later transitions are blocked.                                                                    |

Outcomes carry the phase and evidence, including complete failure causes,
deadlines and observed exits. A termination command, lost transport or closed
scope is not exit evidence. Stopping or draining can time out without preventing
`Accepted` if termination is confirmed; those failures remain in the evidence.

## Policies and calls

All durations are milliseconds. `startup` bounds each allocation, start,
description, serving and readiness operation. `probe` bounds each requested
probe. `trial`, `drain`, `stop` and `terminate` bound their respective stages.
Defaults are 30 seconds for startup, 5 seconds for the other deadlines, no trial
window and no probes. Drivers must declare overlap safe and provide every
required `name@version` before cutover.

A facade selects its serving attempt when a call's Effect executes, even if the
Effect was constructed earlier. Selection and admission are atomic with cutover.
An admitted call stays on that attempt. New calls use the new attempt; old calls
finish, are cancelled, or end when the old unit exits after the drain budget.
Unit termination provides cleanup evidence; RPC response delivery alone does not
prove server request-scope cleanup.

`Fork.generations` observes starting, serving, draining, terminated and stuck
generations. Unmanaged forks report an empty list. Recovery allocates a fresh
unit and attempt; it does not reuse a failed attempt.

## Driver extension point

```ts
import { Plugin, Transition } from "@graftland/graft"

declare const driver: Transition.Driver
declare const registration: Transition.Registration

export const integration = Plugin.make({
	name: "example/integration",
	apply: () => Transition.registerDriver(driver, registration),
})
```

Registration is scoped to the current fork. Its facade provisions and service
objects belong to that fork, not to any unit's serving scope.
`Transition.facade` builds a service object once and supplies an invocation
function to its methods. The coordinator owns readiness, probes, cutover, drain
and recovery. Drivers supply lifecycle operations, private service contexts and
an independently observable exit; they cannot change routes.

Allocation must be inert: external execution starts in `Unit.start`. Driver
operations must be safe to cancel; unresponsive operations remain owned until
fork disposal. Supply independent, repeatable `failure` and `exited`
observations. Describe the implementation's own operation identities, and use
ordinary plugin `apply` as the serving body. Graph-resolved host dependencies
and automatic plugin retry are unsupported for managed registrations; ambient
runtime services are allowed. State transfer, general preparation, streaming
facades, runner transitions and multi-fork transitions are not implemented.

## Bypass protection

| Route                         | Managed behavior                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Fork.update`, `Fork.restart` | Fail with `ManagedFork` before changing the fork or a managed descendant.                                        |
| `Graft.replace`               | Fails with `ReplacementConflict` and reason `ManagedFork` before changing aliases or specs.                      |
| Loader                        | Rejects edits, refreshes and retry for a tree containing a managed fork before invoking store mutations.         |
| HMR                           | Returns `Skipped` with reason `managed-fork` before reload preparation when the runtime contains a managed fork. |

Extension tools can use `Transition.withUnmanaged` to hold bypass admission
through an external write. Driver registration fails while that write is in
progress. `Transition.assertUnmanaged` is a read-only preflight; it does not
hold admission across later work. Explicit fork disposal remains available.
