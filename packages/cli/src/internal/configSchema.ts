/** The CLI adds its intercepts to the loader's recursive editor schema. */
import { Array, Record, Schema } from "effect"

import { ConfigSchema } from "@graftland/loader"

import { registrations } from "./intercepts"

const Intercept = Schema.Struct(
	Record.fromEntries(
		Array.map(
			registrations,
			({ key, schema }) => [key, Schema.optionalKey(schema)] as const,
		),
	),
).annotate({
	identifier: "Intercept",
	description:
		"Patches for references, applying to this entry and its descendants.",
})

export const make = (entries?: ReadonlyArray<ConfigSchema.Registration>) =>
	ConfigSchema.make({
		...(entries === undefined ? {} : { entries }),
		intercept: Intercept,
	})
