---
title: Execution transitions
description:
  Observe coordinator outcomes and implement a scoped execution driver.
---

`Graft.transition` coordinates replacement of one managed fork's execution unit.
**Managed forks** register an execution driver and keep their contract service
objects across generations. Artifact-backed Remote plugins support direct
Workers and child processes. Ordinary module deployments and runner targets
return `Aborted(UnsupportedTarget)`.

## Start a managed Remote plugin

```ts
import { Schema } from "effect"

import * as Remote from "@graftland/plugin-remote"

declare const contract: Remote.Contract.Contract<typeof Schema.String>
declare const artifact: Remote.Artifact.Artifact

export const integration = Remote.plugin(contract, {
	artifact,
	contractModule: "@acme/integration-contract",
	target: { _tag: "Worker" },
	maxInFlight: 16,
	policy: { probes: ["health"] },
})
```

Pass business input to `Graft.plugin(integration, input)`. Use
`{ _tag: "Local" }` for a child process. The host runtime supplies filesystem,
path, secure random and child-process services. Managed Remote contracts support
unary operations and no injected host services. Graph-resolved host dependencies
and automatic plugin retry are unsupported. Module-based `Remote.plugin` options
continue to use ordinary restart behavior.

## Request a transition

```ts
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

declare const forkId: number
declare const deployment: Remote.CandidateOptions

export const request = Graft.transition({
	fork: forkId,
	candidate: Remote.candidate(deployment),
	policy: {
		total: "5 minutes",
		drain: "5 seconds",
		terminate: "5 seconds",
		probes: ["health"],
	},
})
```

`Remote.candidate` constructs an inert description of a captured artifact,
contract module, direct target and input. It neither verifies nor starts the
artifact. [Capture](../remote/artifacts/) remains explicit; the driver verifies
the captured bytes before launching each unit, including recovery.

| Admission rule                                                                         | Result                                                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Another transition is running, including its trial window                              | `Aborted(Busy)`; nothing is queued.                                                           |
| Target has no matching registered driver                                               | `Aborted(UnsupportedTarget)` before allocating a unit.                                        |
| A normalized deadline is non-finite or not positive, or total cannot cover the reserve | `Aborted(InvalidPolicy)`. Zero trial is allowed.                                              |
| A previous transition has unconfirmed termination                                      | `Aborted(Stuck)` until the runtime is disposed. Late exit evidence does not reopen admission. |
| Caller cancels after admission                                                         | The fork owns completion and recovery; cancelling the wait does not cancel the transition.    |

## Outcomes and evidence

| Outcome          | Meaning                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Accepted`       | The candidate serves; the previous unit has observed exit evidence.                                                                                                           |
| `Aborted`        | Admission failed, or the candidate failed before cutover and its termination was confirmed. The old route is retained after candidate rejection.                              |
| `Recovered`      | Candidate and old-unit termination were confirmed, then a fresh attempt of the old artifact became ready. This also covers an old attempt failing during candidate rejection. |
| `RecoveryFailed` | Recovery failed; failed units have confirmed termination, and calls receive `Unavailable`.                                                                                    |
| `Stuck`          | A required termination could not be confirmed. Calls receive `Unavailable`; later transitions are blocked.                                                                    |

`Transition.Outcome` provides tagged constructors and `$match`. Outcomes carry
the phase and evidence, including complete failure causes, deadlines and
observed exits. A termination command, lost transport or closed scope is not
exit evidence. Stopping or draining can time out without preventing `Accepted`
if termination is confirmed; those failures remain in the evidence. Direct-unit
evidence distinguishes `Exited` from `NotStarted`: the latter proves startup
settled before an execution was spawned. It never substitutes a lost connection
or an acknowledged termination command for an exit.

## Policies and calls

Policy durations accept `Duration.Input`, such as `"5 seconds"`,
`Duration.seconds(5)` or millisecond numbers. Converted deadlines must be finite
and positive; trial may be zero.

| Field                        | Bound                                                                | Default        |
| ---------------------------- | -------------------------------------------------------------------- | -------------- |
| `total`                      | Entire transition, including termination and recovery                | 5 minutes      |
| `startup`                    | Each allocation, start, description, serving and readiness operation | 30 seconds     |
| `probe`                      | Each requested probe                                                 | 5 seconds      |
| `trial`                      | Candidate observation after cutover                                  | Zero           |
| `drain`, `stop`, `terminate` | Calls, graceful stop, and each exit or host-release wait             | 5 seconds each |
| `probes`                     | Names requested before cutover and during recovery                   | Empty          |

Every stage wait is capped by the remaining total. Preparation and trial leave
`5 × startup + probes.length × probe + drain + stop + 6 × terminate` for cleanup
and recovery. Cleanup preserves the recovery allowance of
`5 × startup + probes.length × probe + 2 × terminate`. Recovery preserves two
termination waits until it succeeds or needs cleanup. The total must exceed the
initial reserve; otherwise admission returns `Aborted(InvalidPolicy)`. Drivers
must declare overlap safe and provide every required `name@version` before
cutover.

A facade selects its serving attempt when a call's Effect executes, even if the
Effect was constructed earlier. Selection and admission are atomic with cutover.
An admitted call stays on that attempt. New calls use the new attempt; old calls
finish, are cancelled, or end when the old unit exits after the drain budget.
`maxInFlight` limits admitted calls per attempt. The core registration default
is 256; Remote defaults to 16 and accepts 1–16. Excess calls are rejected before
admission with `AdmissionRejected`, without queuing. Remote reports coordinator
call failures through `RpcClientError`, with the original error in its reason's
cause. Cancelling a call releases its admission slot.

Unit termination provides cleanup evidence; RPC response delivery alone does not
prove server request-scope cleanup.

`Fork.generations` observes starting, serving, draining, terminated and stuck
generations. Unmanaged forks report an empty list. Recovery allocates a fresh
unit and attempt from the pinned previous artifact and input; it does not reuse
a failed attempt. Direct units attempt graceful exit after stopping; a stop
timeout leads to forced termination. External runtime dependencies are not
captured or pinned.

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
