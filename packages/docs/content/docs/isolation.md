---
title: Isolation and intercepts
description: Give part of the plugin tree its own services, events or settings.
---

## Realms

Every service key and event belongs to a **realm**. By default, the whole
application is one realm: a service published anywhere is visible everywhere,
and an event reaches every handler.

The `isolate` option of `Graft.plugin` gives a fork and everything below it its
own realm for some keys:

```ts
const tenants = Plugin.make({
	name: "tenants",
	apply: () =>
		Effect.gen(function* () {
			yield* Graft.plugin(tenant, { name: "a" }, { isolate: [Database] })
			yield* Graft.plugin(tenant, { name: "b" }, { isolate: [Database] })
		}),
})
```

Each `tenant` fork can publish its own `Database`, and plugins inside each fork
see only that one. A `Database` published outside is not visible inside, and the
other way round. Keys that are not isolated are shared as usual.

`isolate` takes anything with a `key`: a service key such as `Database`, or an
[event](../events/).

### Shared realms

A label puts forks into one shared realm instead of a private one:

```ts
const staging = Effect.gen(function* () {
	yield* Graft.plugin(api, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(worker, undefined, { isolate: [[Database, "staging"]] })
})
```

`api` and `worker` share the `Database` of the `staging` realm, wherever they
are in the tree, and do not see any other `Database`.

## Intercepts

An intercept changes a `Context.Reference` for one fork and everything below it.
A reference is a key that always has a value: Effect's own settings, such as the
annotations added to every log line, are references.

```ts
import { References } from "effect"

const tenantA = Graft.plugin(
	tenant,
	{ name: "a" },
	{
		intercept: [
			Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
				...outer,
				tenant: "a",
			})),
		],
	},
)
```

The function receives the value from outside, so intercepts nest: every log line
from this fork and the plugins below it carries `tenant: "a"`, together with the
annotations added further up.

Use references for settings that a service should read from its caller. A
service method that returns an Effect runs in the caller's fiber, so it sees the
caller's intercepts:

```ts
const Formal = Context.Reference<boolean>("app/Formal", {
	defaultValue: () => false,
})

// Inside the Greeter service:
const greet = (name: string) =>
	Effect.flatMap(Formal, (formal) =>
		Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
	)
```

A plugin loaded with `Graft.intercept(Formal, () => true)` gets formal greetings
from the same `Greeter` that everyone else uses.
