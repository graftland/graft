import { Effect, Option, Schema } from "effect"

/** A stable identity chosen by the projection author or operator, independent of mounts. */
export const View = Schema.Struct({
	projection: Schema.NonEmptyString,
	view: Schema.NonEmptyString,
})
export type View = typeof View.Type
export const ProjectionValue = Schema.Struct({
	service: Schema.NonEmptyString,
	operation: Schema.NonEmptyString,
	value: Schema.Json,
})
export type ProjectionValue = typeof ProjectionValue.Type
/** Opaque external presentation data. The projection validates its payload. */
export const Projection = Schema.Struct({
	...View.fields,
	...ProjectionValue.fields,
})
export type Projection = typeof Projection.Type
/** The complete current contents of one logical view, including an empty view. */
export const Publication = Schema.Struct({
	...View.fields,
	values: Schema.Array(ProjectionValue),
})
export type Publication = typeof Publication.Type
export interface Publisher {
	readonly update: (
		values: ReadonlyArray<ProjectionValue>,
	) => Effect.Effect<void, AdmissionRegistrationError>
}
export class ProjectionConflict extends Schema.TaggedError<
	ProjectionConflict,
	{ readonly brand: unique symbol }
>()("ProjectionConflict", View.fields) {
	override get message() {
		return `Logical view ${this.projection}/${this.view} already has a live owner`
	}
}
export class Unapproved extends Schema.TaggedError<
	Unapproved,
	{ readonly brand: unique symbol }
>()("Unapproved", {
	instance: Schema.String,
	reason: Schema.String,
}) {
	override get message() {
		return `Unapproved instance ${this.instance}: ${this.reason}`
	}
}
export class AdmissionRegistrationError extends Schema.TaggedError<
	AdmissionRegistrationError,
	{ readonly brand: unique symbol }
>()("AdmissionRegistrationError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
/** Immutable operator values, never a contract definition. */
export interface Comparison {
	/** Monotonic authorization version for this instance, including removal and recreation. */
	readonly revision: number
	readonly current: Schema.Json
	readonly approved: Option.Option<Schema.Json>
	readonly missing: string
}
/** Comparison runs in the admission transaction. Publication may persist an audit before updating transactional state. */
export interface Authority {
	readonly compare: (
		instance: string,
		attempt: string,
	) => Effect.Effect<Comparison, Unapproved>
	readonly publish: (
		publication: Publication,
	) => Effect.Effect<void, AdmissionRegistrationError>
}
