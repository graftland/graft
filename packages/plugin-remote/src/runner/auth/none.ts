import { Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Authenticator } from "../../Auth"

export default Plugin.make({
	name: "@graftland/plugin-remote/runner/auth/none",
	config: Schema.Struct({
		identity: Schema.String.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed("anonymous")),
		),
	}),
	apply: (config) => Graft.provide(Authenticator, { _tag: "None", ...config }),
})
