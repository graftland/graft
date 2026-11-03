---
title: Coming from cordis
description: How cordis concepts map to Graft and Effect.
---

Graft follows the design of [cordis](https://github.com/cordiverse/cordis). An
application is a tree of plugins that publish and use services. The tree can
change while it runs. The difference is that Graft has no context object, effect
system or lifecycle helpers of its own. It uses the ones in Effect, and adds
only what Effect does not have.

## Concepts

| cordis                                 | Graft                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ctx`, with services as properties     | The Effect environment. Read a service with `yield* Key`.                                       |
| `ctx.plugin(plugin, config)`           | [`Graft.plugin(plugin, input)`](../lifecycle/#load-a-plugin), which returns a fork.             |
| `ctx.effect()`, disposables            | `Effect.acquireRelease`, `Effect.addFinalizer` and the plugin's `Scope`.                        |
| `inject`                               | [`inject`](../plugins/#dependencies), checked by the compiler, with optional entries.           |
| `ctx.provide`, `ctx.set`               | [`Graft.provide`](../services/#publish-a-service).                                              |
| Fiber states                           | [Fork states](../lifecycle/#fork-states): `Loading`, `Pending`, `Active`, `Failed`, `Disposed`. |
| `fiber.update`                         | [An update function](../plugins/#update-in-place) returned from `apply`.                        |
| `fiber.restart`                        | `fork.restart`.                                                                                 |
| `ctx.isolate`, labels                  | [`isolate`](../isolation/#realms), for services and events alike.                               |
| `ctx.intercept`                        | [`intercept`](../isolation/#intercepts) with `Context.Reference`.                               |
| `registry.replace`                     | [`Graft.replace`](../lifecycle/#replace-plugins).                                               |
| `ctx.on`, `ctx.emit`, `serial`, `bail` | [Events](../events/): `on`, `emit`, `parallel`, `bail`, `waterfall`.                            |
| Config with Standard Schema            | Effect `Schema`, decoded inside the plugin's activation.                                        |
| Logger, timer and fs plugins           | Effect's `Logger`, `Schedule`, `Clock` and `FileSystem`.                                        |
| `!!js` tags with `eval`                | `!env NAME` only. Config files never run code.                                                  |

## What Graft adds

- **Checked dependencies.** Reading a service that `inject` does not list is a
  type error.
- **Optional dependencies.** `Plugin.optional(Key)` lets a plugin start without
  a service. The plugin restarts when the service comes or goes.
- **A fixed teardown order.** First, the provider's services are withdrawn. Then
  the plugins that use them stop. Only then are the provider's resources
  released. See [How withdrawal works](../services/#how-withdrawal-works).
- **Interruptible startup.** If a dependency goes away while a plugin is still
  starting, Graft interrupts the start. The plugin does not finish starting
  against a service that is gone.
- **Typed failures with their causes.** A failed plugin keeps its full `Cause`.
  It can retry on a `Schedule`.
- **Config decoding with services.** Decoding can be asynchronous, and it can
  use the plugin's dependencies.
- **Handlers that keep their context.** An event handler runs with the services,
  realm and intercepts of its own plugin.
- **Atomic replacement.** `Graft.replace` changes every plugin in one
  transaction.

## What Graft leaves out

- **The context proxy, mixins and accessors.** Effect's environment and plain
  functions do the same job.
- **A resource tree.** cordis can list the effects that each plugin holds. Graft
  shows the fork tree. It leaves resource-level detail to Effect's tracing.
