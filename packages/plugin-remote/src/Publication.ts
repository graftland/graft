/** Explicit author tooling. Importing this module does not read or import packages. */
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
	Array,
	Cause,
	Effect,
	FileSystem,
	Order,
	Path,
	Record,
	Schema,
	String,
} from "effect"

import { Manifest, Plugin } from "@graftland/graft"

import * as Artifact from "./Artifact"
import * as Contract from "./Contract"

export const EntryInput = Schema.Struct({
	implementation: Manifest.Entry.fields.implementation,
	contracts: Manifest.Entry.fields.contracts,
	requirements: Manifest.Requirements,
	probes: Manifest.Entry.fields.probes,
})
export type EntryInput = typeof EntryInput.Type
export const PackageInput = Schema.Struct({
	...Manifest.PackageIdentity.fields,
	engines: Manifest.Package.fields.engines,
	peerDependencies: Manifest.Package.fields.peerDependencies,
	graft: Schema.Struct({
		version: Schema.Literal(1),
		entries: Schema.Record(Schema.String, EntryInput),
	}),
})
export type PackageInput = typeof PackageInput.Type
export const Provenance = Schema.Struct({
	package: Manifest.PackageIdentity,
	entry: Schema.String,
	artifact: Artifact.Identity,
	operations: Schema.Array(Manifest.Operation),
})
export type Provenance = typeof Provenance.Type
export class PublicationError extends Schema.TaggedError<
	PublicationError,
	{ readonly brand: unique symbol }
>()("PublicationError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
const failure = (message: string, cause?: Cause.Cause<unknown>) =>
	PublicationError.make({ message, ...(cause === undefined ? {} : { cause }) })

/** Canonical JSON object order; array order remains significant. */
const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
	Array.isArray(value)
export const canonical = (value: Schema.Json): Schema.Json => {
	if (isJsonArray(value)) return Array.map(value, canonical)
	if (value !== null && typeof value === "object")
		return Record.fromEntries(
			Array.map(
				Array.sort(Record.keys<string, Schema.Json>(value), Order.String),
				(key) => [key, canonical(value[key]!)],
			),
		)
	return value
}
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
/** Associates declared operation identities with package bytes, without inspecting schemas. */
export const declarations = (
	contract: Contract.RunnerContract,
	source: Manifest.Source,
): ReadonlyArray<Manifest.Declaration> =>
	Array.map([...contract.inject, ...contract.provides], (service) => ({
		service,
		operations: Array.map(service.operations, (operation) => ({
			identity: Manifest.operationId(operation),
			package: source.package,
			artifact: source.artifact,
		})),
	}))

const readJson = Effect.fnUntraced(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	return yield* fs
		.readFileString(file)
		.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
				),
			),
		)
})
const importModule = (url: string) =>
	Effect.tryPromise({
		try: () => import(url),
		catch: (cause) => failure(`Cannot import ${url}`, Cause.die(cause)),
	}).pipe(Effect.uninterruptible)
const resolve = (directory: string, specifier: string) =>
	Effect.try({
		try: () =>
			createRequire(pathToFileURL(`${directory}/package.json`)).resolve(
				specifier,
			),
		catch: (cause) =>
			failure(
				`Cannot resolve ${specifier} from ${directory}; install the contract package with a Node default export`,
				Cause.die(cause),
			),
	})
const packageAt = Effect.fnUntraced(function* (filename: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const resolved = yield* fs.realPath(filename)
	for (
		let directory = path.dirname(resolved);
		;
		directory = path.dirname(directory)
	) {
		const file = path.join(directory, "package.json")
		if (yield* fs.exists(file)) {
			const identity = yield* readJson(file).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Manifest.PackageIdentity)),
			)
			const artifact = yield* Artifact.directoryIdentity(directory)
			return { directory, package: identity, artifact }
		}
		if (directory === path.dirname(directory))
			return yield* failure(`No package identity for ${filename}`)
	}
})

/** Imports built declarations only. The returned plugin is not activated. */
export const inspectEntry = Effect.fn("Publication.inspectEntry")(function* (
	directory: string,
	entry: EntryInput,
) {
	const path = yield* Path.Path
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.realPath(directory)
	const implementation = path.resolve(root, entry.implementation)
	const relative = path.relative(root, implementation)
	if (
		relative === "" ||
		String.startsWith("../")(relative) ||
		path.isAbsolute(relative)
	)
		return yield* failure("The implementation must stay inside its package")
	const module = yield* importModule(pathToFileURL(implementation).href)
	const plugin = yield* Effect.fromOption(Plugin.fromModule(module), () =>
		failure(`${implementation} exports no plugin`),
	)
	const contracts = yield* Effect.forEach(entry.contracts, (specifier) =>
		Effect.gen(function* () {
			const file = String.startsWith("file:")(specifier)
				? fileURLToPath(specifier)
				: yield* resolve(root, specifier)
			const owner = yield* packageAt(file)
			if (owner.directory === root)
				return yield* failure(
					"Publish contracts in a separate package; embedding a package's own directory digest in its manifest would change that digest",
				)
			const loaded = yield* importModule(pathToFileURL(file).href)
			const contract = yield* Effect.fromOption(
				Contract.fromModule(loaded),
				() => failure(`${specifier} exports no contract`),
			)
			return {
				contract,
				owner,
				declarations: declarations(contract, owner),
			}
		}),
	)
	const declared = Array.flatMap(contracts, (item) => item.declarations)
	const metadata = yield* Manifest.derive(plugin, declared)
	const conflicts = Manifest.conflicts([
		{ id: plugin.name, operations: metadata.operations },
	])
	if (conflicts.length > 0)
		return yield* failure(
			Array.join(
				Array.map(conflicts, (item) => item.message),
				"\n",
			),
		)
	return {
		plugin,
		declarations: declared,
		entry: { ...entry, ...metadata } satisfies Manifest.Entry,
	}
})

