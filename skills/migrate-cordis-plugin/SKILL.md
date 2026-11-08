---
name: migrate-cordis-plugin
description:
  Use when porting a cordis plugin or service to Graft, including `ctx`-based
  code, `Service` classes, `ctx.effect`, `ctx.on`/`emit`, `inject`,
  `isolate`/`intercept`, or tests written against cordis.
---

# Migrate a cordis plugin to Graft

Graft keeps cordis's model (a tree of plugins that publish and use services
while it runs) and expresses it with Effect. A port is a rewrite into Effect,
not a rename: there is no context object to carry over. For Graft design and
idioms beyond this mapping, use the [`graft`](../graft/SKILL.md) skill.

## Version gate

- Source: cordis 4.x (`Fiber`, `ctx.effect`, `Service[Service.init]`, Standard
  Schema `Config`, often Schemastery). Older cordis (`ctx.on('dispose')`,
  `ctx.on('ready')`, `ctx.state`) maps to the same targets; translate it to the
  4.x concept first.
- Target: `@graftland/graft` with `effect` 4.1.x. Check the project's
  `package.json`; if Effect is 3.x, stop and tell the user Graft needs Effect 4.

## Five shifts

Hold these while porting. Every row in the references follows from them.

1. **`ctx` becomes the environment.** A service is a typed `Context` key read
   with `yield* Key`. The plugin's place in the tree is the current `Scope`.
2. **Disposables become finalizers.** Whatever cordis collects to dispose later
   is a resource of the fork's `Scope`: `Effect.acquireRelease`,
   `Effect.addFinalizer`, `Plugin.fork`, `Event.on`, a child `Graft.plugin`.
3. **Promises become Effects.** Async functions, callbacks and timers become
   Effects; failures stay in the typed error channel with their full `Cause`.
4. **Strings become tokens.** Service names, event names and intercept keys are
   values (`Context.Service`, `Event.make`, `Context.Reference`), so the
   compiler checks every use.
5. **Config is an Effect `Schema`**, decoded inside activation. Decoding may be
   asynchronous and may use injected services.

## Steps

### 1. Inventory

Search the plugin for every cordis touchpoint: `from 'cordis'`, `ctx.`,
`this.ctx`, `Service`, `Context.`, `inject`, `Config`, `effect(`, `on(`,
`emit(`, `parallel(`, `serial(`, `bail(`, `waterfall(`, `isolate(`,
`intercept(`, `timeout(`, `interval(`, `logger`, `internal/`, `mixin(`,
`provide(`, `get(`, `set(`, `fiber`.

