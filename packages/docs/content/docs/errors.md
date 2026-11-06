---
title: Errors
description:
  Every named error and failure state in Graft, and what to do about it.
---

Graft keeps the full `Cause` of every failure and logs it. This page lists the
errors you may meet, grouped by where they come from. To start from a fork's
state or a symptom instead of an error name, see
[Troubleshooting](../best-practices/troubleshooting/).

## Fork failures

| Name                | Raised when                                                   | What to do                                                                                  |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SchemaError`       | A plugin's config fails to decode.                            | Fix the input. The fork is `Failed` until its config changes.                               |
| `Fork.CleanupError` | `dispose` or an automatic scope close hits cleanup failures.  | Read `cause`: it keeps the original failures, defects and mixed interruptions.              |
| Task failure        | A `Plugin.fork` task fails with an unhandled error or defect. | Catch recoverable errors **inside** the task. See [Plugins](../plugins/#when-a-task-fails). |

## Services

`ServiceConflict` is raised by `Graft.provide`. Its `reason` says why:

| `reason`          | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| _(none)_          | Another fork already publishes this key in the same realm. |
| `SelfDependency`  | The publication would restart its own provider, directly.  |
| `DependencyCycle` | The same, through a chain of other forks.                  |
| `Invalidated`     | A dependency change already invalidated the provider.      |

The error also carries the publisher's `fork` ID and the service's `realm`. See
[Publication cycles](../services/#publication-cycles).

## Replacement

| Name                        | Raised when                                               | What to do                                                                  |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Graft.ReplacementConflict` | A batch of replacements cannot be represented by aliases. | Check the pairs named by `indices`. See [Conflicts](../replace/#conflicts). |

## Intercepts

| Name                    | Raised when                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| `UnregisteredReference` | A config-file `intercept` key is not registered.                    |
| `InvalidIntercept`      | The value fails the registered schema. `cause` is the schema error. |

In both cases the entry's plugin does not start. See
[Config-file intercepts](../intercepts/#config-file-intercepts).

## Loader and config file

| Name               | Raised when                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `CyclicConfig`     | An entry's config or intercept contains a cycle. Only that entry fails.                              |
| `InvalidOperation` | The entry/group structure itself contains a cycle.                                                   |
| `StoreError`       | Parsing, serialization or the conflict check fails while saving an edit. The file is left unchanged. |
| `LoaderClosed`     | An edit is submitted after the loader closed.                                                        |

See [Loader API](../loader-api/).

## Hot reload

| Name / result                   | Meaning                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `HmrError`                      | A module did not import, or did not export a plugin. `cause` is the original error.                              |
| `Skipped` / `restart-required`  | A native-loading capability or a symlink target change needs a restart.                                          |
| `Skipped` / `ambiguous-exports` | Entries that shared a Plugin object now export different ones.                                                   |
| `Skipped` / `identity-conflict` | The replacement identities do not fit the runtime's aliases.                                                     |
| `RolledBack`                    | A reloaded plugin failed to start or timed out. The old plugins run again; a `Failed` failure keeps its `Cause`. |
| `Failed`                        | A reload failed. The value holds the full `Cause`; old plugins keep running.                                     |

See [Hot reload](../hot-reload/#when-a-reload-does-not-apply).

## Remote

A plugin run through [Remote](../remote/overview/) fails with these, from
`@graftland/plugin-remote`:

| Name                         | Raised when                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| A declared error             | The plugin failed with an error its contract declares in `error`.                                     |
| `Contract.UndeclaredFailure` | The plugin failed with an error the contract does not declare.                                        |
| `RemoteError`                | Remote itself failed: the process exited, the connection broke, a runner refused. `cause` says which. |
| `RemoteWithdrawn`            | The plugin's services were withdrawn while a caller was using them.                                   |
| `RemoteEntryError`           | A `remote` or `remote/runner` entry in `graft.yml` is invalid. `field` names the field.               |

Defects stay defects. See [Remote errors](../remote/hosts/#errors-callers-see)
for everything `RemoteError` may contain and what to do about it.
