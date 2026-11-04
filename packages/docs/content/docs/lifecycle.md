---
title: Lifecycle
description: Load plugins, follow their state, and change them while they run.
---

## Load a plugin

`Graft.plugin` loads a plugin and returns its fork (see the
[fork handle](../fork-handle/)):

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

| Argument | What it is                                                                       |
| -------- | -------------------------------------------------------------------------------- |
| 1st      | The plugin.                                                                      |
| 2nd      | The plugin's input, decoded by its config schema. Omit it if there is no config. |
| 3rd      | Options: [`isolate` and `intercept`](../isolation/).                             |

### Ownership and stop order

The fork belongs to the current `Scope`. When that scope closes, the fork is
unloaded. Inside `apply`, the current scope is the plugin's own, so plugins
loaded there are its children.

- Children stop when the parent stops or restarts.
- Like everything else in the parent's scope, they are released in reverse
  order. A child loaded after the parent opened a resource stops before that
  resource closes.
- A child that uses a service of its parent through `inject` always stops first,
  in any order. See [How withdrawal works](../services/#how-withdrawal-works).

## Fork states

A fork is always in one of these states:

| State      | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| `Loading`  | Decoding its config or running `apply`.                    |
| `Pending`  | Waiting for required services. `missing` lists their keys. |
| `Active`   | `apply` finished. The plugin is running.                   |
| `Failed`   | Startup or execution failed. `cause` has the full `Cause`. |
| `Disposed` | Unloaded. This is the last state.                          |

A fork moves between states on its own:

| From      | To         | When                                                              |
| --------- | ---------- | ----------------------------------------------------------------- |
| `Pending` | `Loading`  | Its required services appear.                                     |
| `Active`  | `Pending`  | A service it needs goes away.                                     |
| `Failed`  | `Loading`  | Its config or dependencies change, or its `retry` schedule fires. |
| Any       | `Disposed` | The fork is disposed, or its parent scope closes.                 |

### Failures and retries

| Source of failure                            | Result                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apply`                                      | `Failed`, then the normal `retry` path.                                                           |
| A `Plugin.fork` task (not pure interruption) | The same as `apply`. The full `Cause` is kept after sibling tasks are cancelled and cleaned up.   |
| Building or running an intercept             | `Failed` with the full `Cause`, and `await` finishes. The `retry` schedule does **not** retry it. |
| A bare `Effect.forkScoped`                   | Not reported to the supervisor.                                                                   |

For an intercept failure, the fork waits for a config update, a replacement, or
an explicit `restart`. The failure belongs to the spec that the supervisor was
processing at that time, including an in-place update. An update that was
already processed does not trigger another try, and new requests that arrive
during cleanup stay pending.

How retry interacts with changes:

- Retry driver initialization and each step run under the same change
  supervision.
- A config or dependency change cancels the obsolete operation and waits for its
  cleanup before starting another attempt.
- An unchanged spec and dependency resolution retain their `Schedule` state and
  retry budget.
- Schedule failures, including cleanup failures caused by a change, join the
  activation's `Failed` `Cause`. New failures while disposal cancels a retry
  belong to `CleanupError.cause` instead; previously published startup failures
  are not replayed.

### Teardown order

1. Stop `apply`.
2. Close publication and withdraw services.
3. Drain all consumers. Healthy tasks stay available to consumer finalizers,
   even when a failure in another task started the teardown.
4. Stop the remaining tasks and close their scopes.
5. Close the activation scope.
6. Release the plugin's own dependency leases.

Failures during draining keep their complete `Cause`, and Graft logs them. If a
failure started the teardown, they are added to the final `Failed` state.

## Observe the application

### Fork tree

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

### Logs

`Graft.logs` collects logs from the environment that uses `Graft.layer`,
including logs from the host application.

- A new subscriber first receives the last 1000 entries.
- Logs emitted while a plugin runs carry the `graft.fork` and `graft.plugin`
  annotations.
- Host logs keep their own annotations. Graft does not invent a plugin identity
  for them, so readers of logs must allow these annotations to be missing.

## Related

| Page                           | Covers                                                |
| ------------------------------ | ----------------------------------------------------- |
| [Fork handle](../fork-handle/) | `await`, `stable`, `update`, `restart`, `dispose`.    |
| [Replace plugins](../replace/) | Swapping plugins for new versions in one transaction. |
| [Errors](../errors/)           | Every named error and what to do about it.            |
