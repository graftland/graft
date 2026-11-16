---
title: Isolation
description:
  Give a mount its own services, or share one set across several mounts.
---

A **realm** is the namespace in which a service resolves. By default every mount
uses one shared realm. `isolate` gives a mount a different one.

## Give a mount its own realm

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Database extends Context.Service<Database, string>()("app/Database") {}
class Tenant extends Context.Service<Tenant, string>()("app/Tenant") {}

const tenant = Layer.effect(
	Tenant,
	Effect.gen(function* () {
		const database = yield* Database
		return `tenant on ${database}`
	}),
)

export const program = Effect.gen(function* () {
	yield* Graft.mount(Layer.effect(Database, Effect.succeed("dedicated")), {
		name: "database",
		isolate: [Database],
	})
	yield* Graft.mount(tenant, { name: "tenant", requires: [Database] })
})
```

`isolate: [Database]` gives that mount a private realm for `Database`. Its
children inherit the mapping: they look up `Database` in the same private realm,
so they see the dedicated value.

| Option form                   | Realm                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- |
| Absent                        | The shared root realm.                                                 |
| `isolate: [Database]`         | A private realm for this mount.                                        |
| `isolate: [[Database, "eu"]]` | The shared realm labelled `eu`; every mount using the label shares it. |

Labels let several mounts share one set of services. Private realms and the root
realm cannot be reached through a label.

## What isolation covers

| Rule                     | Detail                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Per key                  | Each key is isolated separately. A mount can isolate `Database` and share everything else. |
| Inheritance              | A child mount starts with the realms of where it was created.                              |
| Unique providers         | Within one realm, one mount or publication provides a key.                                 |
| Lookup                   | A mount finds a service in its realm first, then in the environment of `Graft.layer`.      |
| No inheritance of values | A child never receives a parent's provision directly; it resolves the same realm itself.   |
| Environment              | Services from the environment stay visible in every realm.                                 |

Realm labels and service keys are independent parts of a service's identity,
even when either contains unusual characters.

## Publication cycles

Publishing a value can restart the mount that publishes it, directly or through
other mounts. Graft rejects such a publication atomically with
`Graft.ServiceConflict` and the realm stays unchanged.

1. **Find the watchers** of that key in the target realm: running mounts that
   use it as an optional dependency or through an ambient fallback.
2. **Follow** their descendants and the consumers of every provider they use.
3. **Reject** the publication if the publisher is among them.

| `reason`          | Case                                               |
| ----------------- | -------------------------------------------------- |
| `SelfDependency`  | The mount watches the key it is publishing.        |
| `DependencyCycle` | Another mount in the cycle watches it.             |
| `Invalidated`     | A dependency change already invalidated the mount. |

A rejected mount waits for a change in its spec, its dependencies or the
blocking graph. It does not retry into the same cycle. See
[failures and retries](../failures-retry/#serviceconflict).

## Isolation and intercepts

| Tool        | Changes                                                            |
| ----------- | ------------------------------------------------------------------ |
| `isolate`   | Which realm a service resolves in, so which provider a mount sees. |
| `intercept` | The value of a `Context.Reference` for a mount and its children.   |

Use `isolate` to keep tenants apart; use [intercepts](../intercepts/) to adjust
settings such as a timeout or a feature flag.
