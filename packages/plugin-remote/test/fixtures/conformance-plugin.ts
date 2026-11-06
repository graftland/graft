import { Deferred, Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import {
	A,
	B,
	config,
	serviceA,
	serviceB,
	type Reader,
} from "./conformance-contract"

const reader = Effect.fnUntraced(function* (broken: boolean) {
	const started = yield* Deferred.make<void>()
	const released = yield* Deferred.make<void>()
	return {
		read: ({ mode }) => {
			if (broken) return Effect.die("Service B failed")
			switch (mode) {
				case "ok":
					return Effect.succeed("ok")
				case "wait":
					return Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(Deferred.succeed(released, undefined)),
					)
				case "started":
					return Deferred.await(started).pipe(Effect.as("started"))
				case "released":
					return Deferred.await(released).pipe(Effect.as("released"))
			}
		},
	} satisfies Reader
})

export default Plugin.make({
	name: "two-services",
	config,
	provides: [serviceA, serviceB],
	apply: Effect.fnUntraced(function* ({ broken }) {
		const first = yield* reader(false)
		const second = yield* reader(broken)
		yield* Graft.provide(A, first)
		yield* Graft.provide(B, second)
	}),
})