Write the result as a table: location, cordis construct, target (from the
[map](#map)), reference file. Done when every occurrence has a row and every row
names a target or **no equivalent**.

### 2. Define the tokens

Before touching plugin bodies, declare every key the plugin publishes or reads:

- Each cordis service name → a `Context.Service` class. Use a package-scoped key
  string such as `"@acme/graft-plugin-db/Database"`; a config file refers to
  services by this string.
- Each `Events` entry → an `Event.make` or `Event.middleware` token.
- Each intercept-configured service setting → a `Context.Reference`.

Put them in a module the plugin and its consumers both import. Done when the
module typechecks and nothing in it performs I/O on import.

### 3. Rewrite the plugin shell

Pick the shape:

| cordis plugin                                     | Graft                                             |
| ------------------------------------------------- | ------------------------------------------------- |
| Function, object with `apply`, or plain class     | `Plugin.make({ name, config, inject, apply })`    |
| `Service` subclass that only publishes itself     | `Plugin.service(Key, build, { name })`            |
| Plugin that publishes several services or a layer | `Plugin.layer(Layer, { name, inject, provides })` |

Export the plugin as the module's default export (or `plugin`), so the loader
can find it. Details: [references/plugins.md](references/plugins.md).

### 4. Port each inventory row

Work through the table one topic at a time, reading the topic's reference before
writing code. Done when every row is ported or recorded as **no equivalent**,
and no `cordis` import remains.

### 5. Verify

- Typecheck. Fix type errors by declaring the missing `inject` entry, error type
  or schema; `any` and type assertions hide exactly the checks Graft adds.
- Port the plugin's tests: [references/testing.md](references/testing.md). Each
  cordis test keeps its scenario and its assertions.
- Report the **no equivalent** rows to the user with the options from
  [No equivalent](#no-equivalent), and let them choose.

## Map

| cordis                                                              | Graft                                                       | Reference                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| `apply(ctx, config)`, `Config`, `name`                              | `Plugin.make`, `config: Schema`                             | [plugins](references/plugins.md)     |
| `inject` (array or object), `@Inject`                               | `inject: [Key, Plugin.optional(Key)]`                       | [plugins](references/plugins.md)     |
| `ctx.plugin(p, config)`, `ctx.inject(deps, cb)`                     | `Graft.plugin(p, input)` inside `apply`                     | [plugins](references/plugins.md)     |
| `ctx.on('internal/update')`, `fiber.update`, `restart`              | Update function returned from `apply`, `fork.update`        | [plugins](references/plugins.md)     |
| `Service`, `[Service.init]`, `ctx.provide`, `ctx.set`               | `Context.Service`, `Graft.provide`, `Plugin.service`        | [services](references/services.md)   |
| `ctx.foo`, `ctx.get('foo')`, `mixin`, `accessor`                    | `yield* Foo`, plain functions                               | [services](references/services.md)   |
| `ctx.effect`, returned disposers, generators of disposers           | `Effect.acquireRelease`, `Effect.addFinalizer`              | [resources](references/resources.md) |
| `ctx.timeout`, `ctx.interval`, `throttle`, `debounce`               | `Effect.sleep`, `Schedule`, `Plugin.fork`                   | [resources](references/resources.md) |
| `ctx.logger`                                                        | `Effect.log*` with annotations                              | [resources](references/resources.md) |
| `ctx.on`, `once`, `emit`, `parallel`, `serial`, `bail`, `waterfall` | `Event.on`, `once`, `emit`, `parallel`, `bail`, `waterfall` | [events](references/events.md)       |
| `ctx.isolate(name, label)`                                          | `isolate` option of `Graft.plugin`                          | [isolation](references/isolation.md) |
| `ctx.intercept(name, config)`, `inject: { foo: config }`            | `Context.Reference` and `Graft.intercept`                   | [isolation](references/isolation.md) |
| `FiberState`, `fiber.await()`, failed fibers                        | `Fork` states, `fork.await`, `retry: Schedule`              | [plugins](references/plugins.md)     |
| `internal/plugin`, `internal/status`, `internal/service`            | `Graft.forks`, `fork.state`                                 | [plugins](references/plugins.md)     |
| `registry.replace`                                                  | A `Deploy` operation in a Change                            | [plugins](references/plugins.md)     |

## Rules a port keeps

- **Importing the module does nothing** except define tokens and the plugin.
  Connections, servers, timers and file reads start inside `apply`.
- **Every fiber has an owner.** Background work goes through `Plugin.fork`, so
  Graft reports its failures. A raw `Effect.forkScoped` hides them.
- **Every failure keeps its `Cause`.** Catch a recoverable error inside the task
  or effect that raises it, and let the rest fail the fork.
- **Every dependency is declared.** If reading a service is a type error, add it
  to `inject`.

## No equivalent

These cordis features have no Graft counterpart. Present the options; the user
decides.

| cordis feature                                    | Options                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Services looked up by a runtime string            | A fixed set of keys, or one service holding a `HashMap` of named entries.           |
| `mixin` / `accessor` adding members to `ctx`      | Call the service directly, or export helper functions that `yield*` it.             |
| Callable services (`Service[Service.invoke]`)     | A method on the service, such as `service.run(...)`.                                |
| `ctx.getEffects()`, `reflect` introspection       | `Graft.forks` for the fork tree; Effect tracing for resource detail.                |
| Listening to `internal/*` events of other plugins | `Graft.forks` or `fork.state` streams, or an explicit event the other plugin emits. |
| Code that mutates another plugin's `ctx`          | Publish a service or emit an event that the owner handles.                          |

## Further reading

The docs page [Coming from cordis](https://graftland.github.io/graft/cordis/)
holds the concept table this skill expands. Each topic page under
`https://graftland.github.io/graft/` is the source of truth for exact behavior.
