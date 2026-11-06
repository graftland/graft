---
title: Logs and tracing
description: Write useful logs from plugins and export Graft's spans.
---

Plugins log and trace with Effect's own tools: `Effect.log*`, log annotations
and spans. Graft annotates the lines each plugin logs and wraps each plugin
start in a span; the host decides where both go.

## Pick a log level

Write a constant message and put the values that change in annotations, so
structured output can be searched and filtered:

```ts import.meta.vitest name="observability: annotate a log line"
import { Effect, Option, Stream } from "effect"

import { Graft } from "@graftland/graft"

interface Order {
	readonly id: string
}

const accepted = (order: Order) =>
	Effect.log("Order accepted").pipe(
		Effect.annotateLogs({ "shop.order": order.id }),
	)

const annotations = await Effect.runPromise(
	Effect.gen(function* () {
		yield* accepted({ id: "A-17" })
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.annotations)
	}).pipe(Effect.provide(Graft.layer)),
)
annotations // => Option.some({ "shop.order": "A-17" })
```

| Level   | Use it for                                                             | Example message                          |
| ------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `Error` | A failure you handled that someone must look at.                       | `Payment refused; order dropped`         |
| `Warn`  | Degraded but still working: a fallback, a retry, a dropped item.       | `Sync failed; serving the last snapshot` |
| `Info`  | What an operator wants to see by default: listening, connected, ready. | `Listening on 8080`                      |
| `Debug` | Detail for diagnosing one plugin: each request, each message.          | `Received frame`                         |
| `Trace` | Detail too noisy even for a debugging session, such as payloads.       | `Frame bytes`                            |
| `Fatal` | Not for plugins. A plugin's failure belongs to its fork; let it fail.  |                                          |

The minimum level is `Info` unless the host or an entry changes it. Lines below
it reach no logger, `Graft.logs` included.

## Log the cause

Pass a `Cause` as an argument, not `error.message`. The logger keeps the whole
error with its stack trace; a message keeps one string. Wrap an error you caught
by tag with `Cause.fail`:

```ts import.meta.vitest name="observability: log the cause"
import { Cause, Effect, Option, Schema, Stream } from "effect"

import { Graft } from "@graftland/graft"

class SyncFailed extends Schema.TaggedError<
	SyncFailed,
	{ readonly brand: unique symbol }
>()("SyncFailed", {}) {}

const sync = Effect.fail(SyncFailed.make())

const synced = Effect.catchTag(sync, "SyncFailed", (error) =>
	Effect.logWarning(
		"Sync failed; serving the last snapshot",
		Cause.fail(error),
	),
)

const cause = await Effect.runPromise(
	Effect.gen(function* () {
		yield* synced
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.cause)
	}).pipe(Effect.provide(Graft.layer)),
)
cause // => Option.some(Cause.fail(SyncFailed.make()))
```

| Situation                                                 | Do                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| You recover and go on.                                    | Log the cause where you recover, at `Warn` or `Error`.                                     |
| The failure reaches `apply` or a `Plugin.fork` task.      | Do not log it. Graft logs it with the full cause and keeps it in the `Failed` state.       |
| You drop best-effort work on purpose.                     | `Effect.ignore({ log: "Warn", message: "Refreshing the cache failed" })` logs and goes on. |
| You log with `Effect.tapCause` and let the failure go on. | The failure is logged twice. Do one or the other.                                          |

Whether to recover at all is covered in [Effect in plugins](../effect/).

### What Graft logs

Search for these messages, or alert on them. None is written for pure
interruption, which is normal cancellation.

