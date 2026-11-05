---
title: Intercepts
description: Change a setting for one fork and everything below it.
---

An intercept changes a `Context.Reference` for one fork and everything below it.
A reference is a key that always has a value. Effect's own settings are
references, for example the annotations added to every log line.

| You want to…                           | Use                                                            |
| -------------------------------------- | -------------------------------------------------------------- |
| Change a reference from code           | `Graft.intercept` in the `intercept` option.                   |
| Change a reference from `graft.yml`    | A registered [config-file intercept](#config-file-intercepts). |
| Give a fork its own services or events | [Realms](../isolation/) instead.                               |

## Change a reference

```ts import.meta.vitest name="intercepts: change a reference"
import { Effect, References, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const tenant = Plugin.make({
	name: "tenant",
	config: Schema.Struct({ name: Schema.String }),
	apply: () => Effect.log("ready"),
})

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

const [line] = await Effect.runPromise(
	Effect.gen(function* () {
		yield* (yield* tenantA).await
		return yield* Graft.logs.pipe(Stream.take(1), Stream.runCollect)
	}).pipe(
		Effect.annotateLogs({ app: "shop" }),
		Effect.scoped,
		Effect.provide(Graft.layer),
	),
)
line?.annotations["tenant"] // => "a"
line?.annotations["app"] // => "shop"
```

The function receives the value from outside, so intercepts nest. Every log line
from this fork and the plugins below it carries `tenant: "a"`, together with the
annotations added further up.

## Settings that follow the caller

Use references for settings that a service should read from its caller. A
service method that returns an Effect runs in the caller's fiber, so it sees the
caller's intercepts:

```ts import.meta.vitest name="intercepts: settings that follow the caller"
import { Context, Effect, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const Formal = Context.Reference<boolean>("app/Formal", {
	defaultValue: () => false,
})

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

const greeter = Plugin.make({
	name: "greeter",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) =>
				Effect.flatMap(Formal, (formal) =>
					Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
				),
		}),
})

const hello = Plugin.make({
	name: "hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("Ada")),
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(greeter)
		yield* (yield* Graft.plugin(hello)).await
		const formal = Graft.intercept(Formal, () => true)
		yield* (yield* Graft.plugin(hello, undefined, { intercept: [formal] }))
			.await
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["Hi, Ada!"], ["Good day, Ada."]]
```

A plugin loaded with `Graft.intercept(Formal, () => true)` gets formal greetings
from the same `Greeter` that everyone else uses.

## References in `inject`

References may also appear in `inject`.

- A provision in the fork's realm takes priority over the intercepted fallback.
- Children strip parent provisions before they apply their own intercepts. They
  keep the parent's fallback value, including intercepts that the provision had
  hidden.

## Config-file intercepts

`Graft.intercept` is a typed code API. The loader's YAML `intercept` field is an
untrusted boundary, so it does not accept any string key. Keys must be
registered explicitly.

Each registration has three parts:

| Part           | What it is                                  |
| -------------- | ------------------------------------------- |
| Reference      | The `Context.Reference` object.             |
| Schema         | Decodes the configured input.               |
| Merge function | A typed function `(outer, patch) => value`. |

Register them in the environment that runs the loader, next to its plugin
resolver and any other platform services:

```ts import.meta.vitest name="intercepts: register a reference"
import { Context, Effect, Layer, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Intercept, Loader, ModuleResolver } from "@graftland/loader"

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

const show = Plugin.make({
	name: "show",
	apply: () => Effect.flatMap(Settings, Effect.log),
})

const environment = Layer.merge(references, ModuleResolver.fromRecord({ show }))
const runtime = Layer.provideMerge(Graft.layer, environment)

const [line] = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(Loader.plugin, [
			{
				id: "show",
				name: "show",
				intercept: { "app/Settings": { color: "red" } },
			},
		])
		return yield* Graft.logs.pipe(Stream.take(1), Stream.runCollect)
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)
line?.message // => [{ color: "red", size: 12 }]
```

In `graft.yml`, the same entry is:

```yaml title="graft.yml"
- id: show
  name: show
  intercept:
    app/Settings:
      color: red
```

How values combine:

- A nested entry's patch receives its parent's value. Siblings keep their own
  values.
- Schemas decode input before the merge function runs, and must not need
  decoding services.
- The merge function's return type must match the Reference.
- For a scalar replacement, or for settings you want to check as a whole, use
  `(_, value) => value` with a full-value schema.

Failures:

| Problem               | Error                                                  |
| --------------------- | ------------------------------------------------------ |
| Key is not registered | `UnregisteredReference`                                |
| Value is invalid      | `InvalidIntercept`, with the schema error as its cause |

In both cases the entry's plugin does not start.

:::note

The registry is empty by default. Provide it in the host environment before you
create the loader; a plugin inside the managed tree cannot register references
by publishing a service. The stock CLI registers
`References.CurrentLogAnnotations` (merges annotation fields) and
`References.MinimumLogLevel` (replaces the level after a check). Other
references need a custom host registration. This does not change the typed
`Graft.intercept` API that you use directly from code.

:::
