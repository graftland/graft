/** Explicit, schema-checked configuration of references from entry data. */
import { Graft } from "@graftland/graft"
import {
	Array,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Record,
	Schema,
} from "effect"

export class UnregisteredReference extends Schema.TaggedError<
	UnregisteredReference,
	{ readonly brand: unique symbol }
>()("UnregisteredReference", { key: Schema.String }) {}

export class InvalidIntercept extends Schema.TaggedError<
	InvalidIntercept,
	{ readonly brand: unique symbol }
>()("InvalidIntercept", { key: Schema.String, cause: Schema.Unknown }) {}

export interface Registration {
	readonly key: string
	/** Decodes the configured value; it also describes the value in the config file's JSON Schema. */
	readonly schema: Schema.Top
	readonly resolve: (
		input: unknown,
	) => Effect.Effect<Graft.Intercept, InvalidIntercept>
}

/** Decodes a patch, then merges it with the actual reference's outer or default value. */
export const make = <A, P, I>(
	reference: Context.Reference<A>,
	schema: Schema.Codec<P, I>,
	merge: (outer: NoInfer<A>, patch: P) => NoInfer<A>,
): Registration => ({
	key: reference.key,
	schema,
	resolve: (input) =>
		Effect.gen(function* () {
			const patch = yield* Schema.decodeUnknownEffect(schema)(input).pipe(
				Effect.mapError((cause) =>
					InvalidIntercept.make({ key: reference.key, cause }),
				),
			)
			const outer = yield* reference
			const value = merge(outer, patch)
			return Graft.intercept(reference, () => value)
		}),
})

/** Only registered references may be changed by config-file entries. */
export const Registry = Context.Reference<
	HashMap.HashMap<string, Registration>
>("@graftland/loader/Intercept/Registry", {
	defaultValue: () => HashMap.empty(),
})

/** Provide this layer to the graft environment before loading entries. */
export const layer = (registrations: ReadonlyArray<Registration>) =>
	Layer.succeed(
		Registry,
		HashMap.fromIterable(
			Array.map(
				registrations,
				(registration) => [registration.key, registration] as const,
			),
		),
	)

export const resolve = (
	registry: HashMap.HashMap<string, Registration>,
	values: Readonly<Record<string, unknown>>,
) =>
	Effect.suspend(() =>
		Effect.forEach(Record.toEntries(values), ([key, input]) =>
			Effect.gen(function* () {
				const registration = HashMap.get(registry, key)
				if (Option.isNone(registration))
					return yield* UnregisteredReference.make({ key })
				return yield* registration.value.resolve(input)
			}),
		),
	)
