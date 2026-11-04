import { Graft, Plugin } from "@graftland/graft"
import { Effect, Schema } from "effect"
import { NoAuthenticator } from "../../Auth"

export default Plugin.make({
	name: "remote-no-authenticator",
	config: Schema.Struct({
		identity: Schema.String.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed("anonymous")),
		),
	}),
	apply: (config) => Graft.provide(NoAuthenticator, config),
})
