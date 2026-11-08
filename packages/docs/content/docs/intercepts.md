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
	name: "app/tenant",
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
	name: "app/greeter",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) =>
				Effect.flatMap(Formal, (formal) =>
					Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
				),
		}),
})

const hello = Plugin.make({
	name: "app/hello",
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

Native preparation carries ordered JSON patches and immutable environment module
descriptors. Decode and merge code runs inside the inspection and execution
units. An environment module exports a Layer; `Configuration.Options` supplies
its encoded options.

```ts title="settings.ts"
import { Context, Effect, Layer, Schema } from "effect"

import { Configuration } from "@graftland/plugin-remote"

export const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})
const Patch = Schema.Struct({
	color: Schema.optionalKey(Schema.Trim),
	size: Schema.optionalKey(Schema.Finite),
})
export default Layer.effect(
	Settings,
	Effect.gen(function* () {
		const input = yield* Configuration.Options
		const patch = yield* Schema.decodeUnknownEffect(Patch)(input)
		const outer = yield* Settings
		return { ...outer, ...patch }
	}),
)
```

Register the module descriptor by reference key, then prepare a plugin without
activating it.

```ts
import { Effect, HashMap } from "effect"

import { ModuleResolver, Preparation } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address

export const prepared = Effect.gen(function* () {
	const resolver = yield* ModuleResolver.make({ base: "/app", control })
	const module = yield* resolver.resolve("@acme/graft-plugin-api")
	const settings = yield* resolver.resolve("./dist/settings.js", {
		kind: "Environment",
	})
	const prepare = yield* Preparation.make({
		control,
		intercepts: HashMap.make(["app/Settings", settings]),
	})
	return yield* prepare.inspect({
		instance: "api",
		module,
		input: { port: 8080 },
		intercept: [{ key: "app/Settings", patch: { color: "red" } }],
	})
})
```

| Input                      | Rule                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| Inheritance                | Parent patches precede child patches. Every recipe builds a fresh Layer.   |
| Unknown key                | `PreparationFailed` with `UnregisteredIntercept`, before unit work.        |
| Invalid patch              | Inspection fails with its full cause; the plugin is not applied.           |
| Functions and live objects | Rejected as non-JSON input.                                                |
| Recovery                   | Rebuilds the environment and resolves references under the current policy. |

In an explicitly embedded application, `Intercept.make` and `Intercept.layer`
register unit-local decoders and merges. These functions and the ambient
environment do not cross a native boundary. See [Loader API](../loader-api/) for
preparation and [embedding](../embedding/) for cooperative composition.
