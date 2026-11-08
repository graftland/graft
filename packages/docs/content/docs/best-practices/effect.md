---
title: Effect in plugins
description:
  Write plugin code that acquires, fails, retries and runs work in ways Graft
  can stop and clean up.
---

Inside `apply`, a plugin is ordinary Effect code; Graft only owns the fork
around it. When every resource, fiber and failure stays inside that fork, Graft
can stop, retry and replace the plugin without leaks.

## Describe on import, acquire in `apply`

A plugin module only defines values. Anything that opens, starts or reads from
the outside world runs in `apply`, where the fork's `Scope` owns it. A pool
opened on import is never closed, and every reload opens another:

```ts skip
const pool = createPool(process.env.DATABASE_URL)
```

Open it in `apply` instead: it opens when the fork starts and closes when it
stops:

```ts
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

interface Pool {
	readonly end: () => Promise<void>
}
declare const createPool: (url: string) => Pool

class Database extends Context.Service<Database, Pool>()("app/Database") {}

export default Plugin.make({
	name: "app/database",
	config: Schema.Struct({ url: Schema.String }),
	apply: ({ url }) =>
		Effect.gen(function* () {
			const pool = yield* Effect.acquireRelease(
				Effect.sync(() => createPool(url)),
				(pool) => Effect.promise(() => pool.end()),
			)
			yield* Graft.provide(Database, pool)
		}),
})
```

