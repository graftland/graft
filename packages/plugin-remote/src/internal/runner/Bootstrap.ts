import { Schema } from "effect"

import { Identity } from "../../Instance"
import { Limits } from "./model"

export const Bootstrap = Schema.Struct({
	identity: Identity,
	limits: Limits,
})
export type Bootstrap = typeof Bootstrap.Type
