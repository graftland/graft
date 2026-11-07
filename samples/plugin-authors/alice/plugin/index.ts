import { Deferred, Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Rejected, Service, service } from "@alice/conformance-echo-contract"

export default Plugin.make({
	name: "@alice/conformance-echo",
	provides: [service],
	overlap: true,
	apply: Effect.fnUntraced(function* () {
		const entered = yield* Deferred.make<void>()
		const released = yield* Deferred.make<void>()
		yield* Plugin.probe("health", Effect.void)
		yield* Graft.provide(Service, {
			execute: (input) => {
				switch (input.mode) {
					case "ok":
						return Effect.succeed("Echo: " + input.text)
					case "reject":
						return Effect.fail(Rejected.make({ message: "Rejected by alice" }))
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
