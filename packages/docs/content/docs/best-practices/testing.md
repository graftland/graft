---
title: Testing
description:
  Test plugins and whole applications with @effect/vitest, without sleeps or
  state shared between tests.
---

A Graft test is an Effect that `@effect/vitest` runs against a runtime of its
own. It loads plugins with `Graft.plugin`, waits on explicit signals, and checks
what happened, including after the plugins stop.

## Set up a test

The examples test `welcome`, a plugin that sends one mail when it starts:

```ts title="welcome.ts"
import { Context, Effect, Schedule, Schema } from "effect"

import { Plugin } from "@graftland/graft"

export class MailRejected extends Schema.TaggedError<
	MailRejected,
	{ readonly brand: unique symbol }
>()("MailRejected", { to: Schema.String }) {}

export class Mailer extends Context.Service<
	Mailer,
	{ readonly send: (to: string) => Effect.Effect<void, MailRejected> }
>()("app/Mailer") {}

export const welcome = Plugin.make({
	name: "app/welcome",
	config: Schema.Struct({ to: Schema.String }),
	inject: [Mailer],
	retry: Schedule.spaced("1 second"),
	apply: ({ to }) =>
		Effect.gen(function* () {
			const mailer = yield* Mailer
			yield* mailer.send(to)
		}),
})
```

Each test goes through `run`, which gives it a runtime of its own:

```ts title="run.ts"
import { Effect, Layer, type Scope } from "effect"

import { Graft } from "@graftland/graft"

export const run = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))
```

A test provides what the plugin needs, loads it and checks what happened:

```ts
import { Array, Effect, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

it.effect("sends one mail on start", () =>
	Effect.gen(function* () {
		const outbox = yield* Ref.make<ReadonlyArray<string>>([])
		yield* Graft.provide(Mailer, {
			send: (to) => Ref.update(outbox, Array.append(to)),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		yield* fork.await
		const sent = yield* Ref.get(outbox)
		assert.deepStrictEqual(sent, ["alice@example.com"])
	}).pipe(run),
)
```

| Part                                                                  | Why                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Layer.fresh(Graft.layer)`                                            | Builds a new runtime even where layers are memoized, so services, fork IDs and logs never leak from one test to another.                  |
| `Effect.scoped`                                                       | Unloads every plugin the test loaded. A cleanup failure is raised as a defect and fails the test.                                         |
| `it.effect`                                                           | Runs on `TestClock`: time moves only when the test moves it. See [Control time](#control-time).                                           |
| `it.live`                                                             | Runs on the real clock, for real servers, child processes and workers.                                                                    |
| [Environment services](../../services/#services-from-the-environment) | `Layer.provideMerge(Layer.fresh(Graft.layer), NodeServices.layer)`. The test body sees them too, and they never leave a plugin `Pending`. |
| Test data                                                             | Create `Ref`s, `Deferred`s and fakes inside the test. Module-level ones are shared by every test.                                         |

`Mailer` here is a **fake**: it records calls in a `Ref`. To fail, a fake
returns the typed error the real service declares, such as
`MailRejected.make({ to })`.

| Publish the fake with                                    | When                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `Graft.provide` in the test body                         | It stays for the whole test, and is withdrawn when the runtime closes. |
| `Plugin.service(Mailer, Effect.succeed(fake), { name })` | The test unloads or replaces it, to watch consumers stop and wait.     |
| The environment                                          | The real service comes from the environment too.                       |

## Wait for a state

This helper waits until a fork first reaches a given
[state](../../lifecycle/#fork-states). Every other way to wait is in
[`await`, `stable` and `state`](../../fork-handle/#await-stable-and-state).

```ts title="reach.ts"
import { Effect, Stream } from "effect"

import type { Fork } from "@graftland/graft"

export const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap((state) => Effect.fromOption(state)),
	)
