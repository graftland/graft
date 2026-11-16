import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Schema,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"
import { useStream } from "../src/rpc/lease.ts"
import { makeJournal, reach, run } from "./utils.ts"

class Ticker extends Context.Service<
	Ticker,
	{ readonly ticks: Stream.Stream<number, string> }
>()("@graftland/graft/test/rpc-lease.test/Ticker") {}

/** A layer whose service holds a resource that is released by the provider. */
const tickerLayer = (
	journal: { readonly record: (event: string) => Effect.Effect<void> },
	ticks: Stream.Stream<number, string>,
) =>
	Layer.effect(
		Ticker,
		Effect.acquireRelease(
			Effect.andThen(
				journal.record("resource:acquired"),
				Effect.succeed(Ticker.of({ ticks })),
			),
			() => journal.record("resource:released"),
		),
	)

describe("stream service lease", () => {
	it.effect(
		"fails with ServiceWithdrawn mid-stream, releasing resources only after the stream stops",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const started = yield* Deferred.make<void>()
				const ticks = yield* Queue.unbounded<number>()
				const mount = yield* Graft.mount(
					tickerLayer(
						journal,
						Stream.fromQueue(ticks).pipe(
							Stream.ensuring(journal.record("stream:stopped")),
						),
					),
				)
				yield* reach(mount, "Active")
				const consuming = yield* Effect.forkScoped(
					Effect.exit(
						Stream.runDrain(
							useStream(Ticker, (ticker) => ticker.ticks).pipe(
								Stream.tap(() =>
									Effect.andThen(
										journal.record("stream:value"),
										Deferred.succeed(started, undefined),
									),
								),
							),
						),
					),
				)
				yield* Queue.offer(ticks, 1)
				yield* Deferred.await(started)
				yield* mount.unmount
				const exit = yield* Fiber.join(consuming)
				if (Exit.isSuccess(exit))
					return yield* Effect.die(
						new Error("stream completed after withdrawal"),
					)
				const error = Cause.squash(exit.cause)
				if (!Schema.is(Graft.ServiceWithdrawn)(error))
					return yield* Effect.die(
						new Error(`unexpected failure: ${String(error)}`),
					)
				assert.strictEqual(error.service, Ticker.key)
				yield* journal.expect([
					"resource:acquired",
					"stream:value",
					"stream:stopped",
					"resource:released",
				])
			}).pipe(run),
	)

	it.effect("releases the lease when the stream ends", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const mount = yield* Graft.mount(
				tickerLayer(
					journal,
					Stream.fromIterable([1, 2, 3]).pipe(
						Stream.ensuring(journal.record("stream:ended")),
					),
				),
			)
			yield* reach(mount, "Active")
			const collected = yield* Stream.runCollect(
				useStream(Ticker, (ticker) => ticker.ticks),
			)
			assert.deepStrictEqual(Array.fromIterable(collected), [1, 2, 3])
			yield* mount.unmount
			yield* journal.expect([
				"resource:acquired",
				"stream:ended",
				"resource:released",
			])
		}).pipe(run),
	)

	it.effect("releases the lease when the downstream interrupts", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const started = yield* Deferred.make<void>()
			const ticks = yield* Queue.unbounded<number>()
			const mount = yield* Graft.mount(
				tickerLayer(
					journal,
					Stream.fromQueue(ticks).pipe(
						Stream.ensuring(journal.record("stream:stopped")),
					),
				),
			)
			yield* reach(mount, "Active")
			const consuming = yield* Effect.forkScoped(
				Stream.runDrain(
					useStream(Ticker, (ticker) => ticker.ticks).pipe(
						Stream.tap(() => Deferred.succeed(started, undefined)),
					),
				),
			)
			yield* Queue.offer(ticks, 1)
			yield* Deferred.await(started)
			yield* Fiber.interrupt(consuming)
			yield* mount.unmount
			yield* journal.expect([
				"resource:acquired",
				"stream:stopped",
				"resource:released",
			])
		}).pipe(run),
	)

	it.effect("relays the values buffered before a stream failure", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const mount = yield* Graft.mount(
				tickerLayer(
					journal,
					Stream.fromIterable([1, 2]).pipe(
						Stream.tap((value) => journal.record(`value:${value}`)),
						Stream.concat(Stream.fail("broken")),
					),
				),
			)
			yield* reach(mount, "Active")
			const exit = yield* Effect.exit(
				Stream.runDrain(useStream(Ticker, (ticker) => ticker.ticks)),
			)
			if (Exit.isSuccess(exit))
				return yield* Effect.die(new Error("stream completed without failing"))
			assert.strictEqual(Cause.squash(exit.cause), "broken")
			yield* mount.unmount
			yield* journal.expect([
				"resource:acquired",
				"value:1",
				"value:2",
				"resource:released",
			])
		}).pipe(run),
	)
})
