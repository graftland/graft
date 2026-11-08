# Troubleshooting

Start from the fork's state: `fork.state`, the `Graft.forks` tree, or the
`graft start` logs, which name each fork.

## By state

| State             | Meaning                                         | Look at                                                                                                                         |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Loading`         | Decoding config, importing, or in `apply`       | An `apply` that never returns: long-running work belongs in `Plugin.fork`                                                       |
| `Pending`         | Required services missing; `missing` lists them | Is a provider loaded, `Active`, and in the same realm? Does the key string match exactly?                                       |
| `Failed`          | `cause` holds the full `Cause`                  | The logged cause; then fix the config, the dependency, or the code                                                              |
| `Active` but idle | Running, yet nothing happens                    | A task started with `Effect.forkScoped` or a raw timer instead of `Plugin.fork`, or a handler registered in a scope that closed |

A failed fork tries again when its config or dependencies change, when its
`retry` schedule fires, or when a Change redeploys its entry
(`graft start --watch` submits one per save). Under `graft start`, the
supervisor also restarts a failed entry within its restart intensity (by default
three attempts per 60 seconds), then leaves it failed until a Change for it is
accepted.

## By symptom

| Symptom                                         | Likely cause                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Type error reading a service                    | The key is not in `inject`                                                                        |
| Consumer restarts whenever something else loads | It sits on an environment fallback or an optional dependency, and a provider appears in its realm |
| Handler never called                            | The dispatcher is in another realm, a filter excludes it, or its plugin stopped                   |
| Handler sees the wrong service or setting       | Handlers use their own plugin's context, not the dispatcher's; pass data as event arguments       |
| Entry rejected with `DeploymentUnsupported`     | It uses `inject`, `isolate` or `intercept`, which `graft start` rejects; embed the loader instead |
| A save under `--watch` changes nothing          | The Change failed: read the logged cause. Running entries stay as they were                       |
| Edits to a module have no effect                | The built JavaScript was not rebuilt, the edit is in `node_modules`, or `--watch` is off          |
| Editing one plugin redeploys others             | They share its package: a module's artifact is its whole package                                  |
| Shutdown warns about a 10-second drain          | Two plugins wait for each other; look for a cycle through services or events                      |
| Two copies of Effect or Graft                   | A plugin package lists them as `dependencies` instead of `peerDependencies`                       |
| Remote plugin ignores code edits                | Capture the rebuilt bytes and submit a public Change with the new unit target                     |

## Errors

| Error                                                  | Raised when                                           | Fix                                                              |
| ------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `SchemaError`                                          | The input does not decode                             | Fix the input; the fork stays `Failed` until it changes          |
| `ServiceConflict`                                      | Another fork publishes the key in the realm           | Unload the other provider, or isolate one of them                |
| `ServiceConflict` `SelfDependency` / `DependencyCycle` | Publishing would restart the publisher                | Publish under a separate key from the one injected               |
| `Fork.CleanupError`                                    | Cleanup failed on `dispose` or scope close            | Read `cause`: the original failures are kept                     |
| `UnregisteredReference`                                | A `graft.yml` intercept key is not registered         | Register it with `Intercept.make` in the host                    |
| `InvalidIntercept`                                     | An intercept value fails its schema                   | Fix the value                                                    |
| `CyclicConfig` / `InvalidOperation`                    | A cycle in a config value / in the entry tree         | Remove the cycle                                                 |
| `StoreError`                                           | Saving a loader edit failed; the file is unchanged    | Read the cause; the file may have changed concurrently           |
| `ModuleNotFound` / `ModuleInvalid`                     | An entry's `name` did not resolve / exports no plugin | Fix the name or the module's default (or `plugin`) export        |
| `DeploymentUnsupported`                                | `graft start` met `inject`, `isolate` or `intercept`  | Drop the field, or embed the loader                              |
| `DeploymentFailed`                                     | A Change from `graft start` did not conclude Accepted | Read `outcome` and `cause`; running entries stay as they were    |
| `Contract.UndeclaredFailure`                           | A remote plugin failed with an undeclared error       | Declare it in the contract's `error`, or handle it in the plugin |

The full list is on the docs errors page:
`https://graftland.github.io/graft/errors/`.
