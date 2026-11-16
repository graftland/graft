---
title: Concepts
description: The graph, the mounts on it and the values published into it.
---

Graft has three terms. Each one has a page for the rest of its rules.

| Term            | What it is                                                                       | Learn more                       |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------- |
| **Graph**       | The running dependency graph of services, provided by `Graft.layer`.             | [Mounting](../mounting/)         |
| **Mount**       | One layer placed in the graph. It is built while its requirements are available. | [Mounting](../mounting/)         |
| **Publication** | One value placed in the graph from outside a layer, such as configuration.       | [Publications](../publications/) |

A **service** is an Effect `Context` key with a value. Services in the graph can
be published by a mount, published directly, or supplied by the environment
where `Graft.layer` was built.

## How the parts relate

1. A mount **requires** entries: services and `Context.Reference` keys, some of
   them optional.
2. While every required entry is available, Graft **builds** the layer.
3. When the build finishes, Graft **publishes** each service in the layer's
   output context.
4. When a required entry **changes or disappears**, Graft stops every mount that
   uses these services, then releases the layer and builds it again.
5. A publication's **`set`** replaces its value, which rebuilds everything that
   requires it.

Mounts form a tree: a mount created inside another mount's layer is its child.
Closing a scope unmounts everything created in it.

## Guarantees

| Guarantee                                    | Where it comes from                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Requirements are declared and type checked   | `requires` is checked against the layer's input type.                   |
| Consumers stop before the provider goes away | Leases and teardown order in [lifecycle](../lifecycle/#teardown-order). |
| Resources are always released                | Every mount owns a `Scope`; its fibers belong to it.                    |
| Failures keep their full `Cause`             | [Failures and retries](../failures-retry/).                             |
| A change is accepted atomically              | Publishing, withdrawal and dependency checks share a transaction.       |

## Built on Effect

Graft adds no parallel vocabulary. It maps onto Effect:

| In Graft           | In Effect                                            |
| ------------------ | ---------------------------------------------------- |
| A mount            | A `Layer` built in a `Scope`                         |
| A service          | A `Context` key                                      |
| A published value  | A `Context` key with a value                         |
| Background work    | A `Fiber` owned by the mount                         |
| Retry              | A `Schedule`                                         |
| Per-mount settings | `Context.Reference` and [intercepts](../intercepts/) |
| Isolation          | Realms, described in [isolation](../isolation/)      |

Graft adds only what Effect does not have: services that come and go at run
time, a graph of layers that reacts to that, and safe teardown across it.
