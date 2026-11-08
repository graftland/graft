import { Cause, Clock, Duration, Effect, Exit, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { waitUntil } from "../src/internal/kernelDeadline"

it.effect(
	"rechecks the clock after an early fractional sleep before reporting deadline evidence (I5, I11)",
	() =>
		Effect.gen(function* () {
			const clock = yield* Clock.Clock
			const now = yield* Ref.make(0)
			const sleeps = yield* Ref.make(0)
			const early: Clock.Clock = {
				...clock,
				sleep: (duration) =>
					Ref.getAndUpdate(sleeps, (n) => n + 1).pipe(
						Effect.flatMap((n) =>
							Ref.update(
								now,
								(value) =>
									value +
									(n === 0
										? Duration.toMillis(duration) - 0.5
										: Duration.toMillis(duration)),
							),
						),
					),
			}
			const observed = yield* waitUntil(Ref.get(now), 1.5).pipe(
				Effect.provideService(Clock.Clock, early),
			)
			assert.equal(observed, 1.5)
			const count = yield* Ref.get(sleeps)
			assert.equal(count, 2)
		}),
)
it.effect(
	"preserves the complete failure when a deadline sleep executor crashes (I1, I5)",
	() =>
		Effect.gen(function* () {
			const clock = yield* Clock.Clock
			const cause = Cause.combine(
				Cause.die("Clock failed"),
				Cause.die("Timer failed"),
			)
			const broken: Clock.Clock = {
				...clock,
				sleep: () => Effect.failCause(cause),
			}
			const actual = yield* waitUntil(Effect.succeed(0), 1.5).pipe(
				Effect.provideService(Clock.Clock, broken),
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(actual))
			if (Exit.isFailure(actual)) assert.deepEqual(actual.cause, cause)
		}),
)
