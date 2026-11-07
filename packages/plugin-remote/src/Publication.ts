/** Explicit author tooling. Importing this module does not read or import packages. */

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

import { Manifest } from "@graftland/graft"

import * as Artifact from "./Artifact"
import type * as Contract from "./Contract"
import { EntryInput, PublicationError } from "./internal/publicationModel"
import { readJson, resolve } from "./internal/publicationPackage"
import { inspectFresh } from "./internal/publicationWorker"

export { EntryInput, PublicationError } from "./internal/publicationModel"

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

/** Inspects built declarations in a fresh, scoped module-loading environment. Never activates apply. */
export const inspectEntry = Effect.fn("Publication.inspectEntry")(function* (
	directory: string,
	entry: EntryInput,
) {
	return yield* inspectFresh(directory, entry)
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
			if (!Schema.is(Manifest.PublicEntry)(name))
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
			return [name, result] as const
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
	const selected = Manifest.getEntry(published.graft, entry)
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
