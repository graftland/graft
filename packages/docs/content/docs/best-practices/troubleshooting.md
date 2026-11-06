---
title: Troubleshooting
description:
  Find out why a plugin does not start, does nothing, or keeps restarting.
---

Most problems show up in a fork's [state](../../lifecycle/#fork-states) before
they show up anywhere else. Find the fork, read its state, then follow the row
for that state, the log message or the symptom you see.

## Find the fork

Graft logs a plugin's failures with their full `Cause`, annotated with
`graft.plugin` and `graft.fork`. A fork that waits writes no log line: `Pending`
and a long `Loading` show only in the fork tree.

| Where to look                               | What it shows                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `graft start` output                        | Failures with their `Cause`, and the [messages below](#log-messages). Plugin lines name the fork.  |
| [`Graft.forks`](../../lifecycle/#fork-tree) | Every fork's `name`, `id` and `state`, including `missing` for `Pending` and `cause` for `Failed`. |
| `fork.state`                                | One fork you loaded yourself, every change until `Disposed`.                                       |

To log forks that stay `Pending`, add the plugin from
[Diagnose with the fork tree](../observability/#diagnose-with-the-fork-tree).
The
[`http-gateway`](https://github.com/graftland/graft/tree/main/samples/http-gateway)
sample mounts the live tree on the [HTTP server](../../http/) at `GET /_graft`.

## Read the state

| State                     | What to check                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Loading` for long        | `apply` has not returned. Work that runs for the plugin's lifetime, such as `Stream.runForEach`, a server loop or `Effect.never`, belongs in [`Plugin.fork`](../../plugins/#background-tasks). An entry whose module import never finishes also stays `Loading`. |
| `Pending`                 | See [Pending](#pending).                                                                                                                                                                                                                                         |
| `Failed`                  | Read `cause`: find its error tag in [Errors](#errors), fix the input, dependency or code. When the fork tries again is in [Failures and retries](../../lifecycle/#failures-and-retries).                                                                         |
| `Active`, nothing happens | See [Active but idle](#active-but-idle).                                                                                                                                                                                                                         |

### Pending

`missing` lists the key strings of required services that neither the fork's
realm nor the environment provides. Check, in order:

1. **Is a provider loaded?** A provider that is `Failed`, `Pending` or disabled
   publishes nothing. Find it in the tree.
2. **Is it in the same realm?** A provider inside a fork that isolates the key
   publishes only in that realm. See [Realms](../../isolation/#realms).
3. **Do the keys match?** Services match by their key string, such as
   `app/Database`, exactly. An entry's `inject` field in `graft.yml` makes it
   wait for more keys.
4. **Do two plugins wait for each other?** If each injects a service the other
   publishes, both stay `Pending`. Move the shared part into a third plugin that
   both inject.

### Active but idle

| Cause                                                                                                                    | Fix                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Work started with `Effect.forkChild`. It is interrupted when `apply` returns, and interruption does not fail the plugin. | Start it with `Plugin.fork`.                                                                                                                   |
| Work started with `Effect.forkScoped`, a raw timer or a detached promise failed silently.                                | `Plugin.fork` reports the failure: the plugin fails and can [retry](../../plugins/#failures-and-retries). See [Effect in plugins](../effect/). |
| A handler or resource was set up inside `Effect.scoped` or inside an event handler call.                                 | It ended with that scope. Register it in `apply`. See [Handler context](../../events/#handler-context).                                        |
| An optional dependency was absent at start.                                                                              | The plugin runs without it and restarts when it appears. Make it required if the plugin cannot work without it.                                |
| A task catches every error and carries on.                                                                               | Let failures that you cannot handle fail the task. See [Effect in plugins](../effect/).                                                        |

## Log messages

Messages about plugins are listed in
[What Graft logs](../observability/#what-graft-logs). These messages from
`graft start` and the loader point at a problem with code or configuration:

| Message                                              | Meaning                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Restart required…`                                  | A module change cannot be hot reloaded. The old plugins keep running. See [When a reload does not apply](../../hot-reload/#when-a-reload-does-not-apply).                   |
| `Reloading plugin modules failed`                    | The new code did not import or pass its checks. The old plugins keep running; fix the code and save again.                                                                  |
| `Kept the previous code: plugin "<name>" …`          | The replacement failed or timed out; counted restored forks are active or `Pending`. A failure carries its full cause; a timeout has no cause. Fix the code and save again. |
| `Replacement abandoned: plugin "<name>" …`           | `RecoveryFailed`: why the new code was abandoned. Errors carry full causes; timeouts name the plugin.                                                                       |
| `Previous code failed to restart: plugin "<name>" …` | `RecoveryFailed`: the restored plugin also failed. The error carries its full cause. Fix the startup failure and save again.                                                |
| `Waiting for valid configuration in <file>`          | The first `graft.yml` is invalid under `--watch`. See [Invalid first configuration](../../cli/#invalid-first-configuration).                                                |
| `Dropped an edit to "<id>": the file changed it too` | An API edit lost to an edit in the file. See [Conflicts with external edits](../../loader-api/#conflicts-with-external-edits).                                              |

## Symptoms

| Symptom                                                                | Cause and fix                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type error on `yield*` of a service                                    | The key is not in `inject`, or it is listed as `Plugin.optional`: read an optional one with `Effect.serviceOption`. See [Dependencies](../../plugins/#dependencies).                                                                                                                                          |
| Type error that mentions `Tasks`                                       | A helper's annotated type dropped `Plugin.Tasks`. See [Task errors in types](../../plugins/#task-errors-in-types).                                                                                                                                                                                            |
| Defect `Plugin.fork requires a plugin activation`                      | `Plugin.fork` ran outside a plugin, such as in the host program. Call it from a plugin; in the host, own the fiber with a scope.                                                                                                                                                                              |
| `fork.await` or `loader.ready` returned, but the plugin is not running | Both treat `Pending` as settled, and `ready` also counts `Failed` forks as settled. Wait for `Active` on `fork.state`. See [`await`, `stable` and `state`](../../fork-handle/#await-stable-and-state).                                                                                                        |
| A consumer restarts when another plugin loads or reloads               | Its provider restarted, and consumers always restart with it; let the provider [update in place](../../plugins/#update-in-place). Or the consumer uses an optional dependency or an environment fallback, and a provider appeared in its realm: see [Lookup order](../../services/#lookup-order).             |
| A plugin restarts again and again                                      | Each `retry` attempt fails the same way. Read the logged cause; the schedule does not fix a persistent error.                                                                                                                                                                                                 |
| A consumer sees the environment value, not the published one           | The provider publishes in another realm. See [Environment fallback and inheritance](../../isolation/#environment-fallback-and-inheritance).                                                                                                                                                                   |
| A handler is never called                                              | The dispatch runs in another [realm](../../events/#realms-and-filters), a filter excludes it, its key string differs, or its scope has closed. `Event.emit` also stops at the first failure and `Event.bail` at the first `Some`.                                                                             |
| A handler sees the wrong service, setting or log annotations           | Handlers run with their own plugin's context, not the dispatcher's. Pass what they need as event arguments. See [Handler context](../../events/#handler-context).                                                                                                                                             |
| `graft.yml` edit has no effect                                         | `graft start` runs without `--watch`; the file is invalid, and Graft keeps the last valid version ([Invalid files](../../config-file/#invalid-files)); or the update function returns `true` without applying the changed field.                                                                              |
| Changed environment variable has no effect                             | `!env` is read when an entry loads, changes or is refreshed, not when the process environment changes. With `--watch`, saving the `--env-file` file refreshes it. See [When values are read again](../../config-file/#when-values-are-read-again).                                                            |
| Module edit has no effect                                              | `graft start` runs without `--watch`; the file is outside the config directory or in `node_modules`; the entry loads built JavaScript that was not rebuilt; or the reload failed. See [What triggers a reload](../../hot-reload/#what-triggers-a-reload).                                                     |
| Old behavior continues after a reload                                  | A module started a timer or connection on import. Graft cannot stop it. Move it into `apply`. See [Rules for plugin modules](../../hot-reload/#rules-for-plugin-modules).                                                                                                                                     |
| Entry fails with `ConfigError`                                         | An `!env` variable is not set in the process environment, the `--env-file` file or the `--env-dir` directory. Only that entry fails. Set the variable, then restart, or under `--watch` save the env file (`loader.retry` rereads it). See [Environment variables](../../config-file/#environment-variables). |
| Entry fails with `ModuleNotFound`                                      | Its `name` did not resolve; the message lists the names tried. See [Plugin names](../../config-file/#plugin-names).                                                                                                                                                                                           |
| Entry fails with `ModuleInvalid`                                       | The module did not import, or exports no plugin as its default export or as `plugin`.                                                                                                                                                                                                                         |
| `graft start` exits at once                                            | The first configuration is invalid without `--watch`, or the `--env-file` file or `--env-dir` directory is missing. See [graft start](../../cli/#graft-start).                                                                                                                                                |
| A package manager lists two versions of `effect` or `@graftland/graft` | A plugin package depends on them directly. They must be one copy. See [Plugin packages](../packaging/).                                                                                                                                                                                                       |
| A remote plugin ignores code edits                                     | Without `--watch`, restart the host. With it, rebuild when the entry points at built JavaScript; a network runner's code is not watched. See [Config changes and hot reload](../../remote/hosts/#config-changes-and-hot-reload).                                                                              |

## A stop that does not finish

A provider stops only after the consumers of its services have stopped, in the
order of [How withdrawal works](../../services/#how-withdrawal-works). When that
takes more than 10 seconds, Graft logs
`Still waiting for consumers of <keys>; a teardown cycle may be holding them`
and keeps waiting, on shutdown, on a restart and on a hot reload alike.

| Look for                                                                                   | Fix                                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| A consumer's finalizer that waits for something the provider does only after it stops.     | Do not wait for the provider in a finalizer; release and return.       |
| A cycle through services or events: A's teardown waits for B, and B's waits for A.         | Break the cycle with a third plugin that owns the shared part.         |
| A consumer task inside `Effect.uninterruptible` that waits for something that never comes. | Keep waits interruptible; make only the critical step uninterruptible. |

A stop that hangs with no warning can be a module import that never finishes;
see [Limits](../../hot-reload/#limits).

## Errors

Find the error tag in the `Cause`, then the section of [Errors](../../errors/)
that lists it and says what to do.

| Tags                                                                               | Section                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `SchemaError`, `Fork.CleanupError`, a task failure                                 | [Fork failures](../../errors/#fork-failures)                   |
| `ServiceConflict`                                                                  | [Services](../../errors/#services)                             |
| `Graft.ReplacementConflict`                                                        | [Replacement](../../errors/#replacement)                       |
| `UnregisteredReference`, `InvalidIntercept`                                        | [Intercepts](../../errors/#intercepts)                         |
| `CyclicConfig`, `InvalidOperation`, `StoreError`, `LoaderClosed`                   | [Loader and config file](../../errors/#loader-and-config-file) |
| `HmrError`, a `Skipped` result                                                     | [Hot reload](../../errors/#hot-reload)                         |
| `RemoteError`, `Contract.UndeclaredFailure`, `RemoteWithdrawn`, `RemoteEntryError` | [Remote](../../errors/#remote)                                 |
