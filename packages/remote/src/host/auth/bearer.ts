import type { Graft, Plugin } from "@graftland/graft"
import { Config, plugin } from "../../internal/auth/tokenCredentials"
export { Config }

const capability: Plugin.Plugin<
	typeof Config.Type,
	typeof Config.Encoded,
	Graft.ServiceConflict
> = plugin("remote-bearer-credentials")
export default capability
