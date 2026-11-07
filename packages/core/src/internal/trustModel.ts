import { Schema } from "effect"

export const Identity = Schema.Struct({
	package: Schema.NonEmptyString,
	digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type Identity = typeof Identity.Type
export const Grant = Schema.Union([
	Schema.TaggedStruct("Http", {
		id: Schema.NonEmptyString,
		origin: Schema.NonEmptyString,
		credential: Schema.optionalKey(Schema.NonEmptyString),
	}),
	Schema.TaggedStruct("Files", {
		id: Schema.NonEmptyString,
		directory: Schema.String.check(Schema.isPattern(/^\//)),
	}),
])
export type Grant = typeof Grant.Type
export const Assignment = Schema.Struct({
	entry: Schema.NonEmptyString,
	artifact: Identity,
	tier: Schema.Literals(["own", "trusted", "untrusted"]),
	grants: Schema.Array(Grant),
	/** Contract module evaluated only inside the sandbox, relative to the captured directory. */
	contractEntry: Schema.optionalKey(Schema.NonEmptyString),
})
export type Assignment = typeof Assignment.Type
export const Policy = Schema.Struct({
	version: Schema.NonEmptyString,
	entries: Schema.Array(Assignment),
})
export type Policy = typeof Policy.Type
/** An external view, never a contract definition or compatibility identity. */
export const Description = Schema.Struct({
	service: Schema.NonEmptyString,
	operation: Schema.NonEmptyString,
	metadata: Schema.Struct({
		name: Schema.NonEmptyString,
		title: Schema.NonEmptyString,
		description: Schema.NonEmptyString,
		readOnlyHint: Schema.Boolean,
		destructiveHint: Schema.Boolean,
		idempotentHint: Schema.Boolean,
		openWorldHint: Schema.Boolean,
		output: Schema.Literals(["json", "void"]),
	}),
})
export type Description = typeof Description.Type
export const Statement = Schema.Struct({
	assignment: Assignment,
	policyVersion: Schema.NonEmptyString,
	descriptions: Schema.Array(Description),
})
export type Statement = typeof Statement.Type
export const Approval = Schema.Struct({
	statement: Statement,
	who: Schema.NonEmptyString,
	at: Schema.Finite,
	/** Explicitly audited exceptions retain the underlying revocation record. */
	overrideRevocations: Schema.Boolean,
})
export type Approval = typeof Approval.Type
export const Approve = Schema.Struct({
	expected: Statement,
	who: Schema.NonEmptyString,
	overrideRevocations: Schema.optionalKey(Schema.Boolean),
})
export type Approve = typeof Approve.Type
export class Unapproved extends Schema.TaggedError<
	Unapproved,
	{ readonly brand: unique symbol }
>()("Unapproved", {
	entry: Schema.String,
	reason: Schema.Literals([
		"MissingApproval",
		"ChangedStatement",
		"Revoked",
		"UnknownArtifact",
		"Closed",
	]),
}) {
	override get message() {
		return `Unapproved entry ${this.entry}: ${this.reason}`
	}
}
export class PolicyError extends Schema.TaggedError<
	PolicyError,
	{ readonly brand: unique symbol }
>()("PolicyError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
