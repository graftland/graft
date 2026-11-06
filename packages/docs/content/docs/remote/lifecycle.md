---
title: Replacement and stopping
description: How a remote plugin stops, is replaced, and survives network loss.
---

A remote plugin's process follows its entry: unloading the entry stops it, and
restarting the entry replaces it. Through a runner, a replacement starts only
after the old process is confirmed to have exited, and each start gets a larger
generation.

## Stopping

When a remote entry stops, Remote follows this order:

1. **Stop consumers.** Host plugins that use the plugin's services stop first,
   while those services still work.
2. **Stop gracefully.** The plugin is unloaded inside its process and its
   finalizers run, bounded by `shutdownTimeout`.
3. **Make sure the process is gone**, depending on where it runs:

| Runs in  | After the graceful stop                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `local`  | One second to exit, then it is terminated, then `SIGKILL` one second later. Remote waits until the exit is confirmed.          |
| `worker` | One second to exit, then `worker.terminate()`. Remote waits until the thread has exited.                                       |
| Runner   | The runner interrupts the process and kills it after `grace`. The host waits at most the lease plus `margin` for confirmation. |

A `local` child or worker that misses its one-second window is reported as
`LocalTerminationTimeout` in the `cause` of `Fork.CleanupError`, even when the
termination succeeds. It usually means a timer, socket or other handle stayed
open after the finalizers ran.

## Generations and fencing

The runner gives each start of an instance a **generation**, a number it stores
on disk so it only grows. A plugin reads its own from `Instance`:

```ts import.meta.vitest name="remote/lifecycle: read the instance"
import { Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Instance } from "@graftland/plugin-remote"

const claimed = Ref.makeUnsafe({ owner: "", generation: -1 })
const ledger = {
	claim: (claim: { owner: string; generation: number }) =>
		Ref.set(claimed, claim),
}

const writer = Plugin.make({
	name: "app/writer",
	apply: () =>
		Effect.gen(function* () {
			const { id, generation } = yield* Instance
			yield* ledger.claim({ owner: id, generation })
		}),
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(writer)
		yield* fork.await
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

await Effect.runPromise(Ref.get(claimed)) // => { owner: "local", generation: 0 }
```

Loaded without Remote, as here, it gets `local` and `0`:

| Runs in          | `id`                     | `generation`                 |
| ---------------- | ------------------------ | ---------------------------- |
| Through a runner | The instance name        | Grows with every replacement |
| `local`/`worker` | A fresh UUID every start | Always `1`                   |
| Not remote       | `local`                  | `0`                          |

Use it for **fencing**: an external system that remembers the highest generation
it has seen and rejects writes from lower ones keeps a slow old copy from
overwriting a new one.

- The external system must check generations. Remote does not.
- They do not undo writes or make calls happen exactly once.
- Each runner counts on its own; separate runners are not coordinated.
- After a runner restart, its state directory records processes that were still
  running, and the runner deals with them before replacing them.

## Leases and network loss

A host holds a renewed **lease** on its plugin process. When the host stops
renewing, because it crashed or the network is gone, the runner stops the
process when the lease runs out. When the runner goes away, its plugin processes
shut down too.

When the connection breaks:

- Calls in flight fail with the error `fromClient` maps `RpcClientError` to.
  They are not retried, and finalizers calling the plugin can be interrupted.
- The host entry fails with a `RemoteError` holding the connection error. It
  starts again when its config or dependencies change, or on its `retry`
  schedule from `Remote.plugin`.
- The plugin process keeps running until its lease runs out.
- The next connection replaces it, after confirming its exit, with a larger
  generation.

Leases are not hard real-time: a suspended machine pauses enforcement, and
despite identity checks a reused process ID can briefly pass for the old
process. Keep a [service manager](../runners/#set-up-a-runner) in charge.

## Outcomes

| Outcome                        | Meaning                                                                                   | Reported as                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `Exited`                       | The plugin stopped and its exit was confirmed.                                            | `remote.termination` in the host's log.        |
| `Killed`                       | The process was killed, and the kill confirmed. Some finalizers may not have finished.    | `remote.termination` in the host's log.        |
| `RemoteTerminationUnconfirmed` | No one could confirm the exit: the host lost contact, or the runner could not confirm it. | The `cause` of `Fork.CleanupError` on dispose. |

The info log `Remote execution terminated` also carries `remote.instance` and
`remote.generation`. `RemoteTerminationUnconfirmed` means "may still be
running": waiting proves nothing, so check the runner machine, which refuses a
replacement until it confirms the exit. If plugins often end `Killed`, raise
`shutdownTimeout` or find what keeps them busy.

## Timeouts and defaults

| What                               | Default                  | Set with                                            |
| ---------------------------------- | ------------------------ | --------------------------------------------------- |
| Graceful stop                      | 5 seconds                | `shutdownTimeout` in `Remote.plugin`; fixed in YAML |
| `local`/`worker` exit window       | 1 second                 | Fixed                                               |
| `local`: terminate, then `SIGKILL` | 1 second later           | Fixed                                               |
| Lease                              | 15 seconds               | Runner `lease`, or host `connect.lease`             |
| Lease renewal                      | Every third of the lease | Fixed                                               |
| Interrupt to kill on the runner    | 5 seconds                | Runner `grace`                                      |
| Host wait for exit confirmation    | Lease + 5 seconds        | Host `connect.margin`                               |

Durations are strings such as `30 seconds` or `500 millis`. `lease`, `grace` and
`margin` must be finite and positive.
