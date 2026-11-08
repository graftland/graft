---
title: Running in production
description:
  Start, secure, supervise, reconfigure, stop and upgrade a long-running Graft
  application.
---

A production Graft application is one long-lived process: `graft start`, or your
own program built on `Graft.layer`, run by a service manager that restarts it
and stops it with `SIGTERM`.

## Start without `--watch`

Run `graft start graft.yml` after building your modules. `--watch` is rejected.
Configuration, environment files and installed packages are read for this start;
rebuild and restart to apply edits.

## Pass secrets

Read secrets with `!env` and decode them as `Redacted`, so neither the file nor
the logs hold the value
([Types and secrets](../../config-file/#types-and-secrets)). For secrets mounted
as files, add [`--env-dir`](../../cli/#env-directories):

```yaml title="graft.yml"
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL
```

```ts import.meta.vitest name="production: pass secrets"
import { Effect, Redacted, Schema } from "effect"

const config = Schema.Struct({
	url: Schema.RedactedFromValue(Schema.String),
})

const { url } = await Effect.runPromise(
	Schema.decodeEffect(config)({ url: "postgres://app:secret@db/app" }),
)
String(url) // => "<redacted>"
Redacted.value(url) // => "postgres://app:secret@db/app"
```

| Rule                                                            | Pitfall it avoids                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Set production variables in the process environment.            | It [wins over `--env-file`](../../cli/#env-files), so a stale `.env` beside the deploy cannot override it.       |
| Keep `.env` out of Git.                                         | `graft create` writes a `.gitignore` that ignores it; keep that line.                                            |
| Never publish the fork tree's `input`.                          | `Graft.forks` shows each fork's input as resolved, before decoding, so `!env` values appear there in plain text. |
| Catch a missing variable with a [health check](#report-health). | It [fails only its entry](../../config-file/#environment-variables), and the process keeps running.              |

## Retry flaky resources

A plugin without `retry` stays `Failed` until its config or dependencies change.
Give plugins that depend on a network resource a schedule that never gives up,
caps its delay and adds jitter, so forks that share a database do not reconnect
in lockstep:

```ts import.meta.vitest name="production: retry flaky resources"
import { Effect, Ref, Schedule, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class ConnectionRefused extends Schema.TaggedError<
	ConnectionRefused,
	{ readonly brand: unique symbol }
>()("ConnectionRefused", {}) {}

// Stands in for a database that refuses the first connection.
const attempts = Ref.makeUnsafe(0)
const connect = Effect.flatMap(
	Ref.updateAndGet(attempts, (n) => n + 1),
	(n) => (n === 1 ? ConnectionRefused.make({}) : Effect.void),
)

const client = Plugin.make({
	name: "app/client",
	retry: Schedule.min([
		Schedule.exponential("1 second"),
		Schedule.spaced("1 minute"),
	]).pipe(Schedule.jittered),
	apply: () => connect,
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(client)
		yield* fork.state.pipe(
			Stream.map((state) => state._tag),
			Stream.takeUntil((tag) => tag === "Active"),
			Stream.runCollect,
		) // => ["Loading", "Failed", "Loading", "Active"]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

## Report health

A failed or pending entry does not stop the process, so a service manager that
only watches the process sees a healthy application. Publish the fork states for
a health endpoint:

```ts title="health.ts"
import { Array, Context, Effect, Ref, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

export class Health extends Context.Service<
	Health,
	{ readonly unhealthy: Effect.Effect<ReadonlyArray<string>> }
>()("app/Health") {}

const unhealthy = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<string> =>
	Array.flatMap(trees, (tree) => [
		...(tree.state._tag === "Failed" || tree.state._tag === "Pending"
			? [`${tree.name}: ${tree.state._tag}`]
			: []),
		...unhealthy(tree.children),
	])

export const health = Plugin.make({
	name: "app/health",
	apply: () =>
		Effect.gen(function* () {
			const latest = yield* Ref.make<ReadonlyArray<string>>([])
			yield* Graft.forks.pipe(
				Stream.runForEach((trees) => Ref.set(latest, unhealthy(trees))),
				Plugin.fork,
			)
			yield* Graft.provide(Health, { unhealthy: Ref.get(latest) })
		}),
})
```

Load the health monitor and this route plugin with the
[HTTP server](../../http/). The mount injects `Health` and answers 503 when the
list is not empty:

```ts
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import { Health } from "./health.ts"

export default Plugin.make({
	name: "app/health-route",
	inject: [Health],
	apply: () =>
		Http.mount(
			HttpRouter.add(
				"GET",
				"/health",
				Effect.gen(function* () {
					const health = yield* Health
					const unhealthy = yield* health.unhealthy
					return HttpServerResponse.empty({
						status: unhealthy.length === 0 ? 200 : 503,
					})
				}),
			),
		).pipe(Effect.asVoid),
})
```

To diagnose the tree, see [Troubleshooting](../troubleshooting/).

## Set log levels per entry

Lower the level only on the entry you are diagnosing, for as long as the
investigation lasts. How to set it is on
[Set the level per entry](../observability/#set-the-level-per-entry), and how to
get JSON logs or traces is on
[Choose the output in your host](../observability/#choose-the-output-in-your-host).

## Stop gracefully

On `SIGTERM` or <kbd>Ctrl</kbd>+<kbd>C</kbd>, `graft start` unloads every
plugin. A plugin that publishes services waits for their consumers to stop
before it closes, so the consumers' finalizers can still use them; see
[How withdrawal works](../../services/#how-withdrawal-works).

| Rule                                                                                  | Why                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Hold every resource with `Effect.acquireRelease` or `Effect.addFinalizer` in `apply`. | Only what `apply` acquires is released at shutdown.                                    |
| Finish work in flight in a finalizer or an uninterruptible region.                    | Tasks are interrupted after consumers drain; an interrupted task loses its work.       |
| Set the service manager's stop timeout above your slowest finalizer.                  | `graft start` has no overall shutdown timeout. Only `SIGKILL` cuts a stuck stop short. |

For a stop that hangs, see
[A stop that does not finish](../troubleshooting/#a-stop-that-does-not-finish).

## Reconfigure without a restart

Directly embedded applications can edit their Loader and explicitly refresh
references. A CLI process requires restart after edits. A public deployment can
re-resolve raw references during preparation and recovery; see
[Units](../../units/).

## Upgrade plugins

After installing packages, rebuild application modules and restart:

1. **Install** with `graft add <package>@<version>`. If the install fails, the
   package files are restored; see [Rollback](../../cli/#rollback).
2. **Restart** the process. A running process keeps the modules it already
   imported.
3. **Roll back** by installing the previous version the same way and restarting.

| Rule                                                              | Pitfall it avoids                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Disable or remove the entry before `graft remove`.                | `graft add <package>` and `graft remove` change only dependencies; an entry for a removed package fails to load.      |
| Do not install while other tools edit the project.                | An install owns the package files until it finishes; see [Installation ownership](../../cli/#installation-ownership). |
| Upgrade all `@graftland/*` packages to the same version.          | Graft releases every package with [one version](../../publishing/#versions).                                          |
| Keep a config change compatible, or ship it with the new version. | Config that no longer decodes fails that entry with `SchemaError`.                                                    |

To swap plugin code without a restart, run `graft start` in
[watch mode](../../cli/#watch-mode), or submit a [Change](../../transitions/).

## Embed instead of the CLI

Run Graft from your own program when you need what `graft start` does not offer:
JSON logs, a tracer, a fixed set of bundled plugins, or services that your
existing server already owns. Build the environment yourself, including the
intercepts your `graft.yml` uses; an embedded loader registers none:

```ts
import { Layer, Logger, LogLevel, References, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Intercept, ModuleResolver } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address

const environment = Layer.mergeAll(
	NodeServices.layer,
	ModuleResolver.layer({
		base: "/app",
		control,
	}).pipe(Layer.provide(NodeServices.layer)),
	Intercept.layer([
		Intercept.make(
			References.MinimumLogLevel,
			Schema.Literals(LogLevel.values),
			(_, level) => level,
		),
	]),
	Logger.layer([Logger.consoleJson]),
)
```

Then run `Include.Include` in `Layer.provideMerge(Graft.layer, environment)`, as
in [Load a config file](../../embedding/#load-a-config-file).

| Rule                                            | Why                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Put the server's own services in `environment`. | Plugins inject them like any service, and they live as long as the program.                       |
| Run with `NodeRuntime.runMain`.                 | It turns `SIGINT` and `SIGTERM` into interruption, so the scope closes and plugins stop in order. |

## Keep a gateway session during upgrades

Keep the upstream session in a gateway [unit](../../units/) and inject the
integration through a fixed [binding](../../bindings/). Replace only the
integration through [public control](../../control/). The gateway unit and its
session remain unchanged.

Record the outcome and native exit evidence before reporting success. Recovered
means a fresh previous artifact passed trial. RecoveryFailed leaves the
integration unavailable. Stuck retains unresolved reservations.
[Release storage](../../application-releases/) records data independently of
kernel execution; control does not persist deployment history.
