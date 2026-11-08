import { Array, HashMap, HashSet, Option, Record, type Schema } from "effect"

import type {
	ArtifactData,
	BindingDeclaration,
	ConfigurationModule,
	DeploymentOperation,
	Description,
	GraphProposal,
	Input,
	MemberDeclaration,
	RealmDeclaration,
	Report,
	Request,
	ResolvedInput,
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
const operation = (value: DeploymentOperation): DeploymentOperation =>
	Object.freeze(
		value._tag === "Remove"
			? { ...value }
			: {
					...value,
					target: target(value.target),
					...(value.colocate === undefined
						? {}
						: { colocate: Object.freeze(Array.copy(value.colocate)) }),
					...(value.placement === undefined
						? {}
						: { placement: Object.freeze({ ...value.placement }) }),
				},
	)
export const input = (value: Input): Input =>
	Object.freeze({
		...value,
		operations: Object.freeze(Array.map(value.operations, operation)),
		...(value.realms === undefined
			? {}
			: { realms: Object.freeze(Array.map(value.realms, realm)) }),
		...(value.budget === undefined
			? {}
			: { budget: Object.freeze({ ...value.budget }) }),
		...(value.requirements === undefined
			? {}
			: {
					requirements: Object.freeze({
						...value.requirements,
						...(value.requirements.probes === undefined
							? {}
							: {
									probes: Object.freeze(Array.copy(value.requirements.probes)),
								}),
					}),
				}),
	})

const binding = (value: BindingDeclaration): BindingDeclaration =>
	Object.freeze({
		...value,
		operations: Object.freeze(
			Array.map(value.operations, (o) => Object.freeze({ ...o })),
		),
	})
export const declaration = (value: MemberDeclaration): MemberDeclaration =>
	Object.freeze({
		...value,
		target: target(value.target),
		placement: Option.map(value.placement, (p) => Object.freeze({ ...p })),
		localProvides: Object.freeze(Array.copy(value.localProvides)),
		localRequires: Object.freeze(
			Array.map(value.localRequires, (entry) => Object.freeze({ ...entry })),
		),
		provides: Object.freeze(Array.map(value.provides, binding)),
		requires: Object.freeze(
			Array.map(value.requires, (entry) =>
				Object.freeze({ ...binding(entry), optional: entry.optional }),
			),
		),
		resources: Object.freeze(
			Array.map(value.resources, (entry) => Object.freeze({ ...entry })),
		),
		colocate: Object.freeze(Array.copy(value.colocate)),
		probes: Object.freeze(Array.copy(value.probes)),
	})
const realm = (value: RealmDeclaration): RealmDeclaration =>
	Object.freeze({ ...value, isolated: HashSet.fromIterable(value.isolated) })
export const proposal = (value: GraphProposal): GraphProposal =>
	Object.freeze({
		members: Object.freeze(Array.map(value.members, declaration)),
		explicit: HashSet.fromIterable(value.explicit),
		removed: HashSet.fromIterable(value.removed),
		realms: Object.freeze(Array.map(value.realms, realm)),
	})
export const resolution = (value: ResolvedInput): ResolvedInput =>
	Object.freeze({
		...value,
		input: json(value.input),
		...(value.environmentModules === undefined
			? {}
			: {
					environmentModules: Object.freeze(
						Array.map(value.environmentModules, configuration),
					),
				}),
	})
export const request = (value: Request): Request =>
	Object.freeze({
		...value,
		...(value.operations === undefined
			? {}
			: { operations: Object.freeze(Array.map(value.operations, operation)) }),
		...(value.member === undefined
			? {}
			: { member: declaration(value.member) }),
		target: target(value.target),
		budget: Object.freeze({ ...value.budget }),
		...(value.realms === undefined
			? {}
			: { realms: Object.freeze(Array.map(value.realms, realm)) }),
		...(value.colocate === undefined
			? {}
			: { colocate: Object.freeze(Array.copy(value.colocate)) }),
		...(value.placement === undefined
			? {}
			: { placement: Object.freeze({ ...value.placement }) }),
		reads: HashMap.fromIterable(value.reads),
		writes: HashSet.fromIterable(value.writes),
		leases: HashSet.fromIterable(value.leases),
		participants: HashSet.fromIterable(value.participants),
		...(value.proposal === undefined
			? {}
			: { proposal: proposal(value.proposal) }),
		...(value.resolution === undefined
			? {}
			: { resolution: resolution(value.resolution) }),
		...(value.description === undefined
			? {}
			: { description: description(value.description) }),
		...(value.probes === undefined
			? {}
			: { probes: Object.freeze(Array.copy(value.probes)) }),
		...(value.identity === undefined
			? {}
			: {
					identity: Object.freeze({
						...value.identity,
						operations: Object.freeze(
							Array.map(value.identity.operations, operation),
						),
						realms: Object.freeze(Array.map(value.identity.realms, realm)),
						budget: Object.freeze({ ...value.identity.budget }),
						probes: Object.freeze(Array.copy(value.identity.probes)),
					}),
				}),
	})
export const description = (value: Description): Description =>
	Object.freeze({
		...value,
		...(value.inspectionData === undefined
			? {}
			: { inspectionData: json(value.inspectionData) }),
		members: Object.freeze(Array.map(value.members, declaration)),
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
				endpoints: HashMap.map(value.endpoints, (endpoint) =>
					Object.freeze({ ...endpoint }),
				),
			}
		case "Described":
			return { ...value, value: description(value.value) }
		default:
			return value
	}
}
