import { Schema } from "effect"

import { ProbeError } from "@graftland/graft/Fork"

export class AlreadyLoaded extends Schema.TaggedError<
	AlreadyLoaded,
	{ readonly brand: unique symbol }
>()("AlreadyLoaded", {}) {}
export class ContractNotFound extends Schema.TaggedError<
	ContractNotFound,
	{ readonly brand: unique symbol }
>()("ContractNotFound", { module: Schema.String }) {
	override get message() {
		return `No remote contract exported by ${this.module}`
	}
}
export class ModuleImportFailed extends Schema.TaggedError<
	ModuleImportFailed,
	{ readonly brand: unique symbol }
>()("ModuleImportFailed", {
	module: Schema.String,
	cause: Schema.Defect({ includeStack: true }),
}) {}
export class ActivationFailed extends Schema.TaggedError<
	ActivationFailed,
	{ readonly brand: unique symbol }
>()("ActivationFailed", {
	detail: Schema.String,
	cause: Schema.optionalKey(
		Schema.Cause(
			Schema.Defect({ includeStack: true }),
			Schema.Defect({ includeStack: true }),
		),
	),
}) {
	override get message() {
		return this.detail
	}
}
export const ChildFailure = Schema.Union([
	ProbeError,
	AlreadyLoaded,
	ContractNotFound,
	ModuleImportFailed,
	ActivationFailed,
])
export type ChildFailure = typeof ChildFailure.Type
