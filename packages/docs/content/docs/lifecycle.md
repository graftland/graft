---
title: Lifecycle
description: Load plugins, follow their state, and change them while they run.
---

## Load a plugin

`Graft.plugin` loads a plugin and returns its fork:

```ts
const app = Plugin.make({
	name: "app",
	apply: () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
			yield* fork.await
		}),
})
```

The fork belongs to the current `Scope`. When that scope closes, the fork is
unloaded. Inside `apply`, the current scope is the plugin's own. So plugins
loaded there are its children. They stop when the parent stops or restarts. Like
everything else in the parent's scope, they are released in reverse order. A
child loaded after the parent opened a resource stops before that resource
closes. A child that uses a service of its parent through `inject` always stops
first, in any order. See
[How withdrawal works](../services/#how-withdrawal-works).

The second argument is the plugin's input. The plugin's config schema decodes
it. A plugin without config takes no input. The third argument holds the
[`isolate` and `intercept`](../isolation/) options.

## Fork states

A fork is always in one of these states:

| State      | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| `Loading`  | Decoding its config or running `apply`.                    |
| `Pending`  | Waiting for required services. `missing` lists their keys. |
| `Active`   | `apply` finished. The plugin is running.                   |
| `Failed`   | Startup or execution failed. `cause` has the full `Cause`. |
| `Disposed` | Unloaded. This is the last state.                          |

A fork moves between these states on its own. A `Pending` fork starts when its
services appear. An `Active` fork goes back to `Pending` when a service it needs
goes away. A `Failed` fork tries again when its config or its dependencies
change, or when its `retry` schedule fires.

Retry driver initialization and each step run under the same change supervision.
A config or dependency change cancels the obsolete operation and waits for its
cleanup before starting another attempt. An unchanged spec and dependency
resolution retain their Schedule state and retry budget. Schedule failures,
including cleanup failures caused by a change, join the activation's `Failed`
Cause. New failures while disposal cancels a retry instead belong to
`CleanupError.cause`; previously published startup failures are not replayed.

A failure while building or running an intercept also puts the fork in `Failed`.
Graft keeps the full Cause, and `await` finishes. The retry schedule does not
retry these failures. The fork waits for a config update, a replacement, or an
explicit `restart`. The failure belongs to the spec that the supervisor was
processing at that time. This includes an in-place update. An update that was
already processed does not trigger another try. New requests that arrive during
cleanup stay pending.

Background work started with `Plugin.fork` belongs to the activation. A failure
that is not pure interruption follows the same `Failed` and retry path as a
failure in `apply`. The full Cause is kept after the sibling tasks are cancelled
and cleaned up.

Teardown goes in this order. It stops `apply`. It closes publication and
withdraws services. It drains all consumers. Then it stops the remaining tasks
and closes their scopes. Only then does it close the activation scope and
release the plugin's own dependency leases. Healthy tasks stay available to
consumer finalizers during draining. This is true even when a failure in another
task started the teardown. Failures during draining also keep their complete
Cause, and Graft logs them. If a failure started the teardown, they are added to
the final `Failed` state. A bare `Effect.forkScoped` does not send background
failures to this supervisor.

## The fork handle

| Member          | What it does                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `id`            | A number that identifies the fork in the tree and in logs.                                          |
| `state`         | A stream of the current state and every change, ending with `Disposed`.                             |
| `await`         | Waits until the fork is no longer `Loading`. Fails with the plugin's error if it ended up `Failed`. |
| `update(input)` | Gives the fork a new input. The plugin [updates in place](../plugins/#update-in-place) or restarts. |
| `restart`       | Restarts the plugin with the same input.                                                            |
| `dispose`       | Unloads the plugin and everything it loaded.                                                        |

`update` and `restart` return when their request has been handled or superseded
by a newer request (or the fork has been disposed). The fork keeps only the
latest requested configuration. Concurrent updates may skip intermediate inputs
entirely; a superseded update succeeds even if its input was never applied and
the latest request is still pending. Success is not confirmation of individual
configuration delivery. These calls do not wait for a restart to finish. Use
`await` or `state` to observe the fork's current state, not to acknowledge a
superseded input.

Concurrent and repeated `dispose` calls share one close operation and its
complete result. Its type is `Effect<void, Fork.CleanupError>`.
`CleanupError.cause` keeps the original typed failures, defects, and mixed
interruption reasons. These come from apply, interrupted updates, supervised
tasks, resources, and supervisor cleanup. Pure interruption alone is a normal
shutdown. Every cleanup phase still runs, including the release of dependency
leases. `Failed.cause` includes cleanup failures next to the original activation
failure. Once that result is published as `Failed`, later disposal of the idle
fork does not replay it. Recovery starts with a fresh cleanup result.

The parent scope waits for that same cleanup, so disposing a child first cannot
release parent resources early. Cancelling a waiter does not cancel the cleanup.
Public disposal completes after the fork detaches from its parent. When a scope
closes automatically, `CleanupError` is raised as a defect, because Effect
finalizers have no typed error channel. The original Cause stays available in
the error. A handler that requests disposal of its own fork is interrupted by
that disposal.

`await` treats `Pending` as settled, because a pending fork may wait forever. To
wait until a fork is running, watch `state` for `Active`.

## Replace plugins

`Graft.replace` swaps plugins for new versions. Every fork of an old plugin
restarts with its replacement. Loading the old plugin later loads the new one:

```ts
const upgrade = Graft.replace([[greeterV1, greeterV2]])
```

TypeScript checks each pair on its own. The target must have exactly the same
input type. Its errors must be a subset of the source's error bound. That bound
includes decoding failures (`SchemaError`), so existing fork handles stay valid
after replacement. A definition's input and error contracts are invariant. You
cannot bypass the check by assigning the same object to a wider error type or a
narrower input type. Declare the error union you need when you create the
plugin, before you load it.

Dynamically loaded modules use `Plugin` with `any` parameters. This boundary
removes the static contracts on purpose, so HMR and loaders can still use it. It
does not check replacement compatibility at run time. Explicit `any` or type
assertions can also bypass the TypeScript guarantees.

A plugin's identity is the reference to its definition object, not its name or
fields. The same object is the same plugin. `{ ...plugin }` creates a different
plugin. Replacing one copy does not replace another copy or the original.
Loading, alias lookup, and conflict checks all follow this rule. This includes
frozen objects and definitions with custom `Equal` or `Hash` implementations.
Graft does not change those implementations on objects that the caller owns.

Graft applies all pairs in one transaction, so no fork sees half of a
replacement. Then each affected fork stops and starts as usual, in the
[withdrawal order](../services/#how-withdrawal-works).
[Hot reload](../hot-reload/) uses `replace`.

Some batches cannot be represented by the runtime's aliases. These fail with
`Graft.ReplacementConflict`. Its `indices` field names the conflicting pairs.
Such batches include different targets for one source, and overlapping changes
such as `P → Q, Q → R`. They also include stale source identities that would
leave existing forks on a different plugin. On failure, the transaction leaves
aliases and forks unchanged. Two cases still work: pointing several sources at
one unchanged target, and rolling back to an older version.

## Observe the application

`Graft.forks` is a stream of the whole fork tree. It emits again on every
change. Each node has the fork's `id`, `name`, `input`, `state` and `children`:

```ts
const inspector = Plugin.make({
	name: "inspector",
	apply: () =>
		Graft.forks.pipe(
			Stream.runForEach((trees) => Effect.log(trees)),
			Plugin.fork,
			Effect.asVoid,
		),
})
```

`Graft.logs` collects logs from the environment that uses `Graft.layer`. This
includes logs from the host application. A new subscriber first receives the
last 1000 entries. Logs emitted while a plugin runs carry the `graft.fork` and
`graft.plugin` annotations. Host logs keep their own annotations. Graft does not
invent a plugin identity for them. So readers of logs must allow these
annotations to be missing.
