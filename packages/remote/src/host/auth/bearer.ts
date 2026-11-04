import { Effect } from "effect"
import { Plugin, type Graft } from "@graftland/graft"
import { BearerCredentials } from "../../Auth"
import { prepare } from "../../internal/auth/token"

const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	BearerCredentials,
	Effect.succeed({ prepare }),
	{
		name: "remote-bearer-credentials",
	},
)

export default plugin
