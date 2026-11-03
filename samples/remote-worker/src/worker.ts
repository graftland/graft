import { Graft, Plugin } from "@graftland/graft"
import { Effect, String } from "effect"
import process from "node:process"
import { config, Formatter } from "./contract"

export default Plugin.make({
	name: "formatter",
	config,
	apply: ({ prefix }) =>
		Graft.provide(Formatter, {
			format: (text) =>
				Effect.succeed({
					text: prefix + String.toUpperCase(text),
					pid: process.pid,
				}),
		}),
})
