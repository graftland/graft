---
name: graft
description:
  Use when building on Graft (`@graftland/graft`), Effect's dynamic Layer: mounting
  layers that build and tear down as their dependencies come and go, publishing
  values such as config, background fibers, multi-tenant isolation, watching or
  awaiting services, running a service in another process over
  `@graftland/graft/rpc`, or a mount stuck `Pending` or `Failed`.
---

# Build with Graft

Graft is a library, not a framework. It makes Effect `Layer` a **dynamic**
layer: mount a layer, and Graft builds it while everything it requires is
available, publishes the services it provides, and tears it down — dependents
first — when a requirement goes away. There is no config file, no CLI and no
process to hand over.

The API is small; the skill is the **thinking**. Shape the program around
lifetimes and dependencies first, and the code becomes short.

## Version gate

`@graftland/graft` with `effect` `4.1.x`, Node.js 22.19 or later. Check the
project's `package.json`; if Effect is 3.x, stop and tell the user Graft needs
Effect 4.

The package exports three namespaces: `Graft`, `Mount` and `Release`.

```ts
import { Graft, Mount, Release } from "@graftland/graft"
```

Types are qualified: a mount handle is `Mount.Mount<E>`, a publication is
`Mount.Publication<S>`, a state is `Mount.MountState`.

## Think in lifetimes

| Term            | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| **Graph**       | The running dependency graph, provided by `Graft.layer`                    |
| **Mount**       | One layer in the graph: built while its requirements hold, torn down after |
| **Publication** | A value placed in the graph directly, such as config; can be updated       |

- **Anything that comes and goes is a mount.** A database client, a feature, a
  per-tenant set of services: write a normal `Layer` and mount it.
- **Requirements live in the type.** The Layer's `RIn` says what it needs; the
  mount's `requires` only adds Graft bookkeeping. A type error on a service read
  means a missing requirement or `Layer`.
- **The provider owns the service.** A service's resources belong to the mount
  that publishes it and vanish with it. A registry, an unregister call or a
  startup-order list means an owner is missing.
- **Value changes are re-mounts.** Publishing a new value with `set` tears down
  and rebuilds everything that requires it; never mutate a published value in
  place.
- **Where code runs is a deployment choice.** A service that must survive
  another process's crash still provides the same key; move it with
  [Remote](references/remote.md) and leave its consumers alone.

## Think in Effects

- **Describe, then run at the edge.** Importing a module only defines values;
  building a mount is where anything is acquired; the host runs it all.
- **Every lifetime is a `Scope`.** For each resource and fiber, name its owner
  and when it ends. Background work inside a mount goes through `Graft.fork`.
- **Failures are values with a `Cause`.** Expected failures are tagged errors in
  the type. A failed build or background fiber puts the mount in `Failed` with
  the full cause; add `retry` to rebuild it.
- **Validate at the boundary.** A `Schema` decodes input once; inside, values
  are typed and immutable.

Design questions, ownership, a worked example and a checklist:
[design](references/design.md).

## Steps for new work

### 1. Design

Read [design](references/design.md) and map every part of the problem to a
layer, a published value, an optional requirement, a realm or a remote service.
Present the table to the user when the split is a real choice.

### 2. Declare the keys

Put every service key in a module that the provider and its consumers both
import, with package-scoped key strings such as `"@acme/app/Database"`. Done
when the module typechecks and importing it performs no I/O.

### 3. Write the layers and mount them

| The part…                          | Use                                                 |
| ---------------------------------- | --------------------------------------------------- |
| Builds services, reads other ones  | A plain `Layer` passed to `Graft.mount`             |
| Is external input, such as config  | `Graft.publish(Key, value)`, then `publication.set` |
| Must run in the background         | `Graft.fork(effect)` inside the mounted layer       |
| Needs a service that may be absent | `requires: [Graft.optional(Key)]`                   |

```ts
const program = Effect.gen(function* () {
	const pricing = yield* Graft.mount(pricingLayer, {
		name: "pricing",
		requires: [Database, Graft.optional(Cache)],
		retry: Schedule.exponential("1 second"),
	})
	const config = yield* Graft.publish(AppConfig, { region: "eu" })
	yield* config.await // available before anyone relies on it
	yield* config.set({ region: "us" }) // rebuilds everything requiring it
})
```

Done when it typechecks with no `any` or assertion. Remember `publish` only
creates the publication; `await`/`stable` is what makes it available.

### 4. Consume across lifetimes

Ordinary code reading a disappearing service uses `Graft.watch`, `Graft.await`,
`Graft.use` or `Graft.whileAvailable`; see [services](references/services.md).
Done when service arrival, withdrawal and return are covered by a test.

### 5. Test

Run each mount in a fresh graph and assert on states, services and logs. Done
when every behavior the design promises — waiting, building, tearing down,
updating, the failures it handles — has a test.

### 6. Run and watch

Provide `Graft.layer` to a `ManagedRuntime` or `runMain` like any Layer. Use
`Graft.mounts` and `Graft.logs` to observe the graph. If a mount belongs in
another process, wrap it with [Remote](references/remote.md) only after it works
in process.

## References

| Topic                                                      | Read                                             |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Splitting a problem, ownership, Effect habits              | [design](references/design.md)                   |
| Mounting layers, `requires`, `optional`, retry, publish    | [mounting](references/mounting.md)               |
| Consuming services, `watch`/`await`/`use`/`whileAvailable` | [services](references/services.md)               |
| Realms and intercepts for multi-tenancy                    | [isolation](references/isolation.md)             |
| Resources, background fibers, `Release`, retries           | [resources](references/resources.md)             |
| `mounts`, `logs`, observing the graph                      | [observability](references/observability.md)     |
| A service in another process or thread                     | [remote](references/remote.md)                   |
| Subprocess and worker Protocols                            | [node](references/node.md)                       |
| In-memory Protocol and tests with `@effect/vitest`         | [testing](references/testing.md)                 |
| A mount `Pending` or `Failed`, an error name               | [troubleshooting](references/troubleshooting.md) |

`https://graftland.github.io/graft/` is the source of truth for exact behavior.
