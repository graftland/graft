/** Configuration definitions; importing this module performs no I/O. */
import { Effect, Schema } from "effect"

import { Entry } from "@graftland/loader"

const milliseconds = Schema.Union([
	Schema.Finite,
	Schema.FiniteFromString,
]).check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))

/** Options supported by Effect's OTLP/HTTP tracer. Durations are milliseconds. */
export const Http = Schema.Struct({
	url: Schema.String.annotate({
		description: "The OTLP/HTTP traces endpoint.",
	}),
	serviceName: Schema.String.annotate({
		description: "The service.name resource attribute.",
	}),
	resource: Schema.Struct({
		serviceVersion: Schema.String.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed("")),
		),
		attributes: Schema.Record(Schema.String, Schema.Json).pipe(
			Schema.withDecodingDefaultKey(Effect.succeed({})),
		),
	}).pipe(
		Schema.withDecodingDefaultKey(
			Effect.succeed({ serviceVersion: "", attributes: {} }),
		),
	),
	headers: Schema.Record(Schema.String, Schema.RedactedFromValue(Schema.String))
		.pipe(Schema.withDecodingDefaultKey(Effect.succeed({})))
		.annotate({
			description: "Redacted HTTP headers; supply credentials with !env.",
		}),
	serialization: Schema.Literals(["json", "protobuf"]).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("json")),
	),
	compression: Schema.Literals(["none", "gzip"]).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("none")),
	),
	exportInterval: milliseconds.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(5000)),
	),
	maxBatchSize: Schema.Union([Schema.Int, Schema.FiniteFromString])
		.check(Schema.isInt(), Schema.isGreaterThan(0))
		.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1000))),
	shutdownTimeout: milliseconds.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(3000)),
	),
})
export type Http = typeof Http.Type

/** Any ordinary plugin that publishes Exporter. */
export const Reference = Schema.Struct({
	name: Schema.String,
	config: Schema.Json.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
})
export type Reference = typeof Reference.Type

/** Choose the HTTP shorthand or an explicit exporter, and the entries to trace. */
export const Config = Schema.Union([
	Schema.Struct({ exporter: Reference, plugins: Entry.Entries }),
	Schema.Struct({ ...Http.fields, plugins: Entry.Entries }),
])
export type Config = typeof Config.Type
