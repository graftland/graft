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

Run `graft start graft.yml` in production and keep `--watch` for development.
Every option is on the [command line](../../cli/#graft-start) page.

| Concern                        | Without `--watch`                                                                                 | With `--watch`                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Plugin code changes            | Need a restart.                                                                                   | [Hot reload](../../hot-reload/), which is [not for production](../../hot-reload/#limits). |
| Hand edits to `graft.yml`      | Applied at the next restart or the next Loader edit.                                              | Applied on save.                                                                          |
| `--env-file` contents          | Read once at startup.                                                                             | [Read again on save](../../cli/#env-files).                                               |
| Invalid `graft.yml` at startup | The process [exits nonzero](../../cli/#invalid-first-configuration), so the deploy fails visibly. | The process waits, running no entries.                                                    |
| Failed entries                 | Retried on change, on their `retry` schedule, or by `loader.retry`.                               | Also retried after each module reload.                                                    |

Give every entry an `id`, or commit `graft.yml` after Graft
[writes the missing ones](../../config-file/#entry-fields), so a read-only or
freshly deployed file is not rewritten at startup.

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

A plugin without `retry` stays `Failed` until its config or dependencies change
or `loader.retry` runs. Give plugins that depend on a network resource a
schedule that never gives up, caps its delay and adds jitter, so forks that
share a database do not reconnect in lockstep:

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

- When to retry one call inside a task instead of the whole fork is on
  [Let the fork fail and retry](../effect/#let-the-fork-fail-and-retry).
- Entries have no `retry` field, so the schedule belongs to the plugin. For a
  `name: remote` entry, see [Contain failures](#contain-failures).

## Contain failures

A failure stops one activation and restarts the consumers of its services
([How withdrawal works](../../services/#how-withdrawal-works)). Choose the
boundary by what can go wrong:

| What can fail                                                     | Boundary                                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Two resources that fail independently                             | Separate plugins. [One failing task](../../plugins/#when-a-task-fails) fails its whole activation. |
| One tenant's or instance's dependencies                           | A [realm](../../isolation/) per instance. Only consumers in that realm wait.                       |
| Crashes, leaks, `process.exit` or code that throws outside Effect | Remote `local`: a [child process](../../remote/overview/).                                         |
| CPU-heavy work that blocks the event loop                         | Remote `worker`: a Node worker in the same process.                                                |
| Hardware, data or a network on another machine                    | A [runner](../../remote/runners/).                                                                 |
| What the code is allowed to do                                    | A runner inside a container or a VM; [Remote](../../remote/overview/) does not limit permissions.  |

An exception thrown outside Effect, such as in a raw callback, can end the whole
process. Inside the process, only Effect failures are contained.

A `name: remote` YAML entry has no `retry`, so a crashed child stays `Failed`
until the entry changes or `loader.retry` runs. To restart it, export a
`Remote.plugin` with `retry` from a module and load that module instead:

```ts title="src/greeterHost.ts"
import { Schedule, Schema } from "effect"

import * as Remote from "@graftland/plugin-remote"

declare const contract: Remote.Contract.Contract<
	Schema.Struct<{ readonly greeting: typeof Schema.String }>
>

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	implementation: new URL("./greeter.js", import.meta.url).href,
	connect: { local: {} },
	retry: Schedule.spaced("5 seconds"),
})
```

```yaml title="graft.yml"
- id: greeter
  name: ./dist/greeterHost.js
  config:
    greeting: Hello
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

| Rule                                                                                                               | Why                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold every resource with `Effect.acquireRelease` or `Effect.addFinalizer` in `apply`.                              | Only what `apply` acquires is released at shutdown.                                                                                                                                                                       |
| Finish work in flight in a finalizer or an uninterruptible region.                                                 | Tasks are interrupted after consumers drain; an interrupted task loses its work.                                                                                                                                          |
| Set the service manager's stop timeout above your slowest finalizer.                                               | `graft start` has no overall shutdown timeout. Only `SIGKILL` cuts a stuck stop short.                                                                                                                                    |
| Raise `shutdownTimeout` on `Remote.plugin` when a remote plugin's finalizers need more than the default 5 seconds. | A YAML `remote` entry keeps the fixed 5 s; export a `Remote.plugin` from a module, as in [Contain failures](#contain-failures), to change it. See [Timeouts and defaults](../../remote/lifecycle/#timeouts-and-defaults). |

For a stop that hangs, see
[A stop that does not finish](../troubleshooting/#a-stop-that-does-not-finish).

## Reconfigure without a restart

Change a running application through the [Loader API](../../loader-api/) instead
of restarting it. Only the changed entries reload; the rest keep their
connections and state. Which field change updates and which reloads is on
[Changes while running](../../config-file/#changes-while-running); a `remote`
entry always restarts its plugin process.

- Edits are written to `graft.yml`. A deployment that replaces the file discards
  them, so treat the deployed file as state or write the change back to your
  repository.
- A running process's environment cannot change from outside. Rotating a secret
  set there needs a restart. `loader.retry`
  [rereads `!env` values](../../config-file/#when-values-are-read-again), which
  helps only when their source changed, such as `--env-file` or `--env-dir`
  under `--watch`.
- Support [Update in place](../../plugins/#update-in-place) in plugins that hold
  connections or caches, so a config edit does not drop them.

## Upgrade plugins

Changes in `node_modules` never trigger a reload, with or without `--watch`.
Upgrade by installing and restarting:

1. **Install** with `graft add <package>@<version>`. If the install fails, the
   package files are restored; see [Rollback](../../cli/#rollback).
2. **Restart** the process. A running process keeps the modules it already
   imported.
3. **Roll back** by installing the previous version the same way and restarting.

| Rule                                                              | Pitfall it avoids                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Disable or remove the entry before `graft remove`.                | `graft add <package>` and `graft remove` change only dependencies; an entry for a removed package fails to load.      |
| Do not install while other tools edit the project.                | An install owns the package files until it finishes; see [Installation ownership](../../cli/#installation-ownership). |
| Upgrade all `@graftland/*` packages to the same version.          | Graft releases every package with [one version](../../releases/#versions).                                            |
| Keep a config change compatible, or ship it with the new version. | Config that no longer decodes fails that entry with `SchemaError`.                                                    |

To swap plugin code without a restart, an embedding host can call
[`Graft.replace`](../../replace/); the
[checkout-upgrade](https://github.com/graftland/graft/tree/main/samples/checkout-upgrade)
sample does this under load.

## Embed instead of the CLI

Run Graft from your own program when you need what `graft start` does not offer:
JSON logs, a tracer, a fixed set of bundled plugins, or services that your
existing server already owns. Build the environment yourself, including the
intercepts your `graft.yml` uses; an embedded loader registers none:

```ts
import { Layer, Logger, LogLevel, References, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Intercept, ModuleResolver } from "@graftland/loader"

const environment = Layer.mergeAll(
	NodeServices.layer,
	ModuleResolver.layer({
		base: process.cwd(),
		importer: (specifier) => import(specifier),
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

| Rule                                                            | Why                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Put the server's own services in `environment`.                 | Plugins inject them like any service, and they live as long as the program.                       |
| Run with `NodeRuntime.runMain`.                                 | It turns `SIGINT` and `SIGTERM` into interruption, so the scope closes and plugins stop in order. |
| Add `SecureRandom.layerWebCrypto` if you load `remote` entries. | Remote needs it; `graft start` provides it for you.                                               |