| Message                                                                       | Level   | When                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Plugin "<name>" failed`                                                      | `Error` | `apply` failed. Each retry that fails logs again.                                                                                                      |
| `The plugin's background task failed`                                         | `Error` | A [`Plugin.fork` task](../../plugins/#when-a-task-fails) failed.                                                                                       |
| `Releasing the plugin's resources failed`                                     | `Error` | A finalizer failed while the fork stopped.                                                                                                             |
| `Updating in place failed; restarting instead`                                | `Warn`  | The plugin's [update](../../plugins/#update-in-place) failed. The fork restarts.                                                                       |
| `The plugin's retry schedule failed`                                          | `Error` | The `retry` schedule itself failed.                                                                                                                    |
| `Still waiting for consumers of <keys>; a teardown cycle may be holding them` | `Warn`  | Withdrawing services is still waiting for their consumers to stop. See [A stop that does not finish](../troubleshooting/#a-stop-that-does-not-finish). |
| `Disposing a loader entry failed`                                             | `Error` | [Cleanup of a removed or replaced entry](../../config-file/#cleanup-failures) failed. Carries `loader.entry` and `loader.plugin`.                      |

## Annotations

`graft.fork` is the fork's `id`, the same number as in the fork tree.
`graft.plugin` is the plugin's `name`. Which fork a line names depends on the
fiber that runs the code:

| Code                                         | Annotated with                                                      |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `apply`, its finalizers, `Plugin.fork` tasks | The plugin's own fork.                                              |
| An event handler                             | The fork that registered the handler.                               |
| A service method                             | The fork that **called** it. The method runs in the caller's fiber. |
| Host code outside any plugin                 | Nothing. See [Logs](../../lifecycle/#logs).                         |

Add your own annotations at the narrowest place that is true for every line:

| For                              | Use                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| One effect, or all of `apply`    | `Effect.annotateLogs({ ... })` piped onto it.                                                    |
| A fork and every plugin below it | [`Graft.intercept`](../../intercepts/#change-a-reference) on `References.CurrentLogAnnotations`. |
| An entry in `graft.yml`          | [`effect/References/CurrentLogAnnotations`](../../config-file/#intercepts-in-a-config-file).     |

- Prefix your keys with your package, as Graft does with `graft.`, `loader.` and
  `remote.`.
- To tell a service's own lines from its caller's, annotate inside the method.
- Keep secrets `Redacted` until the call that needs them. A `Redacted` value
  logs as `<redacted>`; a plain string logs as itself. See
  [Types and secrets](../../config-file/#types-and-secrets).

## Set the level per entry

Lower the level only for the entry you are diagnosing. The setting covers that
entry and its child plugins; its siblings keep theirs.

| Goal                         | Setting                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| See one plugin's debug lines | `effect/References/MinimumLogLevel: Debug` in the entry's `intercept`. |
| Quiet a chatty plugin        | `effect/References/MinimumLogLevel: Warn` in the entry's `intercept`.  |
| The same from TypeScript     | `Graft.intercept` in the `intercept` option of `Graft.plugin`.         |

- Changing `intercept` unloads and loads the entry again. See
  [Changes while running](../../config-file/#changes-while-running).
- `graft start` has no option for a global level. Set it on the entries.
- An embedding host accepts these keys in YAML only after it
  [registers them](../../intercepts/#config-file-intercepts), as in
  [Embed instead of the CLI](../production/#embed-instead-of-the-cli).

## Choose the output in your host

`graft start` prints [readable lines](../../cli/#logs-and-intercepts) to
standard error and has no other format. For JSON lines or a log shipper,
[embed Graft](../../embedding/) and provide a `Logger` layer underneath
`Graft.layer`; without one, Effect's default logger prints.

```ts import.meta.vitest name="observability: choose the output"
import { Effect, Layer, Logger, Option, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

const runtime = Layer.provideMerge(
	Graft.layer,
	Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.consoleJson])),
)

const message = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Effect.log("Listening on 8080")
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.message)
	}).pipe(Effect.provide(runtime)),
)
message // => Option.some(["Listening on 8080"])
```

`Graft.layer` adds its own collector to the loggers it finds there. A
`Logger.layer` provided closer to the program, or listed after `Graft.layer` in
`Layer.mergeAll`, replaces the collector, and `Graft.logs` receives nothing.

A [remote plugin](../../remote/overview/)'s logs reach the host's loggers at
their own level, with the plugin's annotations in `remote.annotations` and
`remote.pid` or `remote.threadId`. Entries lost under load show as
[`Remote logs were dropped`](../../remote/transport-auth/#warnings).

## Collect logs in a plugin

`Graft.logs` streams every entry the environment logs, for alerting, a log view
or tests. The basics are under [Logs](../../lifecycle/#logs).

```ts import.meta.vitest name="observability: collect logs in a plugin"
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Layer,
	LogLevel,
	Stream,
} from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Pager extends Context.Service<
	Pager,
	{ readonly page: (entry: Graft.LogEntry) => Effect.Effect<void> }
>()("app/Pager") {}

const alerts = Plugin.make({
	name: "app/alerts",
	inject: [Pager],
	apply: () =>
		Effect.gen(function* () {
			const pager = yield* Pager
			const started = yield* Clock.currentTimeMillis
			yield* Graft.logs.pipe(
				Stream.filter(
					(entry) =>
						entry.date.getTime() >= started &&
						LogLevel.isGreaterThanOrEqualTo(entry.level, "Error"),
				),
				Stream.runForEach(pager.page),
				Plugin.fork,
			)
		}),
})

const pages = Deferred.makeUnsafe<Graft.LogEntry>()
const layer = Layer.provideMerge(
	Graft.layer,
	Layer.succeed(Pager, { page: (entry) => Deferred.succeed(pages, entry) }),
)

const paged = await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(alerts)
		yield* fork.await
		yield* Effect.log("Order accepted")
		yield* Effect.logError("Payment refused; order dropped")
		const entry = yield* Deferred.await(pages)
		return entry.message
	}).pipe(Effect.scoped, Effect.provide(layer)),
)
paged // => ["Payment refused; order dropped"]
```

| Pitfall          | Rule                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Replayed entries | A new subscriber first gets [recent entries](../../lifecycle/#logs), so a restarted plugin sees them again. Filter on `date`. |
| Feedback         | Your plugin's own lines arrive too. Do not log at a level you forward, or skip entries with your own `graft.plugin`.          |
| Slow consumer    | The buffer slides. A subscriber that falls behind loses the oldest entries; logging never waits for it.                       |

## Spans

Graft runs the decoding of a plugin's config and its `apply` in a span named
`graft.plugin <name>`. Every load, restart and retry starts a new one. Name your
own operations with `Effect.fn` or `Effect.withSpan`:

```ts import.meta.vitest name="observability: name your spans"
import { Effect, Option, Schema, Tracer } from "effect"

import { Graft, Plugin } from "@graftland/graft"

// Stands in for a real connection.
const connect = (url: string) => Effect.logDebug(`Connecting to ${url}`)

const feed = Plugin.make({
	name: "app/feed",
	config: Schema.Struct({ url: Schema.String }),
	apply: Effect.fn("feed.apply")(function* ({ url }) {
		yield* connect(url).pipe(
			Effect.withSpan("feed.connect", { attributes: { url } }),
		)
	}),
})

// Records each span as "parent > name".
const spans: Array<string> = []
const tracer = Tracer.make({
	span: (options) => {
		const parent = Option.getOrUndefined(options.parent)
		spans.push(
			parent?._tag === "Span"
				? `${parent.name} > ${options.name}`
				: options.name,
		)
		return new Tracer.NativeSpan(options)
	},
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(feed, { url: "https://example.com/feed" })
		yield* fork.await
	}).pipe(
		Effect.scoped,
		Effect.withTracer(tracer),
		Effect.provide(Graft.layer),
	),
)
spans // => ["graft.plugin app/feed", "graft.plugin app/feed > feed.apply", "feed.apply > feed.connect"]
```

- `graft.plugin <name>` sits under the span where the plugin was loaded, so a
  child plugin loaded in `apply` sits under its parent's span.
- Spans inside `apply` and inside its `Plugin.fork` tasks sit under
  `graft.plugin <name>`, even after that span ends when `apply` returns.
- Name spans after the plugin and the operation, as the samples do with
  `Effect.fn("exchange.apply")`.
- A printed cause shows the span as a frame: `at graft.plugin <name>`.

Each `graft.plugin <name>` span carries the plugin's log identity, `graft.fork`
and `graft.plugin`, and also `graft.revision`:

| Attribute        | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| `graft.fork`     | The fork's `id`.                                                                        |
| `graft.plugin`   | The plugin's `name`.                                                                    |
| `graft.revision` | Starts at 0 and grows on `restart`, replacement and rollback; a config update keeps it. |

### Export spans

`graft start` creates the spans but installs no exporter. Export them with the
[`@graftland/plugin-otlp`](https://github.com/graftland/graft/tree/main/packages/plugin-otlp)
plugin, an ordinary plugin built from public Graft APIs. It loads the entries in
its `plugins` itself and sends the spans of that subtree to an OTLP/HTTP
collector:

```yaml title="graft.yml"
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    url: !env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    serviceName: chat-bot
    plugins:
      - id: bot
        name: ./src/bot.ts
```

| Change                                  | Effect                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP exporter settings                  | New spans go to a new exporter. Started spans keep the old one, which flushes and closes when they end. Draining waits at most its `shutdownTimeout`; Effect then allows a separate `shutdownTimeout` for flushing (at most twice the timeout in total). The subtree keeps running. |
| `exporter.config`                       | Forwarded to the exporter’s update function; a compatible update keeps the subtree running.                                                                                                                                                                                         |
| `plugins`                               | Reconciled like a group: unchanged entries keep running. The exporter is not updated when its config is unchanged.                                                                                                                                                                  |
| `exporter.name`                         | Restarts the traced subtree with the new provider.                                                                                                                                                                                                                                  |
| Moving entries into or out of `plugins` | Restarts those entries, because their parent and intercept change.                                                                                                                                                                                                                  |
| Exporter failure                        | The subtree waits for `Exporter` and resumes when the exporter’s own retry succeeds; no config change is needed.                                                                                                                                                                    |
| Unloading the entry                     | The subtree stops first, then all remaining exporters flush and close concurrently.                                                                                                                                                                                                 |

Plugins outside `plugins` are not traced. Graft writes missing ids in `plugins`
back to the file, just like top-level entries, so reordering them preserves
their identities.

The HTTP fields are shorthand for the ordinary `@graftland/plugin-otlp/http`
plugin. It supports `serialization: json | protobuf`, resource attributes and
batching options; see the
[package configuration](https://github.com/graftland/graft/tree/main/packages/plugin-otlp#readme)
for defaults. Durations are milliseconds; numeric fields accept `!env` strings.
Headers are `Redacted` values; supply credentials through `headers` with `!env`.
The HTTP plugin waits in `Pending` without `HttpClient`.

Select a third-party exporter with `exporter` instead of the HTTP fields:

```yaml title="graft.yml"
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    exporter:
      name: graft-plugin-custom-traces
      config:
        destination: !env TRACE_DESTINATION
    plugins:
      - id: bot
        name: ./src/bot.ts
```

| Exporter contract | Rule                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service           | Publish the stable `Tracer.Tracer` service `Exporter` from `@graftland/plugin-otlp/Exporter`, keyed `@graftland/plugin-otlp/Exporter`, using `Graft.provide`. |
| Lifetime          | Own resources and fibers in the plugin scope, retain in-flight spans across updates, and flush on close. Preserve failure causes.                             |
| Updates           | Return an update function that keeps the published tracer object. A restart withdraws it and restarts its consumers.                                          |
| Isolation         | Each host isolates `Exporter`; implementations can inject application services. Both shorthand and explicit names use `ModuleResolver`.                       |
| Verification      | Run `Testing.exporter` with a fresh `Graft.layer` and a collector; `received` returns flushed span names after close.                                         |

```ts
import { Effect } from "effect"

import type { Plugin } from "@graftland/graft"
import * as Testing from "@graftland/plugin-otlp/Testing"

declare const exporter: Plugin.Plugin
declare const received: Effect.Effect<ReadonlyArray<string>>

const conformance = Testing.exporter({
	plugin: exporter,
	config: { destination: "test" },
	nextConfig: { destination: "updated" },
	received,
})
```

Effect has one tracer per subtree and no fan-out combinator. Nested hosts
override the outer tracer. Other transports, enrichment, and vendor exporters
belong to third parties. This package provides no log or metrics export; third
parties may implement them.

When you embed Graft, you can instead provide a tracer layer where the
[`Logger` layer](#choose-the-output-in-your-host) goes, such as the OTLP
exporter from `effect/observability`:

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"

const tracing = OtlpTracer.layer({
	url: "http://localhost:4318/v1/traces",
	resource: { serviceName: "chat-bot" },
}).pipe(
	Layer.provide(
		Layer.mergeAll(OtlpSerialization.layerJson, FetchHttpClient.layer),
	),
)
```

- Every plugin inherits the tracer from where it is loaded, including entries
  that a loader loads.
- Effect's default loggers attach log lines to the current span as events. A
  `Logger.layer` replaces them; list `Logger.tracerLogger` in it to keep that.
- A remote plugin runs in another process or worker. The host's tracer does not
  reach it.

## Diagnose with the fork tree

Logs record what happened; [`Graft.forks`](../../lifecycle/#fork-tree) shows
what is true now. A fork waiting in `Pending` writes no log line, so log the
forks that stay there:

```ts import.meta.vitest name="observability: log the forks that wait"
import { Array, Context, Effect, Option, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

const unhealthy = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<string> =>
	Array.flatMap(trees, (tree) => [
		...(tree.state._tag === "Failed" || tree.state._tag === "Pending"
			? [`${tree.name}: ${tree.state._tag}`]
			: []),
		...unhealthy(tree.children),
	])

const waiting = Plugin.make({
	name: "app/waiting",
	apply: () =>
		Graft.forks.pipe(
			Stream.debounce("5 seconds"),
			Stream.map(unhealthy),
			Stream.runForEach((forks) =>
				forks.length === 0
					? Effect.void
					: Effect.logWarning("Forks not running", forks),
			),
			Plugin.fork,
			Effect.asVoid,
		),
})

class Database extends Context.Service<Database, {}>()("app/Database") {}

const reports = Plugin.make({
	name: "app/reports",
	inject: [Database],
	apply: () => Effect.void,
})

const warning = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(waiting)
		yield* Graft.plugin(reports)
		const entry = yield* Stream.runHead(
			Stream.filter(Graft.logs, (entry) => entry.level === "Warn"),
		)
		return Option.map(entry, (entry) => entry.message)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
warning // => Option.some(["Forks not running", ["app/reports: Pending"]])
```

- `unhealthy` is the walker from [Report health](../production/#report-health).
  It lists the forks that are `Pending` or `Failed`.
- Debounce the stream: it emits on every change, many times while entries load.
- A `Failed` node's `cause` holds the failures Graft logged for it.
- For symptoms and their causes, see [Troubleshooting](../troubleshooting/).
