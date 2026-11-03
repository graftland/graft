# @graftland/graft

English |
[简体中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-CN.md)
|
[繁體中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-TW.md)

A plugin framework built on Effect: plugins, forks, services, isolation, events
and logs.

The supported Node.js minimum is 22.19.

```sh
npm install @graftland/graft effect
```

Define plugins with `Plugin`, run them with `Graft`, and connect them with
services and `Event`.

Use `Plugin.fork(effect)` for background work that a plugin owns.

- If a worker fails or has a defect and nobody handles it, the activation fails.
  The failure carries its complete Cause. The activation then follows its retry
  schedule.
- Pure interruption does not fail the activation.
- After a plugin is withdrawn, healthy workers keep serving existing consumers.
  They stop only after those consumers release their leases. This happens before
  the activation resources close.
- The error types of the workers are part of the plugin contract, through
  `Plugin.Tasks<E>`.
- Handle recoverable errors inside the worker, before you fork it.
- Bare `Effect.forkScoped` manages lifetime, but it does not send failures to
  Graft.

`fork.dispose` has type `Effect<void, Fork.CleanupError>`.

- Concurrent and repeated callers share the same cleanup result.
- `CleanupError.cause` keeps all the original failure reasons.
- Cleanup continues through resource release and dependency lease release, even
  when a finalizer fails.
- Activation failures also include cleanup failures in `Failed.cause`.
- When the parent scope closes automatically, Graft reports a cleanup error as a
  defect. The defect keeps the original Cause.

`fork.state` replays the current state, emits changes, and ends with `Disposed`,
including for subscriptions started after disposal. `fork.await` waits for this
fork to leave `Loading`; `Pending` counts as settled and `Failed` fails with the
plugin's cause.

`fork.stable` waits until this fork and its descendants have no `Loading`
states. It also treats `Pending` and `Failed` as settled and does not fail on a
failed child. It reads a subtree counter without constructing or subscribing to
the fork tree. Configuration coordinators must still check their own request
versions and queued refreshes: this barrier describes current fork states and
does not wait for requests that have not started yet.

These rules apply to dependencies declared in `inject`:

- A provision in the consumer's realm wins over the environment where
  `Graft.layer` was built.
- Required and optional consumers both restart when that provision appears or is
  withdrawn. They fall back to the environment when it is available.
- Provisions are never inherited from a parent plugin. Each child resolves its
  own dependencies.
- Ambient services stay available across realms.
- Injected `Context.Reference` keys also fall back to inherited values and
  intercepts, or to their defaults. They never stay `Pending` for lack of a
  value. A provision still takes priority.

Realm labels and service keys are independent parts of identity. This is also
true when either one contains NUL characters. Shared labels never address
private realms or the default root realm.

A publication can restart its own provider through dependency changes or
descendant scopes. Graft rejects such a publication atomically with
`ServiceConflict`.

- Required `Pending` dependencies are waiting to start. They do not count as
  restart watchers.
- A rejected provider waits until its configuration, its dependencies, or the
  blocking graph change.

See the [service documentation](https://graftland.github.io/graft/services/).

Plugin identity is object reference identity.

- Reusing a definition refers to the same plugin.
- `{ ...plugin }` creates a distinct plugin, even with identical fields.
- Loading, replacement, and conflict checks use this rule. They use it whatever
  the definition's own `Equal` or `Hash` behavior is.

`Graft.replace` rejects mappings that its global aliases cannot represent. It
rejects them with a typed `ReplacementConflict`, which contains the conflicting
pair indices.

- Validation and publication share one transaction. A conflicting batch leaves
  aliases and forks unchanged.
- Overlapping replacements such as `P → Q, Q → R` must be split into versions
  with distinct identities.
- A single rollback to an older version is still supported.

Typed replacements keep the same input type. They may only narrow the original
error bound, including decoding errors. Definitions keep that contract across
aliases. Dynamically loaded `Plugin<any>` values explicitly erase it.

## Documentation

- [Plugins](https://graftland.github.io/graft/plugins/)
- [Services](https://graftland.github.io/graft/services/)
- [Lifecycle](https://graftland.github.io/graft/lifecycle/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
