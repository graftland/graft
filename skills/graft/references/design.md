# Designing with dynamic layers and Effects

Design before code. A Graft program is good when its shape matches the problem's
**lifetimes**: what can start, stop, change, fail and be replaced on its own.
Find those first; the API calls follow.

## Think in layers

Take the feature list and ask of each part, in order:

| Question                                                             | If yes, it is…                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Could someone turn it on or off, or replace it alone?                | Its own **mount**: a `Layer` mounted with `Graft.mount`           |
| Does it offer a capability that other parts call?                    | A **service** the layer provides; callers require its key         |
| Does it choose a value the operator or user sets at run time?        | A **publication** (`Graft.publish`), updated with `set`           |
| Is it a capability that can be absent without stopping the consumer? | A `Graft.optional` requirement                                    |
| Does it vary per tenant or instance, side by side?                   | A **realm** (`isolate`), with per-caller settings via `intercept` |
| Does it live as long as the process and nobody configures it?        | An **environment** service in the host's layer                    |
| Must it crash alone, use its own thread or run on another machine?   | Still a service; the provider is moved with [Remote](remote.md)   |

Then put **state where its owner lives**. State belongs to the mount that
creates it (a `Ref`, a connection, a cache), and other parts reach it only
through that mount's service. When the mount is torn down, its state goes with
it; when it rebuilds, it starts clean.

### Ownership replaces bookkeeping

Most code a dynamic system usually needs disappears when every registration has
an owner:

| Hand-written approach                              | Graft approach                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| A central registry plus code that unregisters      | Publish inside the layer; the mount's scope withdraws it         |
| `if (client)` checks before using an optional part | `requires: [Graft.optional(Client)]`, read with `serviceOption`  |
| A startup order list                               | `requires`: each layer waits for what it needs                   |
| A module-level singleton                           | A service published by a mount, or an environment service        |
| Feature flags and config files                     | Mount it or don't; publish the settings as a value               |
| Restarting the process to reconfigure              | `publication.set(next)`; dependents rebuild                      |
| A list kept in sync with what is enabled (`/help`) | An ordinary `Stream` over `Graft.watch` of each capability       |
| try/catch that keeps a broken part limping         | Let the build fail; it is retried, everything else keeps running |

### Sizing mounts

- One mount per independently useful unit. A mount too large forces unrelated
  parts to restart together; one too small spreads one lifetime over several
  mounts that are always mounted together.
- Split by what changes together: a client and the work that uses it are two
  mounts when the work can outlive a client rebuild.
- A mount that mounts a fixed set of children is a composition; call
  `Graft.mount` for each from inside a parent layer.

## Think in Effects

| Habit                                       | In practice                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Describe, then run at the edge.**         | Modules define layers and values. The host provides `Graft.layer` and runs them.                                              |
| **Every lifetime is a `Scope`.**            | For each resource and fiber, name its owner and when it ends: the mount, a task, a call.                                      |
| **Failures are values.**                    | Expected failures are tagged errors in the type; bugs are defects. Both keep their `Cause`.                                   |
| **Recover where you can act.**              | Catch an error at the closest point that can do something useful; let the rest fail the mount and retry.                      |
| **Dependencies live in the type.**          | A requirement shows up in `R`; satisfy it with a layer, never a global.                                                       |
| **Concurrency is structured.**              | Fibers have owners (`Graft.fork`, `FiberSet`). Use `Stream` for sequences, `Queue` or `PubSub` for hand-off, `Ref` for state. |
| **Time and randomness are services.**       | `Schedule`, `Clock` and `Random` make retries and timing testable with `TestClock`.                                           |
| **Validate at the boundary, trust inside.** | `Schema` decodes external input once; inside, values are typed and immutable (`Option`, `Data`, `HashMap`).                   |

A useful test: if a piece of code needs to remember to clean something up, an
owner is missing. If it needs to check whether something exists, a requirement
is missing. If it catches an error only to log and continue, decide whether that
error is expected (handle it where it happens) or a failure (let the mount
fail).

## Worked example: a pricing service

Features: quote prices from a database, cache them, read the region from
operator-run settings, serve several tenants with different databases, and keep
the database client in its own process.

| Part                 | Becomes                                                                 | Why                                                |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| Database client      | A `Layer` mounted with `graft.mount(dbLayer, { requires: [Database] })` | A connection with a lifetime                       |
| Cache                | `requires: [Graft.optional(Cache)]` in the pricing layer                | Works with or without it, rebuilds when it appears |
| Region and markup    | `Graft.publish(AppConfig, …)`, updated with `set`                       | Chosen at run time; rebuilds pricing on change     |
| Pricing              | A `Layer` requiring `Database` and the config service                   | Built only while its inputs exist                  |
| Per-tenant databases | `isolate: [Database]` on the tenant mount                               | Same layers, separate services per tenant          |
| A per-caller region  | `intercept` on a `Context.Reference`                                    | One shared service, settings scoped to the caller  |
| The database process | `Remote.service` + `Remote.connect`                                     | Same key; only where it runs changes               |

What follows without extra code: updating the config tears pricing down first
and rebuilds it; losing the cache keeps pricing running; unmounting a tenant
takes only that tenant's services with it.

## Design checklist

Done when every line holds:

- Every part has a row: layer, service, publication, optional requirement,
  realm, intercept or environment service.
- Every piece of state has one owning mount, reached by others only through a
  service.
- Every resource has an owning scope, and every background fiber goes through
  `Graft.fork`.
- Every service key lives in a module shared by provider and consumers.
- Every expected failure has a recovery point, and every other failure is left
  to fail its mount, with a `retry` schedule where retrying helps.
- Every setting is a publication, an environment service or an intercept, chosen
  by who sets it and how long it lives.
