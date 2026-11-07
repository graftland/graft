import { Schema } from "effect"

import { Trust } from "@graftland/graft"

export { Unapproved } from "@graftland/graft/Trust"

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
export const Statement = Schema.Struct({
	assignment: Assignment,
	policyVersion: Schema.NonEmptyString,
	projections: Schema.Array(Trust.Projection),
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
export class PolicyError extends Schema.TaggedError<
	PolicyError,
	{ readonly brand: unique symbol }
>()("PolicyError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