/** Generates the graft field, retaining author-owned deployment declarations. */
export const generate = Effect.fn("Publication.generate")(function* (
	directory: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const raw = yield* readJson(path.join(directory, "package.json"))
	const input = yield* Schema.decodeUnknownEffect(PackageInput)(raw)
	const entries = yield* Effect.forEach(
		Record.toEntries(input.graft.entries),
		Effect.fnUntraced(function* ([name, entry]) {
			if (name !== "." && !String.startsWith("./")(name))
				return yield* failure(
					`Invalid public entry ${name}; use . or ./subpath`,
				)
			const exported = yield* resolve(
				path.resolve(directory),
				input.name + (name === "." ? "" : String.slice(1)(name)),
			)
			if (
				(yield* fs.realPath(exported)) !==
				(yield* fs.realPath(path.resolve(directory, entry.implementation)))
			)
				return yield* failure(
					`Public export ${name} does not select ${entry.implementation}`,
				)
			const result = yield* inspectEntry(directory, entry)
			return [name, result.entry] as const
		}),
	)
	return {
		...input,
		graft: { version: 1 as const, entries: Record.fromEntries(entries) },
	} satisfies Manifest.Package
})

/** Fails if a published manifest differs from the implementation declarations. */
export const verify = Effect.fn("Publication.verify")(function* (
	directory: string,
) {
	const path = yield* Path.Path
	const raw = yield* readJson(path.join(directory, "package.json"))
	const published = yield* Schema.decodeUnknownEffect(Manifest.Package)(raw)
	const generated = yield* generate(directory)
	if (
		(yield* json(canonical(published.graft))) !==
		(yield* json(canonical(generated.graft)))
	)
		return yield* failure(
			"Manifest/code disagreement; run graft remote manifest to regenerate the graft field",
		)
	return published
})

/** Writes only after every entry was successfully derived. */
export const write = Effect.fn("Publication.write")(function* (
	directory: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const generated = yield* generate(directory)
	const file = path.join(directory, "package.json")
	const raw = yield* readJson(file)
	yield* fs
		.writeFileString(
			file,
			(yield* json({ ...raw, graft: generated.graft })) + "\n",
		)
		.pipe(Effect.uninterruptible)
	return generated
})

/** Records a built resolved directory, without capturing external runtime dependencies. */
export const provenance = Effect.fn("Publication.provenance")(function* (
	directory: string,
	entry: string,
) {
	const path = yield* Path.Path
	const published = yield* readJson(path.join(directory, "package.json")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Manifest.Package)),
	)
	const selected = published.graft.entries[entry]
	if (selected === undefined)
		return yield* failure(`No manifest entry ${entry}`)
	const artifact = yield* Artifact.identify({
		directory,
		entry: selected.implementation,
	})
	const after = yield* readJson(path.join(directory, "package.json")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Manifest.Package)),
	)
	if ((yield* json(published)) !== (yield* json(after)))
		return yield* failure("Package metadata changed while recording provenance")
	return {
		package: { name: published.name, version: published.version },
		entry,
		artifact,
		operations: selected.operations,
	} satisfies Provenance
})

/** Writes provenance outside the recorded package so recording does not change its digest. */
export const record = Effect.fn("Publication.record")(function* (
	directory: string,
	output: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.realPath(directory)
	const parent = yield* fs.realPath(path.dirname(path.resolve(output)))
	const destination = (yield* fs.exists(output))
		? yield* fs.realPath(output)
		: path.join(parent, path.basename(output))
	const relative = path.relative(root, destination)
	if (!String.startsWith("../")(relative) && !path.isAbsolute(relative))
		return yield* failure(
			"The provenance file must be outside the package directory",
		)
	const pkg = yield* readJson(path.join(directory, "package.json")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Manifest.Package)),
	)
	const records = yield* Effect.forEach(
		Record.keys(pkg.graft.entries),
		(entry) => provenance(directory, entry),
	)
	yield* fs
		.writeFileString(output, (yield* json(records)) + "\n")
		.pipe(Effect.uninterruptible)
	return records
})
