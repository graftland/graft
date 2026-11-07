import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Plugin } from "@graftland/graft"

import { Priority } from "./port"

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
export const Description = Schema.Struct({
	name: Schema.String,
	overlap: Schema.Boolean,
	provides: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			operations: Schema.Array(Plugin.OperationIdentity),
		}),
	),
})
export const endpoint = "@graftland/plugin-remote/control"
export const make = <C extends Schema.Top>(cause: C) =>
	RpcGroup.make(
		Rpc.make("Describe", { success: Description, error: cause }),
		Rpc.make("Ready", { success: Schema.Array(Schema.String), error: cause }),
		Rpc.make("Probe", {
			payload: { name: Schema.NonEmptyString },
			error: cause,
		}),
		Rpc.make("Serve", {
			payload: { input: Schema.Json },
			error: cause,
		}),
		Rpc.make("Events", { success: Event, stream: true }),
		Rpc.make("Stop", { error: cause }),
	)
		.annotateRpcs(Priority, "control")
		.add(
			Rpc.make("Logs", { success: LogEvent, stream: true }).annotate(
				Priority,
				"log",
			),
		)
