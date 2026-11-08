---
title: Unary calls
description:
  Observe execution credits independently of results and cancellation.
---

A **call credit** pins one admitted unary call to its provider generation. Its
identity includes provider and consumer incarnations, session and request id.
Calls use the direct [binding](../bindings/) channel.

## Observe calls

```ts
import { Effect } from "effect"

import { Kernel } from "@graftland/graft"

export const calls = Effect.flatMap(Kernel.Kernel, (kernel) => kernel.calls)
export const changes = Effect.map(Kernel.Kernel, (kernel) => kernel.callChanges)
```

## Completion

| Fact        | Meaning                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Result      | The consumer reports a terminal RPC result. This does not end provider execution.                                       |
| Cancel      | Requests interruption. A cancellation acknowledgement does not release credit.                                          |
| Completion  | Graft closes its handler Scope with the original Exit and retains the completion report until acknowledgement.          |
| Native exit | Settles only execution in that provider incarnation. Consumer exit and disconnect do not establish provider completion. |

Register finalizers with `Effect.addFinalizer` in the handler. Graft owns this
Scope and its execution. A result can arrive while those finalizers still run.
Retirement drains these credits before Stop; drain expiry requests cancellation,
then Stop, termination and exact exit evidence. Missing evidence remains Stuck.

This covers the Graft-supplied single-hop Scope. It does not cover RpcServer’s
private request Scope. Streams, deferred replies, discarded calls and nested
cross-unit completion are rejected. Original defects and unknown interruption
attribution remain visible.

## Set limits

```ts
import { Kernel } from "@graftland/graft"

declare const instances: Kernel.Deployment["instances"]
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 4,
	instances,
	callLimits: { concurrency: 64, waiters: 64, wait: 5000 },
})
```

| Field         | Default                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `concurrency` | 64 admitted calls across the kernel; overflow is NotAdmitted.                                 |
| `waiters`     | 64 callers waiting for Restart admission across the kernel; overflow is NotAdmitted.          |
| `wait`        | 5,000 ms maximum gate wait. Expiry or cancellation removes a waiter without execution credit. |

Restart pauses the changed binding. A waiter selects its generation when
admitted. Existing calls stay pinned. After registered dispatch, loss without a
result is Unknown; Graft never retries the business call. Cancellation, exit and
completion have reserved control capacity. Encoded data frames are limited to 1
MiB. These bounds do not bound total process memory or external resources.
