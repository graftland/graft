import { Deferred, Effect } from "effect"

import {
	Rejected,
	Service,
	service,
} from "@graftland/conformance-echo-contract"
import { Graft, Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "@graftland/conformance-echo",
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
						return Effect.fail(
							Rejected.make({ message: "Rejected by first-party" }),
						)
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
