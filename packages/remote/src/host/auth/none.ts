import { Plugin, type Graft } from "@graftland/graft"
import { Effect } from "effect"
import { NoCredentials } from "../../Auth"

const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	NoCredentials,
	Effect.succeed({ prepare: Effect.void }),
	{ name: "remote-no-credentials" },
)
export default plugin
