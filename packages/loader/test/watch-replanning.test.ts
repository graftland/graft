import {
	Cause,
	Deferred,
	Effect,
	Fiber,
	HashSet,
	Option,
	PubSub,
	Ref,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import * as Control from "@graftland/plugin-remote/Control"

import { replanOnBusy } from "../src/internal/watchReplanning"

const concluded = (id: string, cells: ReadonlyArray<string> = []) => ({
	id,
	plan: { reads: HashSet.fromIterable(cells), writes: HashSet.empty<string>() },
	conclusion: Option.some("Accepted"),
})
const busy = (conflicts?: ReadonlyArray<string>) =>
	Control.ControlError.make({
		reason: "Busy",
		cause: Cause.fail("Another Change holds the instance"),
		...(conflicts === undefined ? {} : { conflicts }),
	})
const fixture = Effect.fnUntraced(function* () {
	const events = yield* PubSub.bounded<ReturnType<typeof concluded>>(16)
	const subscribed = yield* Deferred.make<void>()
	const changes = Stream.unwrap(
		Effect.gen(function* () {
			const subscription = yield* PubSub.subscribe(events)
			yield* Deferred.succeed(subscribed, undefined)
			return Stream.fromSubscription(subscription)
		}),
	)
	return { events, changes, subscribed }
})

for (const conflict of ["holding", "instance:integration"])
	it.effect(
		`replans the newest input after ${conflict} concludes without resubmitting while it is held`,
		() =>
			Effect.gen(function* () {
				const f = yield* fixture()
				const rejected = yield* Deferred.make<void>()
				const edited = yield* Deferred.make<void>()
				const input = yield* Ref.make(1)
				const submissions = yield* Ref.make<ReadonlyArray<number>>([])
				const holding = yield* Ref.make(true)
				const attempt = Ref.get(input).pipe(
					Effect.flatMap((revision) =>
						replanOnBusy(
							f.changes,
							Ref.update(submissions, (all) => [...all, revision]).pipe(
								Effect.andThen(Ref.get(holding)),
								Effect.flatMap((held) =>
									held
										? Deferred.succeed(rejected, undefined).pipe(
												Effect.andThen(busy([conflict])),
											)
										: Effect.succeed(revision),
								),
							),
							Deferred.await(edited),
						),
					),
					Effect.repeat({ until: Option.isSome }),
				)
				const worker = yield* attempt.pipe(Effect.forkScoped)
				yield* Deferred.await(rejected)
				yield* PubSub.publish(f.events, {
					...concluded("holding", ["instance:integration"]),
					conclusion: Option.none(),
				})
				yield* TestClock.adjust("2 seconds")
				const before = yield* Ref.get(submissions)
				assert.deepStrictEqual(before, [1])
				yield* PubSub.publish(
					f.events,
					concluded("unrelated", ["instance:other"]),
				)
				yield* TestClock.adjust("2 seconds")
				const afterUnrelated = yield* Ref.get(submissions)
				assert.deepStrictEqual(afterUnrelated, [1])
				// Files are read again after conflict completion, rather than resubmitting prepared input.
				yield* Ref.set(input, 2)
				yield* Ref.set(holding, false)
				yield* PubSub.publish(
					f.events,
					concluded("holding", ["instance:integration"]),
				)
				const result = yield* Fiber.join(worker)

				const after = yield* Ref.get(submissions)

				assert.deepStrictEqual(result, Option.some(2))

				assert.deepStrictEqual(after, [1, 2])
			}).pipe(Effect.scoped),
	)

it.effect(
	"a new edit wakes Busy waiting and replans from the latest input",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const edited = yield* Deferred.make<void>()
			const rejected = yield* Deferred.make<void>()
			const revision = yield* Ref.make(1)
			const submissions = yield* Ref.make<ReadonlyArray<number>>([])
			const worker = yield* Ref.get(revision).pipe(
				Effect.flatMap((value) =>
					replanOnBusy(
						f.changes,
						Ref.update(submissions, (all) => [...all, value]).pipe(
							Effect.andThen(
								value === 1
									? Deferred.succeed(rejected, undefined).pipe(
											Effect.andThen(busy(["holding"])),
										)
									: Effect.succeed(value),
							),
						),
						Deferred.await(edited),
					),
				),
				Effect.repeat({ until: Option.isSome }),
				Effect.forkScoped,
			)
			yield* Deferred.await(rejected)
			yield* Ref.set(revision, 3)
			yield* Deferred.succeed(edited, undefined)
			const result = yield* Fiber.join(worker)

			const after = yield* Ref.get(submissions)

			assert.deepStrictEqual(result, Option.some(3))

			assert.deepStrictEqual(after, [1, 3])
		}).pipe(Effect.scoped),
)

for (const conflicts of [undefined, []])
	it.effect(
		`waits for the next conclusion when conflicts are ${conflicts === undefined ? "missing" : "empty"}`,
		() =>
			Effect.gen(function* () {
				const f = yield* fixture()
				const worker = yield* replanOnBusy(
					f.changes,
					busy(conflicts),
					Effect.never,
				).pipe(Effect.forkScoped)
				yield* Deferred.await(f.subscribed)
				yield* TestClock.adjust("2 seconds")
				assert.isUndefined(worker.pollUnsafe())
				yield* PubSub.publish(f.events, concluded("next"))
				const result = yield* Fiber.join(worker)
				assert.deepStrictEqual(result, Option.none())
			}).pipe(Effect.scoped),
	)

it.effect("does not miss a conclusion delivered before the Busy reply", () =>
	Effect.gen(function* () {
		const f = yield* fixture()
		const result = yield* replanOnBusy(
			f.changes,
			Deferred.await(f.subscribed).pipe(
				Effect.andThen(PubSub.publish(f.events, concluded("holding"))),
				Effect.andThen(busy(["holding"])),
			),
			Effect.never,
		)
		assert.deepStrictEqual(result, Option.none())
	}).pipe(Effect.scoped),
)

it.effect(
	"does not interrupt an admitted submission when another edit arrives",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const admitted = yield* Deferred.make<number>()
			const worker = yield* replanOnBusy(
				f.changes,
				Deferred.await(admitted),
				Effect.void,
			).pipe(Effect.forkScoped)
			yield* Deferred.await(f.subscribed)
			yield* TestClock.adjust("1 second")
			assert.isUndefined(worker.pollUnsafe())
			yield* Deferred.succeed(admitted, 42)
			const result = yield* Fiber.join(worker)
			assert.deepStrictEqual(result, Option.some(42))
		}).pipe(Effect.scoped),
)

it.effect("propagates a control failure instead of treating it as Busy", () =>
	Effect.gen(function* () {
		const failure = Control.ControlError.make({
			reason: "Disconnected",
			cause: Cause.fail("Control closed"),
		})
		const result = yield* replanOnBusy(Stream.never, failure, Effect.void).pipe(
			Effect.flip,
		)
		assert.strictEqual(result, failure)
	}).pipe(Effect.scoped),
)

it.effect(
	"preserves a change-stream failure while waiting for a conflict",
	() =>
		Effect.gen(function* () {
			const failure = Control.ControlError.make({
				reason: "Transport",
				cause: Cause.fail("The change stream disconnected"),
			})
			const result = yield* replanOnBusy(
				Stream.fail(failure),
				busy(["holding"]),
				Effect.never,
			).pipe(Effect.flip)
			assert.strictEqual(result, failure)
		}).pipe(Effect.scoped),
)
