import { Effect, Option, Schema } from "effect"

/** Opaque external presentation data. The owning projection validates its payload. */
export const Projection = Schema.Struct({
	projection: Schema.NonEmptyString,
	service: Schema.NonEmptyString,
	operation: Schema.NonEmptyString,
	value: Schema.Json,
})
export type Projection = typeof Projection.Type
export class Unapproved extends Schema.TaggedError<
	Unapproved,
	{ readonly brand: unique symbol }
>()("Unapproved", {
	entry: Schema.String,
	reason: Schema.String,
}) {
	override get message() {
		return `Unapproved entry ${this.entry}: ${this.reason}`
	}
}
export class RegistrationError extends Schema.TaggedError<
	RegistrationError,
	{ readonly brand: unique symbol }
>()("AdmissionRegistrationError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
/** Immutable operator values, never a contract definition. */
export interface Comparison {
	readonly current: Schema.Json
	readonly approved: Option.Option<Schema.Json>
	readonly missing: string
}
/** Transactional policy decisions must perform no I/O and use only transactional state. */
export interface Authority {
	readonly compare: (
		entry: string,
		candidate: string,
	) => Effect.Effect<Comparison, Unapproved>
	readonly publish: (
		values: ReadonlyArray<Projection>,
	) => Effect.Effect<void, RegistrationError>
}
