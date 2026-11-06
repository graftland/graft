import { Plugin } from "@graftland/graft"

import { router } from "./internal/router"

/** Keep the route table and its observable state alive independently of listeners. */
export default Plugin.make({
	name: "@graftland/plugin-http/router",
	apply: () => router(),
})
