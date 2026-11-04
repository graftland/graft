import { Effect } from "effect"
import { Plugin, type Graft } from "@graftland/graft"
import { JwtCredentials } from "../../Auth"
import { prepare } from "../../internal/auth/token"

const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	JwtCredentials,
	Effect.succeed({ prepare }),
	{
		name: "remote-jwt-credentials",
	},
)

export default plugin
