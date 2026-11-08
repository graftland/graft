import { Array, Record, type Schema } from "effect"

import type {
	ArtifactData,
	BindingDeclaration,
	ConfigurationModule,
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
const artifact = (value: ArtifactData): ArtifactData =>
	Object.freeze({
		...value,
		identity: Object.freeze({ ...value.identity }),
	})
const configuration = (value: ConfigurationModule): ConfigurationModule =>
	Object.freeze({
		...value,
		artifact: artifact(value.artifact),
		options: json(value.options),
	})
export const target = (value: Target): Target =>
	Object.freeze({
		...value,
		...(value.deployment === undefined
			? {}
			: {
					deployment: Object.freeze({
						...value.deployment,
						...(value.deployment.environment === undefined
							? {}
							: {
									environment: Object.freeze(
										Array.map(value.deployment.environment, configuration),
									),
								}),
						...(value.deployment.contractArtifact === undefined
							? {}
							: {
									contractArtifact: Object.freeze({
										...value.deployment.contractArtifact,
										identity: Object.freeze({
											...value.deployment.contractArtifact.identity,
										}),
									}),
								}),
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
		...(value.inspectionData === undefined
			? {}
			: { inspectionData: json(value.inspectionData) }),
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
					...(value.value.environmentModules === undefined
						? {}
						: {
								environmentModules: Object.freeze(
									Array.map(value.value.environmentModules, configuration),
								),
							}),
					input: json(value.value.input),
				}),
			}
		case "Started":
			return {
				...value,
				value: description(value.value),
				...(value.endpoint === undefined
					? {}
					: { endpoint: Object.freeze({ ...value.endpoint }) }),
			}
		case "Described":
			return { ...value, value: description(value.value) }
		default:
			return value
	}
}
