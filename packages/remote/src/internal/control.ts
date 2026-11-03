import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Priority } from "./duplex"
import { Identity } from "../Instance"

export const Result = Schema.Union([
	Schema.TaggedStruct("Success", {}),
	Schema.TaggedStruct("Failure", { cause: Schema.Json }),
])
export const Log = Schema.Struct({
	level: Schema.Literals([
		"Fatal",
		"Error",
		"Warn",
		"Info",
		"Debug",
		"Trace",
		"All",
		"None",
	]),
	message: Schema.Defect({ includeStack: true }),
	cause: Schema.Json,
	annotations: Schema.Record(
		Schema.String,
		Schema.Defect({ includeStack: true }),
	),
})
export const Event = Schema.Union([
	Schema.TaggedStruct("Failed", { cause: Schema.Json }),
	Schema.TaggedStruct("Stopped", {}),
	Schema.TaggedStruct("Withdrawing", {}),
])
export const LogEvent = Schema.Union([
	Schema.TaggedStruct("Log", { entry: Log, dropped: Schema.Int }),
	Schema.TaggedStruct("LogsEnded", { dropped: Schema.Int }),
])
export const Control = RpcGroup.make(
	Rpc.make("Load", {
		payload: { input: Schema.Json, instance: Identity },
		success: Result,
	}),
	Rpc.make("Events", { success: Event, stream: true }),
	Rpc.make("Dispose", { success: Result }),
)
	.annotateRpcs(Priority, "control")
	.add(
		Rpc.make("Logs", { success: LogEvent, stream: true }).annotate(
			Priority,
			"log",
		),
	)
