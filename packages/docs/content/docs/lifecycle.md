---
title: Lifecycle
description:
  The states of a mount, who owns it, and the order in which it is torn down.
---

A mount is not a one-time build. It is built, torn down and built again as the
graph changes, always in a fixed order.

## Mount states

| State       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `Loading`   | Building the layer, or publishing a value.                           |
| `Pending`   | Waiting for required services. `missing` lists their keys.           |
| `Active`    | Built and serving; its services are published.                       |
| `Failed`    | The build, a background fiber or cleanup failed. `cause` has it all. |
| `Unmounted` | Removed. This is the last state.                                     |

A mount moves between states on its own:

| From      | To          | When                                                   |
| --------- | ----------- | ------------------------------------------------------ |
| `Pending` | `Loading`   | Its required services appear.                          |
| `Active`  | `Loading`   | A requirement or a publication it uses changes.        |
| `Failed`  | `Loading`   | Its spec or dependencies change, or its `retry` fires. |
| Any       | `Unmounted` | Its scope closes or `unmount` runs.                    |

## Ownership

A mount belongs to the scope where it was created.

- Closing that scope unmounts it.
- A mount created inside a layer is a child of that mount, and stops when the
  parent stops or restarts.
- A background fiber from `Graft.fork` belongs to the mount; a fiber from
  `Effect.forkScoped` belongs to the scope that owns it.

`Graft.layer` itself closes with the runtime. Closing it unmounts everything in
the graph.

## Teardown order

When a mount is torn down, by a change, a failure, `restart` or `unmount`:

1. **Stop the build** if it is still running.
2. **Withdraw its services** in one transaction, and close the mount to further
   publishing, so no new consumer can lease them.
3. **Drain consumers.** Wait until every consumer releases its lease, then let
   each one restart according to its dependencies.
4. **Stop the background fibers** and close their scopes, waiting for cleanup.
5. **Close the mount's scope**, which stops child mounts and runs finalizers.
6. **Release the mount's own leases** on the services it required.

| Consumer's situation             | After the restart                |
| -------------------------------- | -------------------------------- |
| An environment fallback exists   | It uses the fallback.            |
| Required dependency, no fallback | It becomes `Pending`.            |
| Optional dependency, no fallback | It rebuilds without the service. |

Healthy background fibers and their resources stay available to consumer
finalizers during step 3. If draining takes more than 10 seconds, Graft logs a
warning: two mounts may be waiting for each other.

A failure during teardown joins the mount's `Failed` cause. `unmount` reports it
as `Mount.CleanupError`; its `cause` keeps the original reasons.

## Restart and unmount

| Call      | Effect                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `await`   | Waits until stable (not `Loading`); `Pending` counts as stable; `Failed` fails with its cause, even with a `retry`. |
| `restart` | Tears down and builds again, even when nothing changed. Waits until the rebuild starts.                             |
| `unmount` | Tears the mount down and removes it, along with everything below it.                                                |
| `stable`  | Waits until the mount and its descendants have no `Loading` state.                                                  |

Concurrent and repeated `unmount` calls share the same cleanup result.

### Unmount while the mount is loading

Unmounting a mount that is still `Loading` cancels the build and succeeds.
`unmount` fails with `Mount.CleanupError` only when a finalizer of a resource
already acquired by the build interrupts itself or fails. That failure is never
reported as `Release.ReleaseInterrupted`.

| Finalizer during the build | `unmount` cause                                    | Log                                                  |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Interrupts itself only     | Interruption reasons only                          | None.                                                |
| Dies or fails              | The defect or failure, plus an interruption reason | One error, `Releasing the mount's resources failed`. |

A mount that has finished loading keeps the behavior described above.

## A rebuild is a new activation

Each build is independent:

- Its finalizers run in its own scope.
- Its background fibers are new; none survives a rebuild.
- Its services are new values, even if the layer is the same.

Anything that must survive a rebuild belongs in the environment where
`Graft.layer` is built, or in a parent mount that is not rebuilt.

## Services from the environment

Services in the environment where `Graft.layer` is built satisfy `requires`
without a publication. They live as long as that environment, not as long as a
mount. Use the environment for connections, file systems and settings that last
for the whole program.
