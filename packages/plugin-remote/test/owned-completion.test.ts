import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Queue,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import * as Owned from "../src/internal/ownedCalls"
import * as Wire from "../src/internal/unitProtocol"

const grant = {
	key: "ticket",
	session: "session",
	request: "1",
	service: "weather",
	tags: ["Forecast"],
}
it.effect(
	"returns a result while retaining completion until the Graft-owned Scope closes (I9)",
	() =>
		Effect.gen(function* () {
			const reports = yield* Queue.unbounded<Wire.CallMessage>()
			const owner = yield* Owned.make((message) =>
				Queue.offer(reports, message).pipe(Effect.asVoid),
			)
			yield* owner.register(grant)
			const closing = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const result = yield* owner.run(
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Deferred.succeed(closing, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					)
					return 42
				}),
				"ticket",
				"Forecast",
			)
			assert.equal(result, 42)
			yield* Deferred.await(closing)
			const queued = yield* Queue.size(reports)
			assert.equal(queued, 0)
			yield* Deferred.succeed(release, undefined)
			const completion = yield* Queue.take(reports)
			assert.equal(completion._tag, "Complete")
			const pending = yield* owner.pending
			assert.equal(pending, 1)
			yield* owner.ack("ticket")
			const after = yield* owner.pending
			assert.equal(after, 0)
		}).pipe(Effect.scoped),
)
it.effect(
	"cancels owned execution without waiting for its blocked finalizer or dropping its cause (I5, I9)",
	() =>
		Effect.gen(function* () {
			const reports = yield* Queue.unbounded<Wire.CallMessage>()
			const owner = yield* Owned.make((m) =>
				Queue.offer(reports, m).pipe(Effect.asVoid),
			)
			yield* owner.register(grant)
			const started = yield* Deferred.make<void>()
			const closing = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const running = yield* owner
				.run(
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						)
						yield* Deferred.succeed(started, undefined)
						return yield* Effect.never
					}),
					"ticket",
					"Forecast",
				)
				.pipe(Effect.exit, Effect.forkScoped)
			yield* Deferred.await(started)
			yield* owner.cancel("ticket")
			yield* Deferred.await(closing)
			const queued = yield* Queue.size(reports)
			assert.equal(queued, 0)
			yield* Deferred.succeed(release, undefined)
			const report = yield* Queue.take(reports)
			if (report._tag !== "Complete")
				return yield* Effect.die("Expected retained completion")
			const cause = yield* Schema.decodeEffect(Wire.Cause)(report.cause)
			assert.isTrue(Cause.hasInterrupts(cause))
			yield* Fiber.await(running)
		}).pipe(Effect.scoped),
)
it.effect(
	"retains a finalizer defect and resends the same completion until acknowledged (I6, I9)",
	() =>
		Effect.gen(function* () {
			const reports = yield* Queue.unbounded<Wire.CallMessage>()
			const owner = yield* Owned.make((m) =>
				Queue.offer(reports, m).pipe(Effect.asVoid),
			)
			yield* owner.register(grant)
			yield* owner.run(
				Effect.addFinalizer(() => Effect.die("Finalizer defect")).pipe(
					Effect.as(1),
				),
				"ticket",
				"Forecast",
			)
			const first = yield* Queue.take(reports)
			yield* owner.reconcile
			const duplicate = yield* Queue.take(reports)
			assert.deepEqual(duplicate, first)
			if (first._tag !== "Complete")
				return yield* Effect.die("Expected completion")
			const cause = yield* Schema.decodeEffect(Wire.Cause)(first.cause)
			assert.isTrue(Cause.hasDies(cause))
			assert.equal(first.cleanup, "Failed")
		}).pipe(Effect.scoped),
)
it.effect(
	"confirms prevention when cancellation arrives before handler dispatch and rejects duplicate execution (I2, I9)",
	() =>
		Effect.gen(function* () {
			const reports = yield* Queue.unbounded<Wire.CallMessage>()
			const owner = yield* Owned.make((m) =>
				Queue.offer(reports, m).pipe(Effect.asVoid),
			)
			yield* owner.register(grant)
			yield* owner.cancel("ticket")
			const prevented = yield* Queue.take(reports)
			assert.equal(prevented._tag, "Complete")
			const attempted = yield* Effect.exit(
				owner.run(Effect.die("Handler must not start"), "ticket", "Forecast"),
			)
			assert.isTrue(Exit.isFailure(attempted))
		}).pipe(Effect.scoped),
)

it.effect(
	"prevents handler creation when cancellation precedes registration (I2, I5, I9)",
	() =>
		Effect.gen(function* () {
			const reports = yield* Queue.unbounded<Wire.CallMessage>()
			const owner = yield* Owned.make((m) =>
				Queue.offer(reports, m).pipe(Effect.asVoid),
			)
			yield* owner.cancel("ticket")
			yield* owner.register(grant)
			const attempt = yield* Effect.exit(
				owner.run(Effect.succeed(1), "ticket", "Forecast"),
			)
			assert.isTrue(Exit.isFailure(attempt))
			const evidence = yield* Queue.take(reports)
			assert.equal(evidence._tag, "Complete")
		}).pipe(Effect.scoped),
)

it.effect(
	"rejects deferred replies before publishing owned completion (I9, I12)",
	() =>
		Effect.gen(function* () {
			const reports = yield* Queue.unbounded<Wire.CallMessage>()
			const owner = yield* Owned.make((m) =>
				Queue.offer(reports, m).pipe(Effect.asVoid),
			)
			yield* owner.register(grant)
			const deferred = yield* Deferred.make<number>()
			const result = yield* Effect.exit(
				owner.run(Effect.succeed(deferred), "ticket", "Forecast"),
			)
			assert.isTrue(Exit.isFailure(result))
			const report = yield* Queue.take(reports)
			if (report._tag !== "Complete")
				return yield* Effect.die("Expected completion")
			const cause = yield* Schema.decodeEffect(Wire.Cause)(report.cause)
			assert.include(Cause.pretty(cause), "Deferred replies")
		}).pipe(Effect.scoped),
)

it.effect(
	"retains completion and the reporter Cause when delivery fails before acknowledgement (I5, I9)",
	() =>
		Effect.gen(function* () {
			const reports = yield* Queue.unbounded<Wire.CallMessage>()
			const attempt = yield* Ref.make(0)
			const owner = yield* Owned.make((message) =>
				Ref.getAndUpdate(attempt, (n) => n + 1).pipe(
					Effect.flatMap((n) =>
						n === 0
							? Effect.die("Completion delivery failed")
							: Queue.offer(reports, message).pipe(Effect.asVoid),
					),
				),
			)
			yield* owner.register(grant)
			yield* owner.run(Effect.succeed(1), "ticket", "Forecast")
			const failure = yield* Stream.runHead(owner.failures).pipe(
				Effect.flatMap(Effect.fromOption),
			)
			assert.include(Cause.pretty(failure), "Completion delivery failed")
			const pending = yield* owner.pending
			assert.equal(pending, 1)
			yield* owner.reconcile
			const report = yield* Queue.take(reports)
			assert.equal(report._tag, "Complete")
		}).pipe(Effect.scoped),
)
