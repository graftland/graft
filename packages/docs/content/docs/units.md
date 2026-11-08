---
title: Units
description: Run kernel instances behind a native execution boundary.
---

A **unit** owns one fixed plugin member outside the kernel. Worker units provide
a fault boundary. Use a sandboxed process deployment for untrusted work.

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

## Read the execution term

`Plugin.term` exposes the kernel's execution grant inside a serving unit. Each
attempt consumes a new term, including a failed spawn. Inspection and ordinary
embedded callers receive `UnitOnly`. Terms persist for this kernel lifetime;
fencing across kernel restarts requires durable external coordination.
