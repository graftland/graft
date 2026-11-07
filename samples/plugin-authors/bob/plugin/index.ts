import { Deferred, Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Rejected, Service, service } from "@bob/conformance-counter-contract"

export default Plugin.make({
	name: "@bob/conformance-counter",
	provides: [service],
	overlap: true,
	apply: Effect.fnUntraced(function* () {
		const counter = yield* Ref.make(0)
		const entered = yield* Deferred.make<void>()
		const released = yield* Deferred.make<void>()
		yield* Plugin.probe("health", Effect.void)
		yield* Graft.provide(Service, {
			execute: (input) => {
				switch (input.mode) {
					case "ok":
						return Ref.updateAndGet(
							counter,
							(current) => current + input.value,
						).pipe(Effect.map((count) => "Count: " + count))
					case "reject":
						return Effect.fail(Rejected.make({ message: "Rejected by bob" }))
					case "defect":
						return Effect.die("Implementation defect")
					case "wait":
						return Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Deferred.succeed(released, undefined)),
						)
					case "started":
						return Deferred.await(entered).pipe(Effect.as("started"))
					case "released":
						return Deferred.await(released).pipe(Effect.as("released"))
				}
			},
		})
	}),
})
