import { Effect } from "effect"

import { Plugin } from "@graftland/graft"

const quiet = (name) => Plugin.make({ name, apply: () => Effect.void })
export default quiet("inside")
