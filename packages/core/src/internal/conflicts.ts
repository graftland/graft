/**
 * Errors surfaced when a mount cannot publish a service.
 */
import { Schema } from "effect"

/** The service could not be published: already provided, provided by a dependent, or stale. */
export class ServiceConflict extends Schema.TaggedError<
	ServiceConflict,
	{ readonly brand: unique symbol }
>()("ServiceConflict", {
	service: Schema.String,
	/** Absent for an existing provision; otherwise explains why this mount cannot publish. */
	reason: Schema.optionalKey(
		Schema.Literals(["SelfDependency", "DependencyCycle", "Invalidated"]),
	),
	realm: Schema.optionalKey(Schema.String),
	mount: Schema.optionalKey(Schema.Finite),
}) {
	override get message(): string {
		return this.reason === undefined
			? `Service "${this.service}" is already provided in this realm`
			: this.reason === "Invalidated"
				? `Cannot provide "${this.service}": the provider's requirements have changed`
				: `Cannot provide "${this.service}": publishing it would rebuild its own provider`
	}
}

/** The service was withdrawn while it was in use. */
export class ServiceWithdrawn extends Schema.TaggedError<
	ServiceWithdrawn,
	{ readonly brand: unique symbol }
>()("ServiceWithdrawn", { service: Schema.String }) {
	override get message(): string {
		return `Service "${this.service}" was withdrawn while in use`
	}
}
