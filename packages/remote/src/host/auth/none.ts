import { Plugin, Graft } from "@graftland/graft"
import { Effect, Schema } from "effect"
import { Credentials } from "../../Auth"

export default Plugin.make({
	name: "remote-none-credentials",
	config: Schema.Struct({}),
	apply: () =>
		Graft.provide(Credentials, {
			kind: "None",
			read: Effect.succeed<{ readonly _tag: "None" }>({ _tag: "None" }),
		}),
})
