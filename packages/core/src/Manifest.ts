/** Portable publication metadata and metadata-only compatibility diagnostics. */
import {
	Array,
	Effect,
	Option,
	Order,
	Record,
	Result,
	Schema,
	SemVer,
	SemVerRange,
} from "effect"

import * as Plugin from "./Plugin"

export const Identity = Schema.String.check(
	Schema.isPattern(/^\S+@[1-9][0-9]*$/),
)
export const PackageIdentity = Schema.Struct({
	name: Schema.NonEmptyString,
	version: Schema.NonEmptyString,
})
export type PackageIdentity = typeof PackageIdentity.Type
export const DirectoryIdentity = Schema.Struct({
	version: Schema.Literal(1),
	algorithm: Schema.Literal("sha256"),
	digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type DirectoryIdentity = typeof DirectoryIdentity.Type
export const Source = Schema.Struct({
	package: PackageIdentity,
	artifact: DirectoryIdentity,
})
export type Source = typeof Source.Type
export const Operation = Schema.Struct({
	identity: Identity,
	...Source.fields,
})
export type Operation = typeof Operation.Type
export const Placement = Schema.Literals(["Host", "Worker", "Local"])
export type Placement = typeof Placement.Type
export const Requirements = Schema.Struct({
	placements: Schema.Array(Placement).check(Schema.isMinLength(1)),
	filesystem: Schema.Boolean,
	nativeModules: Schema.Boolean,
})
export type Requirements = typeof Requirements.Type
/** The Context service key and the complete operation group bound to it. */
export const Service = Schema.Struct({
	key: Schema.NonEmptyString,
	operations: Schema.Array(Identity),
})
export type Service = typeof Service.Type
export const Services = Schema.Struct({
	required: Schema.Array(Service),
	optional: Schema.Array(Service),
	implements: Schema.Array(Service),
})
export type Services = typeof Services.Type
export const Entry = Schema.Struct({
	implementation: Schema.NonEmptyString,
	contracts: Schema.Array(Schema.NonEmptyString),
	requirements: Requirements,
	probes: Schema.Array(Schema.NonEmptyString),
	services: Services,
	operations: Schema.Array(Operation),
})
export type Entry = typeof Entry.Type
/** A package root or a concrete public subpath; patterns and traversal are not entries. */
export const PublicEntry = Schema.String.check(
	Schema.isPattern(
		/^(?:\.|\.\/[A-Za-z0-9_@-][A-Za-z0-9_@.-]*(?:\/[A-Za-z0-9_@-][A-Za-z0-9_@.-]*)*)$/,
	),
)
export const Manifest = Schema.Struct({
	version: Schema.Literal(1),
	entries: Schema.Record(Schema.String, Entry),
})
export type Manifest = typeof Manifest.Type
export const Package = Schema.Struct({
	...PackageIdentity.fields,
	engines: Schema.Struct({ node: Schema.NonEmptyString }),
	peerDependencies: Schema.Struct({
		effect: Schema.NonEmptyString,
		"@graftland/graft": Schema.NonEmptyString,
	}),
	graft: Manifest,
})
export type Package = typeof Package.Type
export const Host = Schema.Struct({
	node: Schema.NonEmptyString,
	effect: Schema.NonEmptyString,
	graft: Schema.NonEmptyString,
	placement: Placement,
	filesystem: Schema.Boolean,
	nativeModules: Schema.Boolean,
	services: Schema.Array(Service),
	operations: Schema.Array(Operation),
})
export type Host = typeof Host.Type
export interface Selection {
	readonly id: string
	readonly package: Package
	readonly entry: string
}
export const Diagnostic = Schema.Struct({
	code: Schema.Literals([
		"MissingEntry",
		"MissingOperation",
		"ProvenanceConflict",
		"Runtime",
		"Placement",
		"InvalidManifest",
	]),
	entry: Schema.String,
	message: Schema.String,
	providers: Schema.Array(Schema.String),
})
export type Diagnostic = typeof Diagnostic.Type
export class ManifestError extends Schema.TaggedError<
	ManifestError,
	{ readonly brand: unique symbol }
>()("ManifestError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
export interface Declaration {
	readonly service: Plugin.ProvidedContract
	readonly operations: ReadonlyArray<Operation>
}
export const operationId = (operation: Plugin.OperationIdentity) =>
	`${operation.name}@${operation.version}`
/** Own-property lookup also handles arbitrary entry names supplied by embedded callers. */
export const getEntry = (manifest: Manifest, name: string): Entry | undefined =>
	Option.getOrUndefined(Record.get(manifest.entries, name))
const sorted = (values: ReadonlyArray<string>) =>
	Array.sort(Array.dedupe(values), Order.String)

const sameIdentities = (
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
) => {
	const a = sorted(left)
	const b = sorted(right)
	return (
		a.length === b.length &&
		Array.every(a, (value, index) => value === b[index])
	)
}
const satisfies = (provided: Service, required: Service) =>
	provided.key === required.key &&
	Array.every(required.operations, (identity) =>
		provided.operations.includes(identity),
	)

/** Resolves service keys through contract declarations without running the plugin. */
export const derive = Effect.fn("Manifest.derive")(function* (
	plugin: Plugin.Plugin,
	declarations: ReadonlyArray<Declaration>,
) {
	for (const declaration of declarations) {
		const declared = Array.map(declaration.service.operations, operationId)
		const described = Array.map(
			declaration.operations,
			(operation) => operation.identity,
		)
		if (!sameIdentities(declared, described))
			return yield* ManifestError.make({
				message: `Operation provenance disagrees with ${declaration.service.key.key}`,
			})
	}
	const lookup = Effect.fnUntraced(function* (key: string) {
		const found = Array.filter(
			declarations,
			(item) => item.service.key.key === key,
		)
		if (found.length !== 1)
			return yield* ManifestError.make({
				message: `Service ${key} needs exactly one contract declaration; found ${found.length}`,
			})
		return found[0]!
	})
	const required = yield* Effect.forEach(
		Array.filter(plugin.inject, (item) => !Plugin.isOptional(item)),
		(item) => lookup(Plugin.isOptional(item) ? item.key.key : item.key),
	)
	const optional = yield* Effect.forEach(
		Array.filter(plugin.inject, Plugin.isOptional),
		(item) => lookup(item.key.key),
	)
	const provided = yield* Effect.forEach(plugin.provides, (item) =>
		lookup(typeof item.key === "string" ? item.key : item.key.key),
	)
	for (const item of plugin.provides) {
		if (!("operations" in item)) continue
		const declared = yield* lookup(item.key.key)
		if (
			!sameIdentities(
				Array.map(item.operations, operationId),
				Array.map(declared.service.operations, operationId),
			)
		)
			return yield* ManifestError.make({
				message: `Provided operations disagree with the contract for ${item.key.key}`,
			})
	}
	const bindings = (
		items: ReadonlyArray<Declaration>,
	): ReadonlyArray<Service> =>
		Array.sortWith(
			Array.map(items, (item) => ({
				key: item.service.key.key,
				operations: sorted(Array.map(item.operations, (op) => op.identity)),
			})),
			(item) => item.key,
			Order.String,
		)
	const operations = Array.dedupeWith(
		Array.flatMap(
			[...required, ...optional, ...provided],
			(item) => item.operations,
		),
		(a: Operation, b: Operation) =>
			a.identity === b.identity &&
			a.package.name === b.package.name &&
			a.package.version === b.package.version &&
			a.artifact.digest === b.artifact.digest,
	)
	return {
		services: {
			required: bindings(required),
			optional: bindings(optional),
			implements: bindings(provided),
		},
		operations,
	}
})

const diagnostic = (
	code: Diagnostic["code"],
	entry: string,
	message: string,
	providers: ReadonlyArray<string> = [],
): Diagnostic => ({ code, entry, message, providers })
const sourceLabel = (source: Source) =>
	`${source.package.name}@${source.package.version} (sha256-v${source.artifact.version}:${source.artifact.digest})`

/** Reports every conflict, even when conflicting operations are currently optional. */
export const conflicts = (
	entries: ReadonlyArray<{
		readonly id: string
		readonly operations: ReadonlyArray<Operation>
	}>,
): ReadonlyArray<Diagnostic> =>
	Array.flatMap(entries, (entry, index) =>
		Array.flatMap(entry.operations, (operation) => {
			const others = Array.filter(
				Array.flatMap(Array.take(entries, index + 1), (item) =>
					Array.map(item.operations, (op) => ({ id: item.id, op })),
				),
				(other) =>
					other.op.identity === operation.identity &&
					(other.op.package.name !== operation.package.name ||
						other.op.artifact.digest !== operation.artifact.digest),
			)
			return others.length === 0
				? []
				: [
						diagnostic(
							"ProvenanceConflict",
							entry.id,
							`${operation.identity} has conflicting provenance: ${entry.id}: ${sourceLabel(operation)}; ${Array.join(
								Array.map(
									others,
									(other) => `${other.id}: ${sourceLabel(other.op)}`,
								),
								", ",
							)}; select one contract package at one digest for this operation`,
							sorted(Array.map(others, (other) => other.op.package.name)),
						),
					]
		}),
	)

/** Checks a flat selected deployment; the catalog suggests providers but does not enable them. */
export const check = (
	host: Host,
	selected: ReadonlyArray<Selection>,
	catalog: ReadonlyArray<Selection> = [],
): ReadonlyArray<Diagnostic> => {
	const entries = Array.flatMap(selected, (item) => {
		const entry = getEntry(item.package.graft, item.entry)
		return entry === undefined ? [] : [{ ...item, manifest: entry }]
	})
	return [
		...Array.flatMap(selected, (item) =>
			getEntry(item.package.graft, item.entry) === undefined
				? [
						diagnostic(
							"MissingEntry",
							item.id,
							`${item.package.name} has no manifest entry ${item.entry}`,
						),
					]
				: [],
		),
		...conflicts([
			{ id: "host", operations: host.operations },
			...Array.map(entries, (entry) => ({
				id: entry.id,
				operations: entry.manifest.operations,
			})),
		]),
		...Array.flatMap(entries, (entry) => {
			const available = [
				...host.services,
				...Array.flatMap(entries, (other) =>
					other === entry ? [] : other.manifest.services.implements,
				),
			]
			const requirements = entry.manifest.requirements
			const runtime = {
				node: entry.package.engines.node,
				effect: entry.package.peerDependencies.effect,
				graft: entry.package.peerDependencies["@graftland/graft"],
			}
			const identities = sorted(
				Array.flatMap(
					[
						...entry.manifest.services.required,
						...entry.manifest.services.optional,
						...entry.manifest.services.implements,
					],
					(service) => service.operations,
				),
			)
			return [
				...Array.flatMap(identities, (identity) =>
					Array.some(
						entry.manifest.operations,
						(operation) => operation.identity === identity,
					)
						? []
						: [
								diagnostic(
									"InvalidManifest",
									entry.id,
									`${identity} has no contract package provenance; regenerate the manifest`,
								),
							],
				),
				...Array.flatMap(entry.manifest.services.required, (required) => {
					if (Array.some(available, (service) => satisfies(service, required)))
						return []
					const providers = sorted(
						Array.flatMap(catalog, (candidate) => {
							const manifest = getEntry(
								candidate.package.graft,
								candidate.entry,
							)
							return manifest !== undefined &&
								Array.some(manifest.services.implements, (service) =>
									satisfies(service, required),
								)
								? [candidate.package.name]
								: []
						}),
					)
					return [
						diagnostic(
							"MissingOperation",
							entry.id,
							`${entry.id} requires service ${required.key} with operations [${Array.join(required.operations, ", ")}]; ${providers.length > 0 ? `enable a provider: ${Array.join(providers, ", ")}` : "add a package implementing this service and its complete operation set"}`,
							providers,
						),
					]
				}),
				...Array.flatMap(Record.toEntries(runtime), ([name, range]) => {
					const parsed = SemVerRange.parse(range)
					const version = SemVer.parse(host[name])
					return Result.isSuccess(parsed) &&
						Result.isSuccess(version) &&
						SemVerRange.matches(parsed.success, version.success)
						? []
						: [
								diagnostic(
									"Runtime",
									entry.id,
									`${entry.id} requires ${name} ${range}; host has ${host[name]}. Use a compatible runtime or plugin version`,
								),
							]
				}),
				...(!requirements.placements.includes(host.placement)
					? [
							diagnostic(
								"Placement",
								entry.id,
								`${entry.id} supports ${Array.join(requirements.placements, ", ")}, not ${host.placement}; select a supported placement`,
							),
						]
					: []),
				...Array.flatMap(["filesystem", "nativeModules"] as const, (need) =>
					requirements[need] && !host[need]
						? [
								diagnostic(
									"Placement",
									entry.id,
									`${entry.id} requires ${need}; choose a host with that capability`,
								),
							]
						: [],
				),
			]
		}),
	]
}
