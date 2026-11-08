import { Effect } from "effect"

import { Plugin } from "@graftland/graft"

export default Plugin.make({ name: "worker", apply: () => Effect.void })