```

| Pitfall                                                                                                 | Instead                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Expecting `Active` after `fork.await`. It returns at `Pending` too, even just after the provider loads. | Assert the state, or `reach(fork, "Active")`.                                   |
| Sleeping, or looping on `Effect.yieldNow`, until something happens.                                     | Wait on a state, a [`Deferred`](#coordinate-with-a-deferred) or `loader.ready`. |
| Asserting `Pending` on a consumer right after its provider's `dispose`.                                 | `dispose` returns once the consumers have stopped. `reach(fork, "Pending")`.    |

## Assert a failure

A fake that returns its typed error makes `welcome` fail.

| To check                              | Use                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| The typed error                       | `Effect.flip(fork.await)`. A defect is not flipped; it fails the test.                  |
| Defects, or several failures together | `Effect.exit(fork.await)`, then read the `Cause`.                                       |
| The failure the fork keeps            | `reach(fork, "Failed")`, then its `cause`.                                              |
| A config that does not decode         | `Effect.flip(fork.await)` gives a `SchemaError`.                                        |
| Failures while unloading              | `Effect.flip(fork.dispose)` gives `Fork.CleanupError`; its `cause` keeps the originals. |

## Record what happened

A **journal** is a `Ref` of events that plugins append to. To check what
stopping did, close an inner scope and assert after it; the runtime is still
open:

```ts
import { Array, Effect, Ref, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { run } from "./run.ts"

it.effect("restarts on a new config", () =>
	Effect.gen(function* () {
		const journal = yield* Ref.make<ReadonlyArray<string>>([])
		const record = (event: string) => Ref.update(journal, Array.append(event))
		const echo = Plugin.make({
			name: "app/echo",
			config: Schema.Struct({ text: Schema.String }),
			apply: ({ text }) =>
				Effect.acquireRelease(record(`start ${text}`), () =>
					record(`stop ${text}`),
				),
		})
		yield* Effect.scoped(
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(echo, { text: "a" })
				yield* fork.await
				yield* fork.update({ text: "b" })
				yield* fork.await
			}),
		)
		const entries = yield* Ref.get(journal)
		assert.deepStrictEqual(entries, ["start a", "stop a", "start b", "stop b"])
	}).pipe(run),
)
```

- `fork.update` and `fork.restart` do not wait for the
  [restart](../../fork-handle/#update-and-restart). The next `fork.await` waits
  for the new activation.
- A plugin that [updates in place](../../plugins/#update-in-place) records no
  stop and start when it accepts the change. That difference is what to assert.
- With several plugins, wait for each before loading the next, or their start
  order is not fixed. Their stop order follows
  [Ownership and stop order](../../lifecycle/#ownership-and-stop-order).

## Control time

`it.effect` installs `TestClock` from `effect/testing`. `TestClock.adjust` runs
timers and retry schedules at once:

```ts
import { Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { reach } from "./reach.ts"
import { run } from "./run.ts"
import { Mailer, MailRejected, welcome } from "./welcome.ts"

it.effect("retries until the mail goes out", () =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0)
		yield* Graft.provide(Mailer, {
			send: (to) =>
				Effect.flatMap(
					Ref.updateAndGet(attempts, (n) => n + 1),
					(n) => (n < 3 ? MailRejected.make({ to }) : Effect.void),
				),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		const error = yield* Effect.flip(fork.await)
		assert.strictEqual(error._tag, "MailRejected")
		yield* TestClock.adjust("2 seconds")
		yield* reach(fork, "Active")
		const count = yield* Ref.get(attempts)
		assert.strictEqual(count, 3)
	}).pipe(run),
)
```

- Bring the code to the point where it sleeps before you adjust; here, the first
  failure. A sleep that starts after the adjustment counts from the new time.
- One `adjust` runs every sleep that falls due, in order, including the ones the
  woken fibers start.
- The warning `A test is using time, but is not advancing the test clock` means
  the code is waiting on the clock. Adjust it, or use `it.live` for real I/O.

## Coordinate with a Deferred

To stop a plugin at a point, give it one `Deferred` to signal and another to
wait on. While it waits at the gate, the test can inspect, update, restart or
dispose it, or withdraw a service it uses:

```ts
import { Deferred, Effect, Option, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { reach } from "./reach.ts"
import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

it.effect("is Loading while the mail is sent", () =>
	Effect.gen(function* () {
		const sending = yield* Deferred.make<void>()
		const gate = yield* Deferred.make<void>()
		const signal = Deferred.succeed(sending, undefined)
		yield* Graft.provide(Mailer, {
			send: () => Effect.andThen(signal, Deferred.await(gate)),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		yield* Deferred.await(sending)
		const current = yield* Stream.runHead(fork.state)
		assert.strictEqual(Option.getOrThrow(current)._tag, "Loading")
		yield* Deferred.succeed(gate, undefined)
		yield* reach(fork, "Active")
	}).pipe(run),
)
```

## Collect logs

`Graft.logs` replays recent entries and then stays open. Log a marker and read
up to it:

```ts import.meta.vitest name="testing: collect logs"
import { Array, Effect, Equal, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { run } from "./run.ts"

const messages = Effect.gen(function* () {
	yield* Effect.log("end of log")
	const entries = yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) =>
			Equal.equals(entry.message, ["end of log"]),
		),
	)
	return Array.map(Array.dropRight(entries, 1), (entry) => entry.message)
})

const greeter = Plugin.make({
	name: "app/greeter",
	apply: () => Effect.log("hello"),
})

await Effect.runPromise(
	run(
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter)
			yield* fork.await
			return yield* messages
		}),
	),
) // => [["hello"]]
```

| Rule            | Detail                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| History         | A new subscriber gets only the [recent entries](../../lifecycle/#logs). In a long test, assert on filtered lines.                     |
| Plugin failures | Logged at `Error` level with the full `Cause` in `cause`. The messages are in [What Graft logs](../observability/#what-graft-logs).   |
| Concurrency     | Lines of concurrent plugins interleave. Filter on one plugin's `graft.plugin` annotation, or assert that a sequence appears in order. |

## Test config entries

`Loader.plugin` runs entries kept in memory, and `ModuleResolver.fromRecord`
turns their names into plugins, so no files are needed:

```ts
import { Deferred, Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"

import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

const resolver = ModuleResolver.fromRecord({ welcome })

it.effect("loads welcome from an entry", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<string>()
		yield* Graft.provide(Mailer, {
			send: (to) => Effect.asVoid(Deferred.succeed(sent, to)),
		})
		yield* Graft.plugin(Loader.plugin, [
			{ id: "welcome", name: "welcome", config: { to: "alice@example.com" } },
		])
		const to = yield* Deferred.await(sent)
		assert.strictEqual(to, "alice@example.com")
	}).pipe(run, Effect.provide(resolver)),
)
```

| Rule          | Detail                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Names         | `fromRecord` looks up an entry's `name` exactly, without the [naming conventions](../../config-file/#plugin-names). An unknown name fails with `ModuleNotFound`.                                |
| `Loader`      | The service is published in the registry, not the environment. To edit entries or call `loader.ready`, inject `Loader.Loader` in a probe plugin that hands it to the test through a `Deferred`. |
| Waiting       | An edit returns once it is saved, before the plugins change. Call `loader.ready` before asserting; see [What an edit promises](../../loader-api/#what-an-edit-promises).                        |
| `!env`        | Write `new Entry.Env({ name })` where the file would have `!env`, and supply the variables with `ConfigProvider.fromEnvRecord`.                                                                 |
| The YAML file | Load `Include.Include` with a `graft.yml` written into `fs.makeTempDirectoryScoped()`, and `NodeServices.layer` in the environment.                                                             |

## Test the installed integration

Pack the contract and implementation, install their tarballs into an isolated
consumer, then compile and run against published exports. Do not use workspace
source aliases or private imports.

| Check                     | Evidence                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Healthy upgrade           | One upstream login, unchanged session and activation counts, new responses, old-unit exit, `Accepted`. |
| Failed probe              | `Aborted` with the probe cause; the previous implementation still serves.                              |
| Failed trial and recovery | `Recovered` or `RecoveryFailed`, with the upstream session preserved.                                  |
| Calls during cutover      | An admitted slow call returns the old implementation's response.                                       |
| Repeated upgrades         | Every retired execution unit has exit evidence.                                                        |
| Rejected Loader edit      | Neither the file nor the accepted target changes.                                                      |

Run both direct placements. The
[integration-gateway sample](https://github.com/graftland/graft/tree/main/samples/integration-gateway)
uses a local WebSocket bot server and also exercises `graft start` from the
installed consumer.
