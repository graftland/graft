---
title: Changes
description: Submit, await and observe independent runtime changes.
---

A **Change** is one admitted runtime replacement with a stable id. The runtime
owns it through trial, recovery and settlement. Unrelated instances can change
while another Change waits or is Stuck.

## Submit and await

```ts
import { Effect } from "effect"

import { Change } from "@graftland/graft"

declare const candidate: Change.Candidate

export const replacement = Effect.gen(function* () {
	const handle = yield* Change.submit({
		key: "forecasts-v2",
		instance: "forecasts",
		candidate,
		strategy: "Overlap",
		requirements: { probes: ["health"], trial: "2 seconds" },
	})
	return yield* handle.await
})
```

`Change.run` submits and awaits in one call. Cancelling a wait leaves the Change
running; `handle.cancel` explicitly requests cancellation and is idempotent.
Awaiting the same handle again returns the same outcome.

## Observe

`Change.get(id)` returns the current status, or `None` for an unknown or evicted
id. `Change.changes` sends bounded notifications with per-Change sequence
numbers. Slow observers never block execution; reconcile gaps with `get`. Status
includes the Change id, available trace correlation, member facts and settlement
evidence. Diagnostics carry the same correlation. Settled observation history
retains 128 Changes. Keyed admission records and unresolved records are retained
separately.

## Request keys

The same key and normalized request return the original handle before admission
checks, even after a version change or history eviction. Changing the instance,
candidate, expected version, strategy, budgets or requirements under that key
produces `KeyConflict`. Keys remain in memory for the runtime lifetime.

Concurrent retries return that handle independently of redundant metadata
cleanup; late cleanup failures are logged with their full cause.

## Admission

Rejections are `ChangeRejected` errors with no Change id. Nothing queues behind
a conflicting Change.

| Reason              | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `Busy`              | Conflicting objects and their owning Change ids.                          |
| `Closing`           | Runtime or instance admission is closed.                                  |
| `UnsupportedTarget` | No matching registered driver.                                            |
| `InvalidBudget`     | Limits are invalid or omit required trial, cleanup or recovery allowance. |
| `Stale`             | The caller version or an internal prepared premise no longer matches.     |
| `KeyConflict`       | A request key already identifies different normalized input.              |
| `Capacity`          | Managed-unit capacity cannot cover the strategy and recovery.             |
| `Unsupported`       | The requested strategy or member closure is unavailable.                  |

## Outcomes

| Outcome          | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `Accepted`       | The candidate serves and required settlement is complete.          |
| `Aborted`        | The old generation was not stopped or rerouted and remains usable. |
| `Recovered`      | A fresh recovery generation meets Serving requirements.            |
| `RecoveryFailed` | Recovery did not restore service.                                  |
| `Stuck`          | Required settlement evidence remains unresolved.                   |

Outcomes retain their Change id, phase, members and full causes. Shutdown
reports actual availability. A Stuck conclusion never changes; late evidence
updates settlement facts. Reservations remain local to the affected objects
until settlement or safe fencing.

## Budgets and calls

`budget` limits total time and each startup, probe, drain, stop and termination
operation. Defaults are five minutes total, thirty seconds startup, and five
seconds for other operations. `requirements.probes` defaults to empty and
`requirements.trial` to zero. Trial is a minimum observation period; both
forward and recovery trial consume the total.

## Strategy

Overlap requires a driver-verified declaration before allocation. The candidate
starts before the old generation retires. Drivers without a verified declaration
reject explicit Overlap. Restart pauses new facade calls, drains and stops the
old generation, waits for exit and required host cleanup, then starts the
candidate. Queued calls choose their generation only when the new route opens.

`Registration.queue` defaults to 256 waiters and a five-second wait. Overflow,
expiry, closing and failed recovery reject calls before choosing a generation.
Cancellation and expiry remove a waiter exactly once.

Cancellation before the old generation may have changed can leave it serving
with `Aborted`. After that boundary, recovery resolves the previous desired
target again and completes its probes and full trial. Recovery takes a fresh
authorization premise for that target and retains the Change’s object versions
and reservations. Unconfirmed exit or host cleanup can produce `Stuck`; late
settlement never resumes that Change.

`Graft.Options.maxUnits` defaults to 256. Initial registrations, reserved
allocations, serving units, draining units and units without exit evidence count
toward the limit. Restart can reuse capacity after confirmed old-unit exit;
recovery capacity stays reserved from other Changes.

## Start a managed Remote plugin

Artifact-backed Remote deployments register their driver through
`Remote.plugin`; Loader binds the entry id, while embedded registrations supply
an explicit instance name. See [artifacts](../remote/artifacts/).

## Driver extension point

`Transition.registerDriver` publishes stable facades once. Changes that preserve
a facade binding share its read premise, so its provider and compatible
consumers can change concurrently. Phase 1 does not change facade publication or
ownership. A generation owns its execution, resolution and leases. Driver
allocation must not start execution; execution begins in `Unit.start`.
`Registration.resolve` receives the unresolved desired candidate before every
allocation, including startup and recovery. Each allocation receives a fresh
monotonic term and a Change, generation and route version token; the unit echoes
the token in its acknowledgement. An acknowledged stop, disconnected transport
or closed scope never replaces exit evidence.

`Transition.Driver.prepare` verifies deployment metadata before admission
without executing the plugin. Authorization versions are checked again at route
commit; removal and recreation cannot hide a stale premise. Metadata cleanup
keeps its original completion record and may also leave a Change Stuck.

Each managed generation keeps its own leases to captured providers and retained
service slots. Confirmed unit exit releases those runtime leases independently
of host cleanup. Ending the registration scope closes facade admission; an
unconfirmed generation keeps the instance name fenced until late settlement.
Runtime ownership of a disposed registration ends after its execution, cleanup
and admitted Changes have all settled.

## Remote drain

RPC results and client cancellation do not establish remote request-scope
completion, including ordinary unary calls. General remote request-scope drain
remains unsupported until the phase 2 completion record.

## Bypass protection

`Fork.update`, `Fork.restart`, Loader mutations and replacement reject managed
trees through the existing `ManagedFork` protection. Explicit disposal remains
available.
