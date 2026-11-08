---
title: Units
description: Run kernel instances behind a native execution boundary.
---

A **unit** is a native execution boundary outside the kernel. Worker units
provide a fault boundary. Sandbox a Process unit for untrusted work (see
[Trust policy](../trust/#execution-boundaries)).

## Select captured code

Capture built JavaScript with `Artifact.capture`, then select its optional
contract export and encoded configuration. Plugin and contract imports and
configuration decoding run inside the unit.

```ts
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Units from "@graftland/plugin-remote/Units"

declare const artifact: Artifact.Artifact
const target = Units.target({
	artifact,
	contract: "contract.js",
	input: { region: "north" },
	placement: "Worker",
})
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 3,
	instances: [{ id: "forecasts", target }],
}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
export const inspect = Effect.flatMap(Kernel.Kernel, (kernel) =>
	kernel.inspect({ instance: "forecasts", target }),
)
```

Omit `contract` for a plugin without encoded endpoints. Inspection decodes the
plugin's own configuration schema without activating it or inventing a contract.
Such a target uses Restart.

## Inspect before admission

`kernel.inspect` validates a target without activating it. Submission can also
start inspection. Both paths charge inspection and retirement to the total
budget.

| Fact        | Rule                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Capacity    | An inspection consumes a unit slot; uncached inspection can fail at full capacity.                                            |
| Reuse       | A verified description requires the same artifact, configuration and validation environment. Authorization is checked afresh. |
| Rejection   | `ChangeRejected.preparation` identifies retained inspection evidence. No Change id is created.                                |
| Observation | `getPreparation`, `preparations`, `inspections` and `units` expose remaining work and exact exit evidence.                    |
| Waiting     | Interrupting a submit waiter leaves runtime-owned inspection running.                                                         |

## Unit environments

Each unit builds its own Node services, HTTP client, clock and logger. Custom
environment and intercept modules export Layers and receive JSON options through
`Configuration.Options`. Ordered recipes build fresh Layers; recovery rebuilds
them and resolves raw references under the current policy.

| Preparation           | Behavior                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Module resolution     | Checks the export form in a disposable unit; does not decode plugin input or apply it.     |
| Deployment inspection | Builds environment modules and decodes configuration without apply or serving resources.   |
| Execution             | Rebuilds the environment and rechecks the inspected declarations.                          |
| Deadlines             | Terminate the unit and require native exit evidence; missing evidence remains outstanding. |

Use [Loader preparation](../loader-api/) to register immutable intercept
modules. Functions, Schemas, Contexts and Layers never travel in deployment
data.

## Choose placement

| Placement | Execution owner                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------ |
| `Worker`  | Kernel placement service observes the exact Worker exit.                                         |
| `Process` | Kernel placement service observes the exact child exit.                                          |
| `Runner`  | `Units.serveRunner` owns the child and reports its exact incarnation; only Restart is supported. |

A runner address contains its local control socket and owner identity.
Disconnect does not establish exit. Missing exit evidence retains capacity and
ownership.

A clean control connection close is a debug event. Invalid or truncated frames
remain errors. Neither connection closure nor a frame error proves unit exit.

### Module formats

| Module                                                     | `Worker`                                                 | `Process`                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| ES module                                                  | Supported                                                | Supported                                                         |
| CommonJS (`.cjs`, or a package without `"type": "module"`) | Supported                                                | Supported                                                         |
| Native addon (`.node`)                                     | Only if the addon supports several instances per process | Supported; tested with a compiled N-API addon across replacement. |

Each reload starts a new unit, so a module's code, cache and addons are loaded
fresh; nothing from the previous generation stays in memory.

## Supervision

A failure that no Change owns belongs to the **supervisor**. It restarts within
a bounded **restart intensity**, then stops and keeps the failure observable.
Set the policy in deployment data with `supervision`.

| Field             | Rule                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `intensity`       | At most this many attempts per instance within `period`; default `3`.                          |
| `period`          | Intensity window in milliseconds; default `60000`.                                             |
| `backoff`         | Optional `{ initial: 100, factor: 2, max: 5000 }`: wait 100 ms, 200 ms, 400 ms, up to 5000 ms. |
| Omitted `backoff` | No delay, preserving immediate restarts. `initial: 0` also disables delay.                     |

| Event                                              | What the supervisor does                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A member fails                                     | Restarts it and its local consumers in their unit; healthy co-residents keep serving.                              |
| A unit exits on its own                            | Settles the whole group, then submits one Change that deploys the group's desired targets.                         |
| The intensity is exhausted                         | Escalates the instance: it stays failed and nothing else restarts. An accepted Change for it lifts the escalation. |
| A Change owns the member                           | The Change fails or recovers; the supervisor starts no competing attempt.                                          |
| Backoff or a conflicting Change delays the restart | Keeps it pending; waiting consumes no attempt.                                                                     |
| An operator Change is accepted                     | Resets backoff for its instances and discards their stale pending restarts.                                        |
| The kernel shuts down                              | Cancels waiting restarts.                                                                                          |

Attempts count when a restart starts and survive new generations; `Busy` and
planned generations do not count. Consecutive failures share backoff progress,
including successful supervisor restarts. A busy retry reuses its elapsed delay.
Backoff durations are nonnegative milliseconds; the factor is at least `1`.

`kernel.supervision` and [`client.supervision`](../control/) return attempts,
escalation and an optional `reason` for every desired instance. Reasons apply
when no Change owns the instance; a serving instance has none.

| `reason`               | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `Revoked`              | Current policy denies the desired target.                                                          |
| `Escalated`            | The supervisor has stopped retrying, including when intensity is exhausted.                        |
| `WaitingForDependency` | A required provider is unavailable.                                                                |
| `RestartPending`       | A restart waits for backoff, preparation or a conflict.                                            |
| None                   | No supervisor reason applies, including while a Change owns the instance or the kernel shuts down. |

When several reasons apply, revocation takes precedence, then escalation, then a
missing dependency, then a pending restart.

## Read the execution term

`Plugin.term` exposes the kernel's execution grant inside a serving unit. Each
attempt consumes a new term, including a failed spawn. Inspection and ordinary
embedded callers receive `UnitOnly`. Terms persist for this kernel lifetime;
fencing across kernel restarts requires durable external coordination.
