---
title: Fork handle
description: The members of a fork, and how update, restart and dispose behave.
---

`Graft.plugin` returns a fork handle. This page is the reference for its
members. For states, see [Lifecycle](../lifecycle/).

`generations` streams execution generations for managed forks; unmanaged forks
report an empty list. `update` and `restart` fail with `ManagedFork` before
changing a managed fork or its ancestor. See
[Execution transitions](../transitions/).

## Members

| Member          | What it does                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | A number that identifies the fork in the tree and in logs.                                                                                       |
| `state`         | A stream of the current state and every change, ending with `Disposed`.                                                                          |
| `await`         | Waits until the fork is no longer `Loading`. Fails with the plugin's error if it ended up `Failed`.                                              |
| `stable`        | Waits until this fork and its descendants have no `Loading` states. `Pending` and `Failed` count as settled; it does not fail on a failed child. |
| `update(input)` | Gives the fork a new input. The plugin [updates in place](../plugins/#update-in-place) or restarts.                                              |
| `restart`       | Restarts the plugin with the same input.                                                                                                         |
| `dispose`       | Unloads the plugin and everything it loaded.                                                                                                     |

## `update` and `restart`

- They return when their request has been handled or superseded by a newer
  request, or when the fork has been disposed.
- The fork keeps only the latest requested configuration. Concurrent updates may
  skip intermediate inputs; a superseded update still succeeds.
- Success is not confirmation of individual configuration delivery, and these
  calls do not wait for a restart to finish.
- To observe the fork's current state, use `await` or `state`. Do not use them
  to acknowledge a superseded input.

## `dispose`

- Concurrent and repeated `dispose` calls share one close operation and its
  complete result. Its type is `Effect<void, Fork.CleanupError>`.
- `CleanupError.cause` keeps the original typed failures, defects and mixed
  interruption reasons from `apply`, interrupted updates, supervised tasks,
  resources and supervisor cleanup. Pure interruption alone is a normal
  shutdown.
- Every cleanup phase still runs, including the release of dependency leases.
- `Failed.cause` includes cleanup failures next to the original activation
  failure. Once that result is published as `Failed`, later disposal of the idle
  fork does not replay it. Recovery starts with a fresh cleanup result.
- The parent scope waits for that same cleanup, so disposing a child first
  cannot release parent resources early. Cancelling a waiter does not cancel the
  cleanup.
- Public disposal completes after the fork detaches from its parent.
- When a scope closes automatically, `CleanupError` is raised as a defect,
  because Effect finalizers have no typed error channel. The original `Cause`
  stays available in the error.
- A handler that requests disposal of its own fork is interrupted by that
  disposal.

## `await`, `stable` and `state`

| You want to wait until…                 | Use                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| The fork is no longer `Loading`         | `await`. It treats `Pending` as settled, because a pending fork may wait forever. |
| The fork is running                     | Watch `state` for `Active`.                                                       |
| The whole subtree has no `Loading` fork | `stable`.                                                                         |
| Loader edits are fully reconciled       | [`loader.ready`](../loader-api/).                                                 |

`fork.stable` has type `Effect<void>`. It reads a subtree counter without
constructing or subscribing to the fork tree, and describes current states, not
queued configuration requests. Configuration coordinators must still check their
request versions and pending refreshes. Observe failures through `state` or
`await`.

A `state` subscription started after disposal still emits `Disposed` and ends.
