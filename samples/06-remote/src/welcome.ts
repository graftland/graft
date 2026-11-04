import { Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { Greeter } from "./contract.ts"

export default Plugin.make({
	name: "welcome",
	inject: [Greeter],
	apply: () =>
		Effect.gen(function* () {
			const greeter = yield* Greeter
			const greeting = yield* greeter.greet("Alice")
			yield* Effect.log(greeting)
		}),
})
