---
title: Hot reload
description:
  How Graft swaps plugin code in a running Node.js process, and its limits.
---

With `graft start --watch`, changing an observed plugin module or dependency
replaces the affected plugins with the new code. The process keeps running, and
so does everything that was not loaded from a plugin module, such as the
services in its environment.

| Page section                                                  | Answers                                  |
| ------------------------------------------------------------- | ---------------------------------------- |
| [What happens on a save](#what-happens-on-a-save)             | What does Graft do after I save a file?  |
| [What triggers a reload](#what-triggers-a-reload)             | Which files and changes count?           |
| [When a reload does not apply](#when-a-reload-does-not-apply) | Why did my change not take effect?       |
| [Rules for plugin modules](#rules-for-plugin-modules)         | How do I write code that reloads well?   |
| [Limits](#limits)                                             | What cannot hot reload do?               |
| [Change detection](#change-detection)                         | How are changes found?                   |
| [Leases and observation](#leases-and-observation)             | Which files are watched, and until when? |

## What happens on a save

1. **Check.** Graft checks observed files after merging native event paths. An
   event alone does not trigger a reload: file contents or a tracked local
   resolution must actually change. Saving identical bytes, or changing an
   unrelated file, does not reload plugins.
2. **Invalidate.** Automatic reload invalidates changed module instances and
   their transitive importers, including cycles. Only affected entries are
   reimported. Entries sharing the same old Plugin object are checked together;
   unchanged dependencies and independent entries keep their existing instances.
3. **Validate and replace.** All candidates must pass import, export identity
   and resolution checks before one [`Graft.replace`](../replace/) transaction
   publishes the replacements. Affected forks restart in the usual
   [withdrawal order](../services/#how-withdrawal-works), and shared
   dependencies stay consistent across the batch.
4. **Or keep the old code.** If a candidate fails, the old plugins keep running
   and the full cause is logged.

### If a candidate fails

| Situation                     | Behavior                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Import or check fails         | Old plugins keep running. HMR retains the changed modules and failed observations for the next change.                              |
| A plugin entry was deleted    | It is dropped from the reload. Its existing forks keep running until unloaded.                                                      |
| Events arrive during a reload | They remain available for the next pass.                                                                                            |
| Incomplete write              | The reload may fail. Graft logs the full cause and keeps watching; a later content change can recover, even without a native event. |

After a reload attempt returns `Reloaded` or `Skipped`, the CLI calls
`loader.retry`. This retries failed entries and refreshes `!env` values
throughout the tree, so fixing a broken plugin can start it without a process
restart.

### Forced reload

Public `hmr.reload` always forces a fresh import of every registered entry and
its tracked dependencies. It also advances the import view when there are no
entries, so a failed first import can be retried. This differs from the
incremental reloads performed by `watch`.

## What triggers a reload

| Property            | Value                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**           | `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` and `.cts` under the config directory, including subdirectories.                                                           |
| **Excluded**        | Anything in `node_modules`.                                                                                                                                     |
| **YAML**            | Not handled here. YAML edits belong to the loader.                                                                                                              |
| **Debounce**        | Nearby file events are debounced for 50 ms.                                                                                                                     |
| **New entries**     | Adding a plugin through configuration does not itself trigger a reload.                                                                                         |
| **Resolution**      | Each module instance keeps its own resolution view. Late dynamic imports from old code, including activation cleanup, do not switch to a global latest version. |
| **Dynamic imports** | Reused modules keep their dependency edges. Dynamic imports that have never run cannot be discovered in advance.                                                |

## When a reload does not apply

Some changes cannot be applied safely. HMR keeps all old plugins running and
reports why.

| Result / reason                 | Cause                                                                                                                      | What to do                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `Skipped` / `restart-required`  | A versioned module imports `node:module` or `module`, or a CommonJS or native dependency is reachable from a leased entry. | Restart the process.                   |
| `Skipped` / `restart-required`  | An entry or helper symlink now points to a different target.                                                               | Restart the process.                   |
| `Skipped` / `ambiguous-exports` | Two entries exported the same Plugin object before, but now export different ones. Reports the module URLs.                | Restart, or restore the shared export. |
| `Skipped` / `identity-conflict` | The replacement identities do not fit the runtime's aliases, such as `P → Q, Q → R`. Reports the module URLs.              | Restart.                               |
| `Failed`                        | An import or check failed. The value holds the full `Cause`.                                                               | Fix the code. Watching goes on.        |

Details:

- **Ambiguous exports** can recover if the shared export comes back. Validation
  rejects the whole batch before it publishes aliases or changes any fork.
- **`node:module` and `module`.** HMR plays safe and requires a restart. This
  records the native loading ability before a `createRequire` call can hit a
  cache, and covers `require(esm)` as well as CommonJS. Even an unrelated
  utility from that module puts the whole graph out of hot reload. Use ESM
  imports for dependencies that must reload.
- **Native-loading reports.** Watchers report known requirements even without a
  file notification, including when a plugin acquires the capability after
  startup. Unchanged periodic reports are suppressed, and the warning does not
  mean a reload occurred.
- **Symlinks.** Local file entries and their reachable dependency edges retain
  the importing module instance, requested path and physical target. The same
  owned graph is checked before imports, before replacement and during polling.
  Polling detects target changes even with identical bytes and lost native
  events. HMR does not clear Node's resolution caches, and the check does not
  re-resolve bare packages or package export maps.

## Rules for plugin modules

| Rule                                     | Why                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Importing must have no side effects.** | Graft reimports affected modules during reload, and only `apply` runs inside a scope Graft can close. Open connections, start servers and set timers in `apply`.                                                                             |
| **Use ECMAScript modules.**              | CommonJS and native dependencies need a restart. Graft tracks dependencies by module instance, including dynamic imports made during `apply`. While a leased entry can reach such a dependency, reload returns `Skipped / restart-required`. |
| **Expect `node_modules` to be shared.**  | Packages there are not reloaded, and Effect and Graft must stay one copy. The one exception is the module a plugin is loaded from: a plugin from a package is imported again, but the other files of that package are not.                   |
| **Run Node.js 22.19 or later.**          | This matches the requirement of the CLI's Effect Node adapter, and it provides `module.registerHooks`.                                                                                                                                       |

## Limits

| Limit                              | Detail                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Memory grows in long sessions**  | Node's ESM cache does not evict versioned module instances. Incremental reload creates fewer instances, but they still accumulate. HMR reclaims source digests, dependency observations and reachability caches according to leases and the current import view; compact routing views remain until the session closes. There is no hard upper bound on process memory. |
| **No supervision**                 | HMR does not supervise or restart a child process. Restart the process when needed.                                                                                                                                                                                                                                                                                     |
| **Not for production**             | Do not use `--watch` in production.                                                                                                                                                                                                                                                                                                                                     |
| **Remote plugins restart instead** | With `graft start --watch`, local/worker [remote entries](../remote/hosts/#config-changes-and-hot-reload) restart when their contract or implementation file changes. The host does not watch implementations installed on a network runner.                                                                                                                            |
| **Hung imports block reloads**     | An import that never finishes, such as a top-level `await` that never resolves, holds up later reloads and shutdown, because a dynamic import cannot be cancelled.                                                                                                                                                                                                      |

## Change detection

| Mechanism               | Behavior                                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native events**       | Force a content check, even when stat is unchanged.                                                                                                                                                                                                                                                      |
| **Polling**             | Metadata and local resolutions are checked once per second. A stat fast path avoids reading files whose metadata has not changed.                                                                                                                                                                        |
| **Idle audit**          | At least every ten seconds, HMR audits contents, so missed notifications for saves with the same size and timestamps are still detected.                                                                                                                                                                 |
| **Baselines**           | SHA-256 digests of the bytes actually loaded, so a save between import and watcher installation is also detected.                                                                                                                                                                                        |
| **Watched directories** | Nonrecursive watches on directories from the observed dependency graph, even with `recursive: true`. HMR does not walk unrelated directories or `node_modules`, and loaded `dist` modules remain observable. Missing paths use the nearest existing ancestor, and the set is reconciled once per second. |
| **Concurrency**         | Checks respect the watched paths, `recursive` and `filter`, and stop when the stream closes. Reads run outside the session lock with bounded concurrency; results are accepted only if the observation version still matches.                                                                            |

Observation baselines:

- Each observation belongs to one import attempt and its actual source bytes.
- After a new attempt, polling uses those bytes as its baseline, including when
  a file returns to the previous snapshot during reload.
- A failed attempt advances the baseline if it read source bytes, so an
  unchanged failure does not cause a polling retry loop.

Watcher failures:

- The CLI logs watcher I/O failures and installs the watcher again after one
  second.
- Native watcher producers observe their complete `Exit` after source cleanup
  and before entering background stream merging. Only cancellation requested by
  the observer with a matching cause is silent. Resource cleanup interruption
  and mixed failures are logged with their full `Cause`. Ordinary backend
  failures still propagate to the consumer without duplicate logging.
- Failures that finish during cancellation are handed over as complete `Exit`s
  before interruption is restored. HMR records an original failure that the
  cancellation would otherwise hide, including its full `Cause`.

## Leases and observation

The CLI registers each module for as long as its configuration entry lives.

| Event                                      | Effect                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Entry is removed or disabled               | It releases its lease. After the last lease closes, reload no longer imports the entry.                                     |
| Entry is pending or failed                 | It keeps its lease, so changes can still recover it.                                                                        |
| Entry is unloaded                          | It, and its exclusive CommonJS dependencies, cannot block the remaining entries.                                            |
| Last owner of a path is released           | The path leaves polling.                                                                                                    |
| A reload succeeds                          | Only observations no longer reachable from active or pending entries are retired; reused dependency instances remain owned. |
| Real I/O error on a path that has an owner | The watch stream fails.                                                                                                     |

Polling follows the leases. It covers the running dependency graph of each live
entry and its latest uncommitted import attempt, including failed imports and
missing local files that retries need.

Failed first imports keep an observation lease owned by the configuration entry,
separate from the candidate resource scope that closes immediately on failure.
Fixing the module can therefore recover through polling even when the native
notification is lost. Retry replaces the observation generation; removal or
disabling closes it.

Remote entries keep their observation collection across activation and retry
failures; see [remote recovery](../remote/hosts/#config-changes-and-hot-reload).

To use HMR outside the CLI, see [HMR API](../hmr-api/).