Keep service keys, event tokens, schemas, error types and the plugin at the top
level; the [rules for plugin modules](../../plugins/#plugin-modules) cover the
rest. Read settings from config fields, not `process.env`; see
[Where a setting belongs](../design/#where-a-setting-belongs).

## Release resources

Pick the tool by how long the resource must live:

| The resource lives…                        | Use                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| As long as the fork, and has a close       | `Effect.acquireRelease(open, close)`                                                 |
| As long as the fork, with only a stop step | `Effect.addFinalizer((exit) => ...)`                                                 |
| For one piece of work (a request, a batch) | `Effect.scoped` around that work, or `Effect.acquireUseRelease`                      |
| For one handler call                       | Acquire it in the handler. See [Handler context](../../events/#handler-context).     |
| For one background task                    | Acquire it inside the task. See [Background tasks](../../plugins/#background-tasks). |

- **Open inside `acquireRelease`, not before it.** The open step cannot be
  interrupted halfway, and once it succeeds the close is registered.
- **Let a broken close be a defect.** A close that swallows its problem hides a
  leak; Graft keeps cleanup defects in the `Cause`.

## Wrap promises and callbacks

Choose the constructor by what a rejection means:

| The code…                                   | Use                                 | A failure becomes      |
| ------------------------------------------- | ----------------------------------- | ---------------------- |
| Can reject in normal operation (I/O)        | `Effect.tryPromise({ try, catch })` | Your tagged error      |
| Rejects only when there is a bug            | `Effect.promise`                    | A defect               |
| Can throw synchronously in normal operation | `Effect.try({ try, catch })`        | Your tagged error      |
| Calls back instead of returning a promise   | `Effect.callback`                   | What you `resume` with |

```ts title="forecast.ts"
import { Effect, Schema } from "effect"

// A promise-based client library; this one is always offline.
const weatherApi = {
	today: (city: string, options: { signal: AbortSignal }): Promise<string> =>
		Promise.reject(new Error(`No route to the weather service for ${city}`)),
}

export class ForecastFailed extends Schema.TaggedError<
	ForecastFailed,
	{ readonly brand: unique symbol }
>()("ForecastFailed", { city: Schema.String, cause: Schema.Defect() }) {}

export const today = (city: string) =>
	Effect.tryPromise({
		try: (signal) => weatherApi.today(city, { signal }),
		catch: (cause) => ForecastFailed.make({ city, cause }),
	})
```

- **Pass the `signal` on.** Effect aborts it when the fiber is interrupted, as
  when the fork stops. A promise that ignores it runs on after the fork is gone.
- **Give `catch` a tagged error.** Without `catch`, `Effect.tryPromise` fails
  with `UnknownError`, which does not tell callers what failed. Keep the
  original in `cause`.

## Expected failures and defects

A failure a caller can act on is **expected**: a tagged error in the effect's
error type. A failure that means the code is wrong is a **defect**.

| Situation                                           | Make it                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Not found, unavailable, rate limited, invalid input | A tagged error class, such as `Schema.TaggedError`                      |
| A library error the caller should handle            | Your own tagged error with the library error in `cause`                 |
| A broken invariant, an impossible branch            | A defect: `Effect.die`, or `Effect.orDie` on an error nobody can handle |

Error types are part of a service's or event's contract: keep them precise, not
`unknown`. Task errors join the plugin's type; see
[Task errors in types](../../plugins/#task-errors-in-types).

## Recover where you can act

Catch an error where you can act on it; let the rest travel up:

```ts import.meta.vitest name="best-practices/effect: recover where you can act"
import { Cause, Effect } from "effect"

import { today } from "./forecast.ts"

const answer = (city: string) =>
	Effect.catchTag(today(city), "ForecastFailed", (error) =>
		Effect.as(
			Effect.logWarning("Forecast lookup failed", Cause.fail(error)),
			"Weather is unavailable right now.",
		),
	)

await Effect.runPromise(answer("Oslo")) // => "Weather is unavailable right now."
```

| Where the failure happens                         | Recover by                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A call that answers someone (handler, request)    | Answering with a fallback, as above                                                                       |
| One iteration of a background loop                | Catching inside the task, before `Plugin.fork`; see [When a task fails](../../plugins/#when-a-task-fails) |
| A call that can succeed if repeated               | `Effect.retry`; see [Let the fork fail and retry](#let-the-fork-fail-and-retry)                           |
| The fork's own state (connection lost, bad setup) | Not catching it: let the fork fail                                                                        |

| Rule                                                           | Pitfall it avoids                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Catch by tag with `Effect.catchTag`.                           | Other errors stay in the type, visible to callers, instead of being handled by accident.                                 |
| Log the `Cause`, not `error.message`.                          | The log keeps the error's fields, stack and any defects beside it. See [Log the cause](../observability/#log-the-cause). |
| Do not ignore or log-and-continue to keep a broken part alive. | The fork stays `Active` while doing nothing. A failed fork is visible, cleaned up and can be retried.                    |
| Do not catch defects with `Effect.catchCause` to keep running. | A defect is a bug; recovering from it keeps the bug running on corrupt state.                                            |

## Let the fork fail and retry

A failure in `apply` or a task
[fails the fork](../../plugins/#failures-and-retries). Choose between retrying
one call and retrying the fork:

|           | `Effect.retry` around a call | The plugin's `retry` option                                 |
| --------- | ---------------------------- | ----------------------------------------------------------- |
| Repeats   | One operation                | All of `apply`, with fresh resources and tasks              |
| State     | Kept                         | Released; the next attempt starts clean                     |
| Consumers | Do not notice                | Services are withdrawn; consumers restart or wait `Pending` |

```ts
import { Effect, Schedule, Scope } from "effect"

import { Plugin } from "@graftland/graft"

interface Session {
	readonly next: Effect.Effect<string, Error>
}
declare const connect: Effect.Effect<Session, Error, Scope.Scope>
declare const publish: (item: string) => Effect.Effect<void>

const feed = Plugin.make({
	name: "app/feed",
	retry: Schedule.spaced("10 seconds"),
	apply: () =>
		Effect.gen(function* () {
			const session = yield* connect
			yield* session.next.pipe(
				Effect.retry({ times: 3, schedule: Schedule.spaced("200 millis") }),
				Effect.flatMap(publish),
				Effect.forever,
				Plugin.fork,
			)
		}),
})
```

A failed read is retried on the same session; a failed `connect`, or a read that
keeps failing, fails the fork, which reconnects on the plugin's schedule.

- Do not use `retry` to wait for a service; `inject` keeps the fork `Pending`.
- Pick the plugin's schedule by
  [Retry flaky resources](../production/#retry-flaky-resources).

## Background work and concurrency

Every fiber needs an owner that ends it and sees it fail; in a plugin, that
owner is the fork.

| Need                                             | Use                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A loop or listener that runs while the fork runs | `Plugin.fork`                                                                               |
| Several steps at once, waiting for all of them   | `Effect.all` or `Effect.forEach` with `concurrency`                                         |
| A sequence of values                             | A `Stream`, consumed in a `Plugin.fork` task                                                |
| Work handed from callers to one worker           | A `Queue` created in `apply`, drained by a `Plugin.fork` task                               |
| Values broadcast to every subscriber             | A `PubSub` created in `apply` and closed with `PubSub.shutdown`                             |
| State shared by the fork's tasks and services    | A `Ref` created in `apply`                                                                  |
| Tasks keyed by ID that replace each other        | A `FiberMap` created in `apply`, with `Plugin.fork(FiberMap.join(map))` to surface failures |

```ts
import { Context, Effect, Queue } from "effect"

import { Graft, Plugin } from "@graftland/graft"

interface Mail {
	readonly to: string
	readonly text: string
}
declare const deliver: (mail: Mail) => Effect.Effect<void, Error>

class Mailer extends Context.Service<
	Mailer,
	{ readonly send: (mail: Mail) => Effect.Effect<void> }
>()("app/Mailer") {}

const mailer = Plugin.make({
	name: "app/mailer",
	apply: () =>
		Effect.gen(function* () {
			const outbox = yield* Queue.bounded<Mail>(100)
			yield* Queue.take(outbox).pipe(
				Effect.flatMap(deliver),
				Effect.forever,
				Plugin.fork,
			)
			yield* Graft.provide(Mailer, {
				send: (mail) => Effect.asVoid(Queue.offer(outbox, mail)),
			})
		}),
})
```

Callers of `send` only enqueue. Delivery runs in the mailer's own task: it stops
with the mailer, and its failures fail the mailer, not the caller.

| Avoid                                                      | Because                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Effect.forkChild`                                         | The fiber is interrupted as soon as `apply` returns, and the interruption does not fail the plugin, so the work silently stops. |
| `Effect.forkScoped`, `Effect.forkDetach`, `Effect.runFork` | Graft never sees the fiber fail, and the last two outlive the fork. See [Background tasks](../../plugins/#background-tasks).    |
| Forking from a service method                              | The method runs in the caller's fiber. Start the worker in `apply` and hand it work through a `Queue`.                          |

## Timers and time

Raw timers outlive the fork, ignore interruption and cannot be driven by
`TestClock` (see [Control time](../testing/#control-time)). Use the Effect
equivalent:

| Instead of                    | Use                                                                     |
| ----------------------------- | ----------------------------------------------------------------------- |
| `setTimeout(work, ms)`        | `Plugin.fork(Effect.delay(work, ms))`, or `Effect.sleep` inside a task  |
| `setInterval(work, ms)`       | `Plugin.fork(Effect.repeat(work, schedule))`, or `Stream.tick`          |
| A pause, or a steady rate     | `Schedule.spaced` waits after each run; `Schedule.fixed` keeps the rate |
| A promise raced with a timer  | `Effect.timeout`                                                        |
| `Date.now()`, `Math.random()` | `Clock.currentTimeMillis`, `Random.next`                                |

## Validate at the boundary

Decode outside data once, where it enters, and pass typed values inside:

| Input                           | Decode with                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| Plugin config                   | The `config` schema; see [Config decoding](../../plugins/#config-decoding)                |
| Request bodies, messages, files | `Schema.decodeUnknownEffect(schema)`; catch `SchemaError` where you answer the sender     |
| JSON text                       | `Schema.fromJsonString(schema)` instead of `JSON.parse`                                   |
| Secrets                         | `Schema.RedactedFromValue`; see [Types and secrets](../../config-file/#types-and-secrets) |

Inside, keep values immutable: `Option` instead of `null`, `Data` classes that
compare by value, a `HashMap` in a `Ref` instead of a mutable `Map`, and
`readonly` arrays and fields.

## Dependencies in the type

Requirements belong in the effect's type, where the compiler checks them:

| Need                                     | Satisfy it with                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A service another plugin publishes       | `inject`; see [Dependencies](../../plugins/#dependencies)                                                |
| A service that lives as long as the host | An environment layer; see [Services from the environment](../../services/#services-from-the-environment) |
| A setting that follows the caller        | A `Context.Reference` and an [intercept](../../intercepts/)                                              |

- **No requirements in service methods.** Read dependencies in `apply` and
  capture them, as `mailer` captures its queue; a requirement left in a method's
  type must be met by every caller. Only `Context.Reference` settings meant to
  [follow the caller](../../intercepts/#settings-that-follow-the-caller) are
  read there.
- **No module-level singletons, `any` or type assertions.** They hide the
  requirements the compiler checks.
