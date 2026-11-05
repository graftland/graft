import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
