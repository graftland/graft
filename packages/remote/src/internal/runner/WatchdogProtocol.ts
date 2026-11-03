import { Schema } from "effect"

export const Command = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("renew"),
		millis: Schema.Finite.check(Schema.isGreaterThan(0)),
	}),
	Schema.Struct({ kind: Schema.Literal("start") }),
	Schema.Struct({ kind: Schema.Literal("stop") }),
])
export const CommandJson = Schema.fromJsonString(Command)
export const Notice = Schema.Literals(["ready", "start", "stop"])
