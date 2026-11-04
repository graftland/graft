---
title: Restarts, replacements and stopping
description:
  What happens to a remote plugin when you redeploy, when the network drops and
  when it will not stop, and how to fence external side effects.
---

This page is for operating remote plugins. It explains what happens when you
redeploy, when a host or the network disappears, and when a plugin does not stop
in time, and how those cases show up in logs and errors.

## How a remote plugin stops

When a remote entry is unloaded, restarted or replaced, Remote stops its plugin
process in two phases:

1. **Graceful stop.** The plugin is unloaded inside its process, so its
   finalizers run as usual. This phase is bounded by `shutdownTimeout`, five
   seconds by default. Only `Remote.plugin` can change it; a YAML entry always
   uses five seconds.
2. **Making sure the process is gone.** What happens next depends on where the
   plugin runs:

| Runs in          | After the graceful stop                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`          | The process gets one more second to exit on its own. Then it is terminated, and killed with `SIGKILL` one second after that. Remote waits until the exit is confirmed.                                               |
| `worker`         | The worker gets one more second to exit on its own. Then `worker.terminate()` is called, and Remote waits until the thread has exited.                                                                               |
| Through a runner | The runner interrupts the plugin process and kills it if it is still running after `grace` (five seconds by default, set in `runner.yml`). The host waits at most the lease plus `margin` for the runner to confirm. |

For `local` and `worker`, missing the one-second window is reported as a cleanup
error (`LocalTerminationTimeout`), even when the termination that follows
succeeds. It usually means the plugin left a timer, socket or other handle open
after its finalizers ran.

## Redeploying a plugin

A plugin process is replaced when:

- the host reloads or restarts the entry, for example because its `config` or
  `connect` changed;
- the host process itself restarts;
- a new connection for the same identity and instance arrives at the runner.

For a direct `local` or `worker` plugin, every start is simply a fresh process.

Through a runner, replacement is stricter. The runner **confirms that the old
process has exited before it starts the new one**. If it cannot confirm that,
the replacement fails instead of running two copies side by side. This holds
across runner restarts too: the runner's state directory remembers processes
that were still running, and the runner deals with them when it starts again.

To deploy a new version of the plugin package to a runner:

1. Install the new package in the runner's installation directory.
2. Restart the remote entry on the host, or restart the host.

The runner's implementation modules are not part of the host's
[hot reload](../../hot-reload/), so saving them does nothing on the host. If the
**contract** changed, rebuild it and restart the host: contract imports do not
take part in hot reload either.

## Generations: fencing external side effects

Each time the runner starts a plugin for an instance, it gives that start a
**generation**: a number that only grows, and that the runner stores on disk so
it keeps growing after the runner restarts.

You need generations when the plugin writes to something outside itself: a
database, a queue, a lock. During a replacement, a slow old copy might still be
finishing a write when the new copy starts. If the external system remembers the
highest generation it has seen and rejects writes from lower ones, the old copy
cannot overwrite the new one's work. This technique is called **fencing**.

The plugin reads its identity from `Instance`:

```ts
import { Plugin } from "@graftland/graft"
import { Instance } from "@graftland/plugin-remote"
import { Effect } from "effect"

export default Plugin.make({
	name: "ledger",
	inject: [Ledger],
	apply: () =>
		Effect.gen(function* () {
			const { id, generation } = yield* Instance
			const ledger = yield* Ledger
			yield* ledger.claim({ owner: id, generation })
		}),
})
```

| Runs in          | `id`                     | `generation`                 |
| ---------------- | ------------------------ | ---------------------------- |
| Through a runner | The instance name        | Grows with every replacement |
| `local`/`worker` | A fresh UUID every start | Always `1`                   |
| Not remote       | `local`                  | `0`                          |

Generations are a tool, not a guarantee by themselves:

- The external system must check them. Remote does not.
- They do not undo writes that already happened.
- They do not make calls happen exactly once.
- They do not coordinate separate runners. Each runner counts on its own.

## Leases

A runner cannot tell a quiet host from a dead one, so the host holds a
**lease**: a promise, renewed regularly, that it is still there. The lease is 15
seconds by default. The runner sets the default with `lease`, and a host entry
can ask for a different one with `connect.lease`.

- If the host stops renewing (it crashed, or the network is gone), the runner
  stops the plugin process when the lease runs out.
- If the runner itself goes away, its plugin processes notice and shut down too.

Leases have limits worth knowing:

- They are not a hard real-time deadline. If the whole machine is suspended,
  enforcement pauses with it.
- The runner checks a process's identity before signaling it, but there is still
  a narrow window in which a reused process ID could be mistaken for the old
  process.
- Keep a service manager responsible for the runner's descendants, as described
  in [Run plugins on another machine](../runners/#4-start-the-runner).

## When the network drops

When the connection between host and runner breaks:

- Calls in flight fail. Callers see the error their service's `fromClient` maps
  `RpcClientError` to. Calls are not retried, and finalizers that were calling
  the plugin can be interrupted.
- The remote entry on the host fails with a `RemoteError` whose cause holds the
  connection error. It starts again like any failed plugin: when its config or
  dependencies change, or on its `retry` schedule if it was loaded with
  `Remote.plugin`.
- On the runner, the plugin process keeps running until its lease runs out. The
  connection alone does not decide how long it lives.
- When the host connects again, the new connection replaces the old process,
  after confirming that it exited, and the generation goes up.

The runner logs a warning, `Remote host connection failed`, with the cause and
the host's identity. A host that disconnects cleanly produces no warning.

## When a plugin will not stop

For a direct plugin, a slow stop shows up as `LocalTerminationTimeout` (see
[How a remote plugin stops](#how-a-remote-plugin-stops)). Through a runner, each
stop ends in one of three outcomes:

| Outcome                        | Meaning                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Exited`                       | The plugin stopped normally and its process exit was confirmed.                                          |
| `Killed`                       | The process had to be killed; the kill was confirmed. Some finalizers may not have finished.             |
| `RemoteTerminationUnconfirmed` | Nobody could confirm that the process exited: the host lost contact, or the runner could not confirm it. |

The first two appear in the host's `Remote execution terminated` log, annotated
with `remote.termination`, `remote.instance` and `remote.generation`.

`RemoteTerminationUnconfirmed` is a cleanup error: `dispose` fails with a
`Fork.CleanupError`, and you find it in its `cause`. Treat it as "the process
may still be running". Waiting out a timeout does not prove that it exited.
Check the runner's machine. Until the runner can confirm the exit, it refuses to
start a replacement for that instance.

If plugins regularly end up `Killed`, give their finalizers more time with
`shutdownTimeout`, or find what keeps them busy.

## Services while stopping

Remote keeps Graft's usual
[withdrawal order](../../services/#how-withdrawal-works) across the boundary:

- Plugins that use the remote plugin's services stop **before** those services
  are withdrawn, so their finalizers can still call a healthy remote service.
- If a host service in the contract's `inject` is withdrawn, the remote plugin
  stops until it comes back.
- If the remote plugin withdraws a service it provides, the host plugins using
  it stop. Calls made after the withdrawal fail with `RemoteWithdrawn`.
- A broken connection can still interrupt calls and finalizers at any point.

## Logs

Logs from the plugin process are forwarded to the host's logger. Under heavy
load some may be dropped; the host then logs `Remote logs were dropped` with the
number lost.
