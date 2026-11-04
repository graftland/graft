import { Plugin, Graft } from "@graftland/graft"
import { Effect, Schema } from "effect"
import { Credentials, NoCredentials } from "../../Auth"

const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	NoCredentials,
	Effect.succeed({ prepare: Effect.void }),
	{ name: "remote-no-credentials" },
)
export { plugin as legacy }
export default Plugin.make({
	name: "remote-none-credentials",
	config: Schema.Struct({}),
	apply: () =>
		Graft.provide(Credentials, {
			kind: "None",
			read: Effect.succeed<{ readonly _tag: "None" }>({ _tag: "None" }),
		}),
})
