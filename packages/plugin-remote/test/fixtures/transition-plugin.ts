import { Cause, Deferred, Effect, FileSystem, Ref, Schedule } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config, Integration, service } from "./transition-contract"

export default Plugin.make({
	name: "independent-integration",
	config,
	provides: [service],
	overlap: true,
	inject: [FileSystem.FileSystem],
	apply: Effect.fnUntraced(function* ({ value, broken, release }) {
		const released = yield* Deferred.make<void>()
		const fs = yield* FileSystem.FileSystem
		const crashed = yield* Deferred.make<void>()
		const held = yield* Ref.make(0)
		const finalizing = yield* Ref.make(false)
		yield* Plugin.probe(
			"health",
			broken === "probe"
				? Effect.failCause(
						Cause.combine(
							Cause.fail("Probe failed"),
							Cause.die("Probe defect"),
						),
					)
				: Effect.void,
		)
		yield* Plugin.fork(
			Deferred.await(crashed).pipe(
				Effect.andThen(Effect.fail("Candidate crashed")),
			),
		)
		if (broken === "stop") yield* Effect.addFinalizer(() => Effect.never)
		if (broken === "serve") return yield* Effect.fail("Serving failed")
		if (broken === "ready") return yield* Effect.never
		yield* Graft.provide(Integration, {
			read: Effect.gen(function* () {
				return {
					value,
					held: yield* Ref.get(held),
					finalizing: yield* Ref.get(finalizing),
				}
			}),
			hold: Ref.update(held, (n) => n + 1).pipe(
				Effect.andThen(
					release === undefined
						? Deferred.await(released)
						: fs.exists(release).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("5 millis"),
									until: (exists) => exists,
								}),
								Effect.orDie,
							),
				),
				Effect.as(value),
			),
			release: Effect.asVoid(Deferred.succeed(released, undefined)),
			respondThenBlock: Effect.addFinalizer(() =>
				Ref.set(finalizing, true).pipe(Effect.andThen(Effect.never)),
			).pipe(Effect.as(value)),
			crash: Effect.asVoid(Deferred.succeed(crashed, undefined)),
		})
	}),
})
