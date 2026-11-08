---
name: graft
description:
  Use when designing, writing, testing, running or debugging code built on
  Graft (`@graftland/graft`, `@graftland/loader`, `@graftland/cli`,
  `@graftland/plugin-remote`): splitting an app into plugins, services and
  events, background tasks, realms and intercepts, `graft.yml` and
  `graft start`, embedding the runtime, running a plugin in another process or
  on another machine, or a fork stuck `Pending` or `Failed`.
---

# Build with Graft

Graft runs an application as a tree of plugins on Effect 4. A **plugin** is a
value; loading it makes a **fork** with its own config and `Scope`. Forks
publish **services** (Effect `Context` keys), handle **events** (typed tokens)
and load child forks. Graft adds only what Effect lacks: services that come and
go at run time, the plugin tree, events, config files and Changes. The rest is
plain Effect.

The API is small; the skill is the **thinking**. Shape the program around
lifetimes and owners first, and the code becomes short.

## Version gate

`@graftland/graft`, `@graftland/loader` and `@graftland/cli` (and
`@graftland/plugin-remote`, if used) of one release, `effect` 4.1.x, Node.js
22.19 or later. Check the project's `package.json`; if Effect is 3.x, stop and
tell the user Graft needs Effect 4.

## Think in plugins

- **A plugin is a lifetime.** Anything that can be turned on or off,
  reconfigured, replaced or fail on its own is a plugin, one entry in
  `graft.yml`.
- **A service is a capability, an event is an announcement.** Callers `inject`
  the service they need; senders emit events without knowing who listens.
- **The registrant owns the registration.** Handlers, services, resources and
  child forks belong to the fork that created them and vanish with it. A
  registry, an unregister call, an `if (client)` check or a startup order list
  means an owner or a dependency is missing.
- **State lives with its owner.** Other forks reach it only through that fork's
  service or events.
- **Variation has a home.** Per instance: a realm. Per caller: an intercept.
  Chosen by the operator: a config field. Fixed for the process: the
  environment.
- **Where code runs is a deployment choice.** A plugin that must survive
  another's crash, use its own thread or sit on another machine is still a
  plugin that provides the same service. `graft start` runs each entry in its
  own unit; [native units](references/remote.md) choose a Worker, Process or
  Runner placement.

## Think in Effects

- **Describe, then run at the edge.** Importing a module only defines values;
  `apply` is where anything is acquired; the host runs it all.
- **Every lifetime is a `Scope`.** For each resource and fiber, name its owner
  and when it ends. Background work goes through `Plugin.fork`.
- **Failures are values with a `Cause`.** Expected failures are tagged errors in
  the type. Recover where you can act; let the rest fail the fork, which is
  cleaned up and retried while the others keep running.
- **Dependencies live in the type.** A type error on a service read means a
  missing `inject`; satisfy requirements with `inject` or a `Layer`, never a
  global, `any` or an assertion.
- **Validate at the boundary.** A `Schema` decodes config and input once;
  inside, values are typed and immutable.

Design questions, the bookkeeping that ownership replaces, a worked example and
the checklist: [design](references/design.md).

## Steps for new work

### 1. Design

Read [design](references/design.md) and map every part of the problem to a
plugin, service, event, realm, intercept, environment service or config field.
Present the table to the user when the split is a real choice. Done when every
line of the design checklist holds.

### 2. Declare the tokens

Put every service key, event token and `Context.Reference` in a module that the
plugin and its consumers both import, with package-scoped key strings such as
`"@acme/graft-plugin-db/Database"`. Done when the module typechecks and
importing it performs no I/O.

### 3. Write the plugins

| The plugin…                               | Use                                               |
| ----------------------------------------- | ------------------------------------------------- |
| Does work, reads services, handles events | `Plugin.make({ name, config, inject, apply })`    |
| Only builds and publishes one service     | `Plugin.service(Key, build, { name })`            |
| Only publishes the services of a `Layer`  | `Plugin.layer(Layer, { name, inject, provides })` |

Inside `apply`, give each kind of work to its owner: `Effect.acquireRelease` for
resources, `Plugin.fork` for background work, `Graft.provide` for services,
`Event.on` for handlers, `Graft.plugin` for children. Export the plugin as the
module's default export. Name it like an Effect service key: package, module
path under `src/` without `index`, then the binding unless it is the default
export (`@acme/graft-plugin-db`, `@acme/graft-plugin-db/migrations/warmup`).
Done when it typechecks with no `any` or assertion.

### 4. Test

Load each plugin in a fresh runtime and assert on states, services, events and
logs. Done when every behavior the design promises (waiting, starting, stopping,
updating, the failures it handles) has a test.

### 5. Run

Run the app with `graft start`. In development, `graft start --watch` turns each
save into a Change that redeploys only the affected entries; a failed Change
leaves the running entries as they are ([apps](references/apps.md)). Use
captured native unit targets and public Kernel control when a plugin runs
outside its caller. Contracts and configuration decoding stay inside units; see
[native units](references/remote.md).

## References

| Topic                                                  | Read                                             |
| ------------------------------------------------------ | ------------------------------------------------ |
| Splitting a problem, ownership, Effect habits          | [design](references/design.md)                   |
| Config, `inject`, children, updates, retries, packages | [plugins](references/plugins.md)                 |
| Publishing and consuming services, withdrawal order    | [services](references/services.md)               |
| Resources, background tasks, timers, logging           | [resources](references/resources.md)             |
| Handlers, dispatch, middleware                         | [events](references/events.md)                   |
| Side-by-side instances and per-subtree settings        | [realms](references/realms.md)                   |
| Tests with `@effect/vitest`                            | [testing](references/testing.md)                 |
| `graft.yml`, the CLI, watch mode, embedding            | [apps](references/apps.md)                       |
| A plugin in a child process, a worker or a runner      | [remote](references/remote.md)                   |
| A fork `Pending` or `Failed`, an error name            | [troubleshooting](references/troubleshooting.md) |

`https://docs.graft.land/` is the source of truth for exact behavior.
The repository's `samples/` folder holds runnable programs with tests, from
`01-hello` to `05-config-file` and multi-tenant apps.
