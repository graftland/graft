import { Graft, Plugin } from "@graftland/graft"
import { Effect, Schema } from "effect"
import { Authenticator } from "../../Auth"

export default Plugin.make({
	name: "remote-none-authenticator",
	config: Schema.Struct({
		identity: Schema.String.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed("anonymous")),
		),
	}),
	apply: (config) => Graft.provide(Authenticator, { _tag: "None", ...config }),
})
