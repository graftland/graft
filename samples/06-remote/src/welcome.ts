import { Effect } from "effect"

import { Plugin } from "@graftland/graft"

import { Greeter } from "./contract.ts"

export default Plugin.make({
	name: "@graftland/sample-remote/welcome",
	inject: [Greeter],
	apply: Effect.fn("welcome.apply")(function* () {
		const greeter = yield* Greeter
		const greeting = yield* greeter.greet("Alice")
		yield* Effect.log(greeting)
	}),
})
