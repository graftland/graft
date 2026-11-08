import { LogLevel, References, Schema } from "effect"

import { Intercept } from "@graftland/loader"

/** References that can be configured by stock CLI entries. */
export const registrations = [
	Intercept.make(
		References.CurrentLogAnnotations,
		Schema.Record(Schema.String, Schema.Unknown).annotate({
			description:
				"Shallowly merges with outer annotations; configured keys win.",
		}),
		(outer, patch) => ({ ...outer, ...patch }),
	),
	Intercept.make(
		References.MinimumLogLevel,
		Schema.Literals(LogLevel.values).annotate({
			description: "Replaces the outer minimum log level.",
		}),
		(_, level) => level,
	),
]
