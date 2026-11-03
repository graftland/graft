/**
 * Entries describe which plugins to load and how, as plain data that a
 * config file can hold.
 */
import {
	Array as Arr,
	Config,
	Data,
	Effect,
	Predicate,
	Record,
	Schema,
} from "effect"

/** A value read from an environment variable when the entry is loaded (`!env NAME` in YAML). */
export class Env extends Data.TaggedClass("Env")<{ readonly name: string }> {}

export const Entry = Schema.Struct({
	id: Schema.String,
	/** A module specifier or a short plugin name; ignored for groups. */
	name: Schema.String,
	/** The plugin's configuration, or the child entries of a group. */
	config: Schema.optionalKey(Schema.Unknown),
	disabled: Schema.optionalKey(Schema.Boolean),
	group: Schema.optionalKey(Schema.Boolean),
	/** Service keys to wait for before loading the plugin. */
	inject: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Service or event keys to isolate: `true` for a private realm, a string for a shared one. */
	isolate: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Union([Schema.Literal(true), Schema.String]),
		),
	),
	/** Reference values for this plugin and everything below it, merged over the outer ones. */
	intercept: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

export type Entry = typeof Entry.Type

/** Replaces every `Env` in a config value with the variable it names. */
export const resolveEnv = (
	value: unknown,
): Effect.Effect<unknown, Config.ConfigError> => {
	if (value instanceof Env) return Config.String(value.name)
	if (Arr.isArray(value)) return Effect.forEach(value, resolveEnv)
	if (Predicate.isObject(value) && !Predicate.isFunction(value)) {
		return Effect.map(
			Effect.forEach(
				Record.toEntries(value as Record<string, unknown>),
				([key, inner]) =>
					Effect.map(resolveEnv(inner), (resolved) => [key, resolved] as const),
			),
			Record.fromEntries,
		)
	}
	return Effect.succeed(value)
}
