import { Cause, Effect, Option, Schema } from "effect"

import type { Command, Report, UnitEvent } from "@graftland/graft/Kernel"

import * as Calls from "./callFrames"
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
const MemberIdentity = {
	unit: Schema.String,
	incarnation: Schema.String,
	observer: Schema.String,
	member: Schema.String,
	term: Schema.Int,
	generation: Schema.Int,
}
const MemberEvidence = Schema.Union([
	Schema.TaggedStruct("MemberReady", MemberIdentity),
	Schema.TaggedStruct("MemberFailed", {
		...MemberIdentity,
		cause: Schema.Json,
	}),
	Schema.TaggedStruct("MemberStopped", {
		...MemberIdentity,
		cause: Schema.Json,
		cleanup: Schema.Literals(["Unknown", "Completed", "Failed"]),
	}),
])
const RecordingEvidence = Schema.Union([
	Schema.TaggedStruct("RecorderRegistered", {
		unit: Schema.String,
		incarnation: Schema.String,
		recorder: Schema.String,
		recovered: Schema.optionalKey(Wire.Recovered),
	}),
	Schema.TaggedStruct("RecordAcknowledged", {
		unit: Schema.String,
		incarnation: Schema.String,
		record: Schema.String,
		content: Schema.String,
	}),
])
export const Outgoing = Schema.Union([
	Schema.TaggedStruct("CallEvidence", {
		event: Schema.Struct({
			unit: Schema.String,
			incarnation: Schema.String,
			observer: Schema.String,
			message: Wire.CallMessage,
		}),
	}),
	Schema.TaggedStruct("Reply", {
		command: Schema.String,
		result: Wire.Report,
	}),
	Schema.TaggedStruct("Evidence", {
		event: Schema.Union([Evidence, MemberEvidence, RecordingEvidence]),
	}),
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
	if (event._tag === "CallObserved")
		return {
			_tag: "CallEvidence",
			event: { ...event, message: yield* Calls.encode(event.message) },
		}
	if (event._tag === "UnitProgress") return { _tag: "Evidence", event }
	if (
		event._tag === "RecorderRegistered" ||
		event._tag === "RecordAcknowledged"
	)
		return { _tag: "Evidence", event }
	if (event._tag === "MemberReady") return { _tag: "Evidence", event }
	if (event._tag === "MemberFailed" || event._tag === "MemberStopped") {
		const cause = yield* Schema.encodeEffect(Wire.Cause)(event.cause)
		return {
			_tag: "Evidence",
			event:
				event._tag === "MemberStopped"
					? { ...event, cause, cleanup: event.cleanup._tag }
					: { ...event, cause },
		}
	}
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
	frame: Extract<Outgoing, { _tag: "Evidence" | "CallEvidence" }>,
): Effect.fn.Return<UnitEvent, Schema.SchemaError> {
	if (frame._tag === "CallEvidence")
		return {
			_tag: "CallObserved",
			...frame.event,
			message: yield* Calls.decode(frame.event.message),
		}
	const e = frame.event
	if (e._tag === "MemberReady") return e
	if (e._tag === "RecorderRegistered" || e._tag === "RecordAcknowledged")
		return e
	if (e._tag === "MemberFailed" || e._tag === "MemberStopped") {
		const cause = yield* Schema.decodeEffect(Wire.Cause)(e.cause)
		return e._tag === "MemberStopped"
			? {
					...e,
					cause,
					cleanup:
						e.cleanup === "Completed"
							? { _tag: "Completed" }
							: e.cleanup === "Failed"
								? { _tag: "Failed", cause }
								: { _tag: "Unknown" },
				}
			: { ...e, cause }
	}
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
