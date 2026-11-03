---
title: Isolation and intercepts
description: Give part of the plugin tree its own services, events or settings.
---

## Realms

Every service key and event belongs to a **realm**. By default, the whole
application is one realm. A service published anywhere is visible everywhere. An
event reaches every handler.

The `isolate` option of `Graft.plugin` gives a fork, and everything below it,
its own realm for some keys:

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

Each `tenant` fork can publish its own `Database`. Plugins inside each fork see
only that one. A `Database` published outside is not visible inside, and the
other way round. Keys that are not isolated are shared as usual.

`isolate` takes anything with a `key`. This can be a service key such as
`Database`, or an [event](../events/).

### Shared realms

A label puts forks into one shared realm instead of a private one:

```ts
const staging = Effect.gen(function* () {
	yield* Graft.plugin(api, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(worker, undefined, { isolate: [[Database, "staging"]] })
})
```

`api` and `worker` share the `Database` of the `staging` realm, wherever they
are in the tree. They do not see a `Database` published in any other realm.

A label and a service or event key are separate parts of identity. Graft treats
each as a complete string, including embedded NUL characters. A label that
begins with `#` or `@` does not address a private realm. The empty label names a
shared realm. This realm is different from the default root realm.

### Environment fallback and inheritance

Realms isolate published services. They do not isolate ambient services from the
environment where `Graft.layer` was built. If a realm has no provision for an
injected key, its consumers may use the ambient value. Publishing or withdrawing
the key in realm A does not restart ambient consumers in realm B.

A parent's resolved provisions do not pass to children through Effect context
inheritance. Each child must declare its own `inject` dependencies to get
provisions in its own realm. Values inherited from the environment stay
available. Suppose a parent's provision hid a root environment value. Then the
child can use that environment fallback again. This also holds across several
generations of child plugins.

## Intercepts

An intercept changes a `Context.Reference` for one fork and everything below it.
A reference is a key that always has a value. Effect's own settings are
references. One example is the annotations added to every log line.

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

The function receives the value from outside, so intercepts nest. Every log line
from this fork and the plugins below it carries `tenant: "a"`, together with the
annotations added further up.

Use references for settings that a service should read from its caller. A
service method that returns an Effect runs in the caller's fiber. So it sees the
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

References may also appear in `inject`. A provision in the fork's realm takes
priority over the intercepted fallback. Children strip parent provisions before
they apply their own intercepts. They keep the parent's fallback value,
including intercepts that the provision had hidden.

### Config-file intercepts

`Graft.intercept` is a typed code API. The loader's YAML `intercept` field is an
untrusted boundary. It does not accept any string key. You must register keys
explicitly. At application start, register the Reference object, a Schema for
its input, and a typed merge function:

```ts
import { Graft } from "@graftland/graft"
import { Intercept, ModuleResolver } from "@graftland/loader"
import { Context, Layer, Schema } from "effect"

const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})

const references = Intercept.layer([
	Intercept.make(
		Settings,
		Schema.Struct({
			color: Schema.optionalKey(Schema.String),
			size: Schema.optionalKey(Schema.Finite),
		}),
		(outer, patch) => ({ ...outer, ...patch }),
	),
])

const environment = Layer.merge(references, ModuleResolver.fromRecord({}))
const runtime = Layer.provideMerge(Graft.layer, environment)
```

Run the loader in this runtime. Add its plugin resolver and any other platform
services to `environment`. Then an entry can contain:

```yaml
intercept:
  app/Settings:
    color: red
```

The result is `{ color: "red", size: 12 }`. A nested entry's patch receives its
parent's value. Siblings keep their own values. Schemas decode input before the
merge function runs. They must not need decoding services. The merge function's
return type must match the Reference. For a scalar replacement, or for settings
that you want to check as a whole, use `(_, value) => value` with a full-value
schema.

The registry is empty by default. An unknown key fails the entry with
`UnregisteredReference`. An invalid value fails with `InvalidIntercept` and
keeps the schema error as the cause. In both cases the entry's plugin does not
start. Provide the registry in the host environment before you create the
loader. A plugin inside the managed tree cannot register references by
publishing a service. The stock CLI registers `References.CurrentLogAnnotations`
to merge annotation fields. It also registers `References.MinimumLogLevel` to
replace the level after a check. Other references need a custom host
registration. This does not change the typed `Graft.intercept` API that you use
directly from code.
