import { Cause, Effect, Option, Schema } from "effect"

import type { Command, Report, UnitEvent } from "@graftland/graft/Kernel"

import * as Wire from "./unitProtocol"

export const Incoming = Schema.Struct({
	owner: Schema.String,
	command: Wire.Command,
})
export type Incoming = typeof Incoming.Type
const Evidence = Schema.Struct({
	_tag: Schema.Literals([
		"Exited",
		"UnitFailed",
		"UnitDisconnected",
		"UnitCleanup",
		"UnitProgress",
		"UnitDiagnostic",
	]),
	unit: Schema.String,
	incarnation: Schema.String,
	observer: Schema.String,
	cause: Schema.optionalKey(Schema.Json),
	stage: Schema.optionalKey(Schema.String),
	cleanup: Schema.optionalKey(
		Schema.Literals(["Unknown", "Completed", "Failed"]),
	),
})
export const Outgoing = Schema.Union([
	Schema.TaggedStruct("Reply", {
		command: Schema.String,
		result: Wire.Report,
	}),
	Schema.TaggedStruct("Evidence", { event: Evidence }),
])
export type Outgoing = typeof Outgoing.Type
export const encodeReport = Effect.fnUntraced(function* (report: Report) {
	return report._tag === "Failed"
		? { ...report, cause: yield* Schema.encodeEffect(Wire.Cause)(report.cause) }
		: report
})
export const encodeEvent = Effect.fnUntraced(function* (
	event: UnitEvent,
): Effect.fn.Return<Outgoing, Schema.SchemaError> {
	if (event._tag === "UnitProgress") return { _tag: "Evidence", event }
	return {
		_tag: "Evidence",
		event: {
			_tag: event._tag,
			unit: event.unit,
			incarnation: event.incarnation,
			observer: event.observer,
			cause: yield* Schema.encodeEffect(Wire.Cause)(event.cause),
			...(event._tag === "Exited" || event._tag === "UnitCleanup"
				? { cleanup: event.cleanup._tag }
				: {}),
		},
	}
})
export const decodeEvent = Effect.fnUntraced(function* (
	frame: Extract<Outgoing, { _tag: "Evidence" }>,
): Effect.fn.Return<UnitEvent, Schema.SchemaError> {
	const e = frame.event
	const token = {
		unit: e.unit,
		incarnation: e.incarnation,
		observer: e.observer,
	}
	if (e._tag === "UnitProgress")
		return { _tag: "UnitProgress", ...token, stage: e.stage ?? "Unknown" }
	const cause =
		e.cause === undefined
			? Cause.empty
			: yield* Schema.decodeEffect(Wire.Cause)(e.cause)
	switch (e._tag) {
		case "UnitFailed":
		case "UnitDisconnected":
		case "UnitDiagnostic":
			return { _tag: e._tag, ...token, cause }
		default:
			return {
				_tag: e._tag,
				...token,
				cause,
				cleanup:
					e.cleanup === "Completed"
						? { _tag: "Completed" }
						: e.cleanup === "Failed"
							? { _tag: "Failed", cause }
							: { _tag: "Unknown" },
			}
	}
})
export const command = (c: Wire.Command): Command => ({
	...c,
	unit: c.token.unit,
	change: c.token.change,
	kind: c.kind,
	dispatched: true,
	participant: "",
	timer: Option.none(),
	status: Option.none(),
	disposition: "Pending",
	report: Option.none(),
})
