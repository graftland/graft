---
title: Changes
description: Submit, await and observe kernel changes.
---

A **Change** applies `Deploy` and `Remove` operations to kernel instances. The
kernel plans their deployment groups and owns trial, recovery and settlement.
Embedded `Graft.plugin` composition offers cooperative lifecycle and does not
install the kernel service.

## Submit and await

Build the kernel layer separately from the embedded runtime. A request contains
deployment data; it cannot pass a closure or a Context. Cancelling the waiting
fiber does not cancel the Change. Use `handle.cancel` to request cancellation.

```ts
import { Effect } from "effect"

import { Change } from "@graftland/graft"

declare const target: Change.Target
export const upgrade = Effect.gen(function* () {
	const handle = yield* Change.submit({
		key: "forecasts-v2",
		operations: [{ _tag: "Deploy", instance: "forecasts", target }],
	})
	const conclusion = yield* handle.await
	const current = yield* Change.get(handle.id)
	return { conclusion, current }
})
```

## Request fields

| Field                 | Meaning                                                                                                                             | Default                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `operations`          | `Deploy` (instance, target, optional realm, colocation and placement) and `Remove`.                                                 | Required                                        |
| `key`                 | Request key: the same key with the same request returns the same Change.                                                            | None                                            |
| `strategy`            | `Restart` stops the old generation before the new one starts; `Overlap` serves both during the switch. Runners only take `Restart`. | `Restart`                                       |
| `budget`              | Milliseconds for `total`, `startup`, `probe`, `drain`, `stop` and `terminate`.                                                      | 300 000 total, 30 000 startup, 5 000 each other |
| `requirements.probes` | [Probes](../probes/) the new generation must pass before it serves. A failure aborts or recovers the Change.                        | None                                            |
| `requirements.trial`  | Milliseconds the new generation must keep serving before the Change concludes.                                                      | 0                                               |

## Observe

`Change.get` returns current facts. `Change.changes` publishes sequenced
snapshots. Reconcile sequence gaps with `get`; a slow subscriber does not block
coordination. A handle retains its immutable conclusion even after bounded
unkeyed history expires.

See [Units](../units/) for inspection, capacity and native exit evidence.

## Outcomes

| Outcome          | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `Accepted`       | Target passes trial and required retirement evidence settles.      |
| `Aborted`        | Failure leaves the old healthy, authorized generation unchanged.   |
| `Recovered`      | Fresh exclusive recovery passes its full trial.                    |
| `RecoveryFailed` | Recovery fails and all required exits are known.                   |
| `Stuck`          | Required execution evidence is missing; ownership remains visible. |

## Limits

Budgets are milliseconds and cover the whole submission. Request keys retain
their identity for the runtime lifetime; another normalized request under the
same key is rejected. Unknown cleanup after forced exit does not establish
successful finalizers. Missing exit evidence retains unit capacity and
reservations. Unrelated instances may progress within capacity.

## Embedded lifecycle

Code changes in embedded mode require a process restart. Embedded restarts and
in-place updates do not provide kernel Change outcomes or native termination
guarantees.
