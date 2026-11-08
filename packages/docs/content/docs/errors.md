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

## Remote

A unit contract preserves its declared business errors across the encoded
channel. Handle transport failures through RpcClientError in the contract's
fromClient mapping.

[Call completion](../calls/) and [native exit evidence](../units/) are separate
from the business result. Public Change status and outcomes retain their causes.
