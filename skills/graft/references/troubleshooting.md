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
`retry` schedule fires, or, under `graft start --watch`, after a hot reload.

## By symptom

| Symptom                                         | Likely cause                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Type error reading a service                    | The key is not in `inject`                                                                        |
| Consumer restarts whenever something else loads | It sits on an environment fallback or an optional dependency, and a provider appears in its realm |
| Handler never called                            | The dispatcher is in another realm, a filter excludes it, or its plugin stopped                   |
| Handler sees the wrong service or setting       | Handlers use their own plugin's context, not the dispatcher's; pass data as event arguments       |
| Hot reload reports `Restart required`           | CommonJS, native code or `createRequire` reachable from the module                                |
| Edits to a module have no effect                | The module has import side effects, or it lives in `node_modules`                                 |
| Shutdown warns about a 10-second drain          | Two plugins wait for each other; look for a cycle through services or events                      |
| Two copies of Effect or Graft                   | A plugin package lists them as `dependencies` instead of `peerDependencies`                       |
| Remote plugin ignores code edits                | Contract and implementation modules are not hot-replaced; rebuild, then restart the entry or host |

## Errors

| Error                                                  | Raised when                                            | Fix                                                                |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `SchemaError`                                          | The input does not decode                              | Fix the input; the fork stays `Failed` until it changes            |
| `ServiceConflict`                                      | Another fork publishes the key in the realm            | Unload the other provider, isolate one of them, or `Graft.replace` |
| `ServiceConflict` `SelfDependency` / `DependencyCycle` | Publishing would restart the publisher                 | Publish under a separate key from the one injected                 |
| `Fork.CleanupError`                                    | Cleanup failed on `dispose` or scope close             | Read `cause`: the original failures are kept                       |
| `Graft.ReplacementConflict`                            | Replacement pairs conflict                             | Check the pairs named by `indices`                                 |
| `UnregisteredReference`                                | A `graft.yml` intercept key is not registered          | Register it with `Intercept.make` in the host                      |
| `InvalidIntercept`                                     | An intercept value fails its schema                    | Fix the value                                                      |
| `CyclicConfig` / `InvalidOperation`                    | A cycle in a config value / in the entry tree          | Remove the cycle                                                   |
| `StoreError`                                           | Saving a loader edit failed; the file is unchanged     | Read the cause; the file may have changed concurrently             |
| `HmrError`                                             | A module failed to import or exported no plugin        | Fix the module; the old version keeps running                      |
| `RemoteError`                                          | A remote plugin's process, connection or runner failed | Read `cause`; see [remote](remote.md)                              |
| `Contract.UndeclaredFailure`                           | A remote plugin failed with an undeclared error        | Declare it in the contract's `error`, or handle it in the plugin   |
| `RemoteEntryError`                                     | A `remote` or `remote/runner` entry is invalid         | Fix the field named by `field`                                     |

The full list is on the docs errors page: `https://docs.graft.land/errors/`.
