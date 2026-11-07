import { Cause, Effect, Exit, Logger } from "effect"
import { assert, it } from "@effect/vitest"

import { cancelled } from "../src/internal/sandboxCancellation"

for (const mixed of [false, true])
	it.effect(
		`preserves sandbox cancellation with ${mixed ? "complete cleanup logging" : "no error log for pure interruption"}`,
		() => {
			const logs: Array<Cause.Cause<unknown>> = []
			return Effect.gen(function* () {
				const work = mixed
					? Effect.interrupt.pipe(
							Effect.ensuring(Effect.die("Launcher cleanup defect")),
						)
					: Effect.interrupt
				const exit = yield* work.pipe(Effect.catchCause(cancelled), Effect.exit)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
				assert.equal(logs.length, mixed ? 1 : 0)
				if (mixed) {
					assert.include(Cause.pretty(logs[0]!), "Launcher cleanup defect")
					assert.isTrue(Cause.hasInterrupts(logs[0]!))
				}
			}).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make((entry) => {
							logs.push(entry.cause)
						}),
					]),
				),
			)
		},
	)
