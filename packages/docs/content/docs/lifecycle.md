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
unloaded. Inside `apply`, the current scope is the plugin's own, so plugins
loaded there are its children. They stop when the parent stops or restarts. Like
everything else in the parent's scope, they are released in reverse order: a
child loaded after the parent opened a resource stops before that resource is
closed. A child that uses a service of its parent through `inject` always stops
first, whatever the order, as described in
[How withdrawal works](../services/#how-withdrawal-works).

The second argument is the plugin's input, which its config schema decodes. A
plugin without config takes no input. The third argument has the
[`isolate` and `intercept`](../isolation/) options.

## Fork states

A fork is always in one of these states:

| State      | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| `Loading`  | Decoding its config or running `apply`.                    |
| `Pending`  | Waiting for required services. `missing` lists their keys. |
| `Active`   | `apply` finished. The plugin is running.                   |
| `Failed`   | `apply` or decoding failed. `cause` has the full `Cause`.  |
| `Disposed` | Unloaded. This is the last state.                          |

A fork moves between these states on its own. A `Pending` fork starts when its
services appear. An `Active` fork goes back to `Pending` when a service it needs
goes away. A `Failed` fork tries again when its config or its dependencies
change, or when its `retry` schedule fires.

## The fork handle

| Member          | What it does                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `id`            | A number that identifies the fork in the tree and in logs.                                          |
| `state`         | A stream of the current state and every change, ending with `Disposed`.                             |
| `await`         | Waits until the fork is no longer `Loading`. Fails with the plugin's error if it ended up `Failed`. |
| `update(input)` | Gives the fork a new input. The plugin [updates in place](../plugins/#update-in-place) or restarts. |
| `restart`       | Restarts the plugin with the same input.                                                            |
| `dispose`       | Unloads the plugin and everything it loaded.                                                        |

`update` and `restart` return once the fork has acted on the change: it has
either updated in place, or started restarting. They do not wait for the restart
to finish; use `await` or `state` for that.

`await` treats `Pending` as settled, because a pending fork may wait forever. To
wait for a fork to be running, watch `state` for `Active`.

## Replace plugins

`Graft.replace` swaps plugins for new versions. Every fork of an old plugin
restarts with its replacement, and loading the old plugin later loads the new
one:

```ts
const upgrade = Graft.replace([[greeterV1, greeterV2]])
```

All pairs are applied in one transaction, so no fork sees half of a replacement.
Each affected fork then stops and starts as usual, following the
[withdrawal order](../services/#how-withdrawal-works).
[Hot reload](../hot-reload/) uses `replace`.

## Observe the application

`Graft.forks` is a stream of the whole fork tree, emitted again on every change.
Each node has the fork's `id`, `name`, `input`, `state` and `children`:

```ts
const inspector = Plugin.make({
	name: "inspector",
	apply: () =>
		Graft.forks.pipe(
			Stream.runForEach((trees) => Effect.log(trees)),
			Effect.forkScoped,
			Effect.asVoid,
		),
})
```

`Graft.logs` is a stream of log entries from every plugin. A new subscriber
first receives the last 1000 entries. Each entry has the `graft.fork` and
`graft.plugin` annotations, so you can tell which plugin wrote it.
