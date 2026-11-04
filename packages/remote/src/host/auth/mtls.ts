import { Plugin, type Graft } from "@graftland/graft"
import { Effect } from "effect"
import { MtlsCredentials } from "../../Auth"

const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	MtlsCredentials,
	Effect.succeed({ prepare: Effect.succeed }),
	{
		name: "remote-mtls-credentials",
	},
)

export default plugin
