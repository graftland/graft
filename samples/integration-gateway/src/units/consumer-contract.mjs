import * as Contract from "@graftland/plugin-remote/Contract"

import { Config, Service } from "./shared.mjs"

export default Contract.make({
	name: "consumer",
	config: Config,
	inject: [Service],
})
