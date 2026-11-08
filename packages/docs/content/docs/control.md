---
title: Public control
description: Submit and observe unit Changes from another process.
---

**Public control** exposes fixed metadata over a local TCP endpoint. Start
`Control.serve()` in the kernel scope and pass its returned address to the
client. The address includes the connection capability.

For a separate process, resolve `@graftland/plugin-remote/kernel` and run that
file with the deployment JSON path and ready-address JSON path as its two
arguments. The deployment is data described by `Control.Deployment`; the ready
file contains `Control.Address`. Importing the executable starts no work.

## Submit a Change

```ts
import { Effect } from "effect"

import type { Request } from "@graftland/graft/Kernel"
import { Control } from "@graftland/plugin-remote"

declare const address: Control.Address
declare const request: Request

export const replace = Effect.scoped(
	Effect.gen(function* () {
		const client = yield* Control.connect(address)
		const handle = yield* client.submit({ ...request, key: "deployment-42" })
		return yield* handle.await
	}),
)
```

Calls and configuration are encoded by [units](../units/); control never loads
business schemas.

## Observation

| Read                                  | Behavior                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `client.get(id)`                      | Returns the current sequenced status, or None after unkeyed settled history expires.                                                     |
| `client.observe(id)`                  | Returns an initial query and notifications. Compare sequence numbers and query again after gaps. Slow observers do not block the kernel. |
| `client.handle(id).await`             | Awaits the retained conclusion. Repeating await returns the same conclusion.                                                             |
| Disconnect or interrupted await       | Stops observation; an admitted Change continues. Reconnect and query by id.                                                              |
| `handle.cancel`                       | Explicitly requests cancellation; settlement still needs execution evidence.                                                             |
| `client.units`, `client.preparations` | Expose native exit evidence, cleanup classification, causes and residual reservations, including rejection before admission.             |
| `client.waiters`                      | Returns bounded queued calls before generation selection; no provider credit is assigned yet.                                            |

## Read a deployment plan

Status and conclusions contain a `members` map and a `plan`. A removed member
has no desired target; an initial member has no starting target. Every selected
member retains all selection reasons and their predecessors.

| Plan fact             | Rule                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Local dependencies    | Resolve concrete providers within realms; local edges and explicit co-location determine groups.                                              |
| Contract dependencies | A compatible consumer remains outside replacement unless another reason selects it.                                                           |
| Closure               | Repeatedly expand old and new groups, local captures and declared descendants. A split or merge does not turn the closure into one new group. |
| Placement             | Default to Worker for an unconstrained group; reject incompatible explicit requirements before lifecycle actions.                             |
| Reservations          | Include old/new membership, consulted realm/provider slots, optional absences, resources and distinct forward/recovery capacity.              |
| Concurrent work       | Commit and recovery apply the reserved patch; unrelated accepted deployments remain intact.                                                   |

Restart is the default strategy. Explicit Overlap requires every moved member,
resource and placement to permit it. A plan with a missing provider, dependency
cycle or placement conflict is rejected before old units are stopped.

## Retention

Settled unkeyed history is bounded. Keyed requests and unresolved facts remain
for the runtime lifetime. There is no durable history across a kernel restart.
Status members, remaining budget, lease holders and unconfirmed units come from
the same state as the outcome.
