# Troubleshooting

Start from the mount's state: `mount.state`, the `Graft.mounts` tree, or the
`Graft.logs` stream, where entries name each mount.

## By state

| State             | Meaning                                         | Look at                                                                                     |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Loading`         | Building the layer                              | A build that never returns: long-running work belongs in `Graft.fork`, not the layer        |
| `Pending`         | Required services missing; `missing` lists them | Is a provider mounted, `Active`, and in the same [realm](isolation.md)? Does the key match? |
| `Failed`          | `cause` holds the full `Cause`                  | The logged cause; then fix the requirement, the published value or the code                 |
| `Active` but idle | Running, yet nothing happens                    | A task started with `Effect.forkScoped` or a raw timer instead of `Graft.fork`              |

A failed mount rebuilds when a requirement changes or when its `retry` schedule
fires.

## By symptom

| Symptom                                         | Likely cause                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Type error reading a service                    | The key is not in the mount's `requires`, or the layer's `RIn` is uncovered                   |
| Consumer rebuilds whenever something else loads | It requires an optional key, or falls back to an environment service a provider later shadows |
| A service read through `Graft.await` is stale   | `await` does not hold the value; use `Graft.use` or `whileAvailable`                          |
| `ServiceWithdrawn` from `Graft.use`             | The provider was torn down mid-call; retry at a higher level or require the key in the layer  |
| Change via `set` has no effect                  | Nothing requires that key in the same realm, or the consumer is outside the mount             |
| Shutdown hangs                                  | This mount is `Active` while a child is unmounting; check for a dependency cycle              |
| Two copies of Effect or Graft                   | A package lists them as `dependencies` instead of `peerDependencies`                          |
| Remote service stays `Pending`                  | The contract keys differ, or the remote side does not currently provide the service           |

## Errors

| Error                                                  | Raised when                                     | Fix                                                            |
| ------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------- |
| `Graft.ServiceConflict`                                | Another provider publishes the key in the realm | Unmount the other provider, isolate one, or rename one key     |
| `ServiceConflict` `SelfDependency` / `DependencyCycle` | Publishing would rebuild the publisher          | Publish under a key the provider does not itself require       |
| `Graft.ServiceWithdrawn`                               | A service was withdrawn while `use` held it     | Retry, or require the key in the surrounding layer             |
| `Mount.CleanupError`                                   | A mount's cleanup failed                        | Read `cause`: the original failures are preserved              |
| `Release.ReleaseInterrupted`                           | A scope release was interrupted, not cancelled  | Read `cause`; ensure finalizers are bounded                    |
| `RemoteUnavailable`                                    | A call failed because the connection broke      | Let it fail; the connection reconnects on its `retry` schedule |
| `RemoteUnavailable` while `Pending`                    | The remote side withdrew the service            | Make the remote side available; the client follows `Presence`  |

The full list is on the docs errors page:
`https://graftland.github.io/graft/errors/`.
