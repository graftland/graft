import { Array, Record, type Schema } from "effect"

import type {
	BindingDeclaration,
	Description,
	Report,
	Target,
} from "./decisionState"

const jsonArray = (value: Schema.Json): value is Schema.JsonArray =>
	Array.isArray(value)
export const json = (value: Schema.Json): Schema.Json =>
	jsonArray(value)
		? Object.freeze(Array.map(value, json))
		: value !== null && typeof value === "object"
			? Object.freeze(Record.map<string, Schema.Json, Schema.Json>(value, json))
			: value
export const target = (value: Target): Target =>
	Object.freeze({
		...value,
		...(value.deployment === undefined
			? {}
			: {
					deployment: Object.freeze({
						...value.deployment,
						artifact: Object.freeze({
							...value.deployment.artifact,
							identity: Object.freeze({
								...value.deployment.artifact.identity,
							}),
						}),
						input: json(value.deployment.input),
						...(value.deployment.runner === undefined
							? {}
							: { runner: Object.freeze({ ...value.deployment.runner }) }),
					}),
				}),
	})
export const values = (
	value: Readonly<Record<string, Schema.Json>>,
): Readonly<Record<string, Schema.Json>> =>
	Object.freeze(Record.map(value, json))

const binding = (value: BindingDeclaration): BindingDeclaration =>
	Object.freeze({
		...value,
		operations: Object.freeze(
			Array.map(value.operations, (o) => Object.freeze({ ...o })),
		),
	})
export const description = (value: Description): Description =>
	Object.freeze({
		...value,
		requires: Object.freeze(Array.map(value.requires, binding)),
		provides: Object.freeze(Array.map(value.provides, binding)),
		probes: Object.freeze(Array.copy(value.probes)),
	})
export const report = (value: Report): Report => {
	switch (value._tag) {
		case "Resolved":
			return {
				...value,
				value: Object.freeze({
					...value.value,
					input: json(value.value.input),
				}),
			}
		case "Started":
		case "Described":
			return { ...value, value: description(value.value) }
		default:
			return value
	}
}
